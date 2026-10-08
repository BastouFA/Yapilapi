import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import {
  MAX_SQUAD_MEMBERS,
  SQUAD_RULES,
  type MediaItem,
  type PublicUser,
  type Squad,
  type SquadCard,
  type SquadColor,
  type SquadMember,
  type SquadMemory,
  type SquadRole,
} from '@yapilapi/shared';
import { AppError, notFound } from './errors.ts';
import { activeControls } from './family.ts';
import { forfeitGamesOnLeave } from './chat-games.ts';
import { stopSharesOnJoin, stopSharesOnLeave } from './location.ts';
import { mediaSizesSql, withSmallVariants } from './data-saver.ts';
import { hydratePosts } from './posts.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { PUBLIC_USER_COLS, plusCol, publicUserFrom, toPublicUser, usersByIds, type PublicUserRow } from './users.ts';
import { notBlockedSql, postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Squads (docs/product/squads.md): small private groups of friends. A circle is an audience list
 * its owner keeps to themselves; a squad is a space its members share: posts, reels and stories
 * shared with it (visibility 'squad', posts.squad_id / moments.squad_id), a group chat whose
 * members follow the squad's, a weekly memory, and Pass the Mic chains of its own.
 *
 * Nobody outside a squad learns it exists: every read goes through squadMemberSql (in
 * visibility.ts, where postVisibleSql and storyVisibleSql use it too), and anything else answers
 * "not found". Invites need accepting. Who may be invited: people the inviter follows who follow
 * them back, or friends, who haven't blocked (or been blocked by) anyone in the squad, and with
 * whom everyone in it may be in a group chat: an adult and someone under 18 only when they're
 * friends (or family-linked), and a supervised teen's family settings for messages apply.
 */

export interface SquadDeps {
  db: Pool;
  realtime: RealtimeHub;
}

/** The cover photo, small sizes first, unless a check blocked it or marked it sensitive since. */
const COVER_SQL = (sq = 'sq') =>
  `(SELECT json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height, 'variants', m.variants,
                             'sizes', ${mediaSizesSql()}, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash)
    FROM media m WHERE m.id = ${sq}.cover_media_id AND m.moderation NOT IN ('blocked', 'sensitive'))`;

const coverOf = (r: { color: string; cover: MediaItem | null }) => ({
  color: r.color as SquadColor,
  photo: r.cover ? withSmallVariants(r.cover) : null,
});

/** Your place in a squad: your role and whether you've accepted. Not found for anyone not in it or invited to it. */
export async function membership(db: Q, squadId: string, userId: string): Promise<{ role: SquadRole; status: 'invited' | 'active' }> {
  const { rows } = await db.query(`SELECT role, status FROM squad_members WHERE squad_id = $1 AND user_id = $2`, [squadId, userId]);
  if (!rows[0]) throw notFound('Squad');
  return rows[0];
}

/** You, in a squad you've joined (not found otherwise), with your role. */
export async function activeMember(db: Q, squadId: string, userId: string): Promise<SquadRole> {
  const m = await membership(db, squadId, userId);
  if (m.status !== 'active') throw notFound('Squad');
  return m.role;
}

/** The squad's owner or an admin. */
export async function assertManager(db: Q, squadId: string, userId: string): Promise<SquadRole> {
  const role = await activeMember(db, squadId, userId);
  if (role === 'member') throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  return role;
}

const activeIds = async (db: Q, squadId: string): Promise<string[]> =>
  (await db.query<{ user_id: string }>(`SELECT user_id FROM squad_members WHERE squad_id = $1 AND status = 'active'`, [squadId])).rows.map((r) => r.user_id);

/** How many squads someone is in or invited to. */
const squadsOf = async (db: Q, userId: string): Promise<number> =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM squad_members WHERE user_id = $1`, [userId])).rows[0]!.n;

const tooManySquads = () => {
  const max = SQUAD_RULES.maxSquads;
  return new AppError(409, 'squad_limit', `You can be in up to ${max} squads.`);
};

/**
 * Why `newcomer` can't be in a squad with `members`: a block either way with any of them, an adult
 * and someone under 18 who aren't friends or family-linked, or a supervised teen's family settings
 * for messages (everyone in a squad is in its chat). Null when they can.
 */
async function clashWith(db: Q, newcomer: string, members: string[]): Promise<'blocked' | 'minor' | 'family' | null> {
  const others = members.filter((m) => m !== newcomer);
  if (!others.length) return null;
  const blocked = await db.query(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = ANY($2::uuid[])) OR (blocked_id = $1 AND blocker_id = ANY($2::uuid[])) LIMIT 1`,
    [newcomer, others],
  );
  if (blocked.rowCount) return 'blocked';
  // The group-chat rule (modules/messaging.ts, assertGroupSafe) between the newcomer and each member.
  const minor = await db.query(
    `WITH m AS (SELECT u.id, coalesce(u.birth_date > current_date - interval '18 years', false) AS minor FROM users u WHERE u.id = ANY($2::uuid[]) OR u.id = $1)
     SELECT 1 FROM m a JOIN m b ON a.minor AND NOT b.minor
     WHERE (a.id = $1 OR b.id = $1)
       AND NOT EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST(a.id, b.id) AND fr.user_b = GREATEST(a.id, b.id))
       AND NOT EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
                       AND ((fl.guardian_id = a.id AND fl.teen_id = b.id) OR (fl.guardian_id = b.id AND fl.teen_id = a.id)))
     LIMIT 1`,
    [newcomer, others],
  );
  if (minor.rowCount) return 'minor';
  // A supervised teen's "who can message" (friends or nobody), both ways; their guardians always can.
  const friendsOf = new Set(
    (
      await db.query<{ id: string }>(
        `SELECT CASE WHEN fr.user_a = $1 THEN fr.user_b ELSE fr.user_a END AS id FROM friendships fr WHERE fr.user_a = $1 OR fr.user_b = $1`,
        [newcomer],
      )
    ).rows.map((r) => r.id),
  );
  for (const [teen, peers] of [[newcomer, others], ...others.map((o) => [o, [newcomer]] as const)] as const) {
    const controls = await activeControls(db, teen);
    if (!controls) continue;
    for (const peer of peers) {
      if (controls.guardianIds.includes(peer)) continue;
      const friends = teen === newcomer ? friendsOf.has(peer) : friendsOf.has(teen);
      if (controls.messagesFrom === 'nobody' || !friends) return 'family';
    }
  }
  return null;
}

/**
 * Check `userIds` may be invited by `inviterId` to a squad whose members (joined) are `members`,
 * refusing the whole invite with the first reason. People already in or invited are left out.
 */
export async function assertInvitable(db: Q, inviterId: string, userIds: string[], members: string[]): Promise<void> {
  const { rows } = await db.query<{ id: string; known: boolean; connected: boolean }>(
    `SELECT x.id, (u.id IS NOT NULL) AS known,
            (EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = x.id) OR (fr.user_b = $1 AND fr.user_a = x.id))
             OR (EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = $1 AND f1.followee_id = x.id)
                 AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = x.id AND f2.followee_id = $1))) AS connected
     FROM unnest($2::uuid[]) AS x(id) LEFT JOIN users u ON u.id = x.id AND u.status = 'active'`,
    [inviterId, userIds],
  );
  for (const r of rows) {
    if (!r.known) throw notFound('That person');
    if (!r.connected) throw new AppError(403, 'squad_invite_not_allowed', 'You can invite people you follow who follow you back, and your friends.');
    const clash = await clashWith(db, r.id, members);
    if (clash === 'blocked') throw new AppError(403, 'blocked_in_group', 'Someone you’re adding can’t be in this group with someone already in it.');
    if (clash === 'minor')
      throw new AppError(
        403,
        'minor_protection',
        'To keep younger people safe, adults and people under 18 can be in a group together only when they are friends.',
      );
    if (clash === 'family') throw new AppError(403, 'family_controls', 'Family settings on this account limit who it can message.');
  }
}

/** A line in the squad's chat about who is in it (the same lines a group chat has), and everyone's chat list follows. */
async function chatLine(c: Q, realtime: RealtimeHub, conversationId: string, senderId: string, meta: Record<string, unknown>): Promise<void> {
  await c.query(`INSERT INTO messages (conversation_id, sender_id, body, kind, meta) VALUES ($1,$2,'','system',$3)`, [
    conversationId,
    senderId,
    { type: 'group', ...meta },
  ]);
  await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
  const { rows } = await c.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [
    conversationId,
  ]);
  await realtime.publish(
    rows.map((r) => r.user_id),
    { type: 'conversation.changed', data: { id: conversationId } },
  );
}

const namesOf = async (db: Q, ids: string[]) => {
  const users = await usersByIds(db, ids);
  return ids.flatMap((id) => (users.get(id) ? [{ id, displayName: users.get(id)!.displayName }] : []));
};

const conversationOf = async (db: Q, squadId: string): Promise<string | null> =>
  (await db.query<{ conversation_id: string | null }>(`SELECT conversation_id FROM squads WHERE id = $1`, [squadId])).rows[0]?.conversation_id ?? null;

/** Owner and admins are the chat's admins; everyone else in it is a member. */
const chatRole = (role: SquadRole) => (role === 'member' ? 'member' : 'admin');

/** Tell people they were invited (each once per invite). */
async function tellInvited(deps: SquadDeps, squadId: string, inviterId: string, userIds: string[]): Promise<void> {
  const { rows } = await deps.db.query<{ name: string }>(`SELECT name FROM squads WHERE id = $1`, [squadId]);
  for (const userId of userIds)
    await notify(deps.db, deps.realtime, {
      userId,
      category: 'friends',
      type: 'squad_invite',
      actorId: inviterId,
      entityType: 'squad',
      entityId: squadId,
      data: { name: rows[0]?.name ?? '' },
    });
}

/** A cover photo you may use: one of your own processed photos, never blocked or sensitive. */
async function assertCover(db: Q, userId: string, mediaId: string): Promise<void> {
  const ok = await db.query(
    `SELECT 1 FROM media WHERE id = $1 AND owner_id = $2 AND kind = 'image' AND NOT private AND moderation NOT IN ('blocked', 'sensitive')`,
    [mediaId, userId],
  );
  if (!ok.rowCount) throw notFound('That photo or video');
}

/**
 * Make a squad: its owner, the people invited (who each accept or decline) and its chat, an
 * ordinary group conversation that follows who is in the squad. Returns its id.
 */
export async function createSquad(
  deps: SquadDeps,
  c: PoolClient,
  ownerId: string,
  input: { name: string; color: SquadColor; coverMediaId?: string; userIds: string[] },
): Promise<{ id: string; invited: string[] }> {
  if ((await squadsOf(c, ownerId)) >= SQUAD_RULES.maxSquads) throw tooManySquads();
  if (input.coverMediaId) await assertCover(c, ownerId, input.coverMediaId);
  const invited = [...new Set(input.userIds)].filter((id) => id !== ownerId);
  await assertInvitable(c, ownerId, invited, [ownerId]);
  const { rows } = await c.query<{ id: string }>(`INSERT INTO squads (owner_id, name, color, cover_media_id) VALUES ($1,$2,$3,$4) RETURNING id`, [
    ownerId,
    input.name,
    input.color,
    input.coverMediaId ?? null,
  ]);
  const id = rows[0]!.id;
  await c.query(`INSERT INTO squad_members (squad_id, user_id, role, status, joined_at) VALUES ($1,$2,'owner','active',now())`, [id, ownerId]);
  await c.query(`INSERT INTO squad_members (squad_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3`, [id, invited, ownerId]);
  const conv = await c.query<{ id: string }>(`INSERT INTO conversations (kind, title, created_by) VALUES ('group',$1,$2) RETURNING id`, [input.name, ownerId]);
  await c.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')`, [conv.rows[0]!.id, ownerId]);
  await c.query(`UPDATE squads SET conversation_id = $2 WHERE id = $1`, [id, conv.rows[0]!.id]);
  return { id, invited };
}

export const announceCreated = (deps: SquadDeps, id: string, ownerId: string, invited: string[]) => tellInvited(deps, id, ownerId, invited);

/** Invite more people (any member can): the squad never goes over MAX_SQUAD_MEMBERS, invites included. Returns who was invited. */
export async function inviteToSquad(deps: SquadDeps, c: PoolClient, squadId: string, inviterId: string, userIds: string[]): Promise<string[]> {
  await c.query(`SELECT 1 FROM squads WHERE id = $1 FOR UPDATE`, [squadId]);
  await activeMember(c, squadId, inviterId);
  const existing = new Set((await c.query<{ user_id: string }>(`SELECT user_id FROM squad_members WHERE squad_id = $1`, [squadId])).rows.map((r) => r.user_id));
  const adding = [...new Set(userIds)].filter((id) => !existing.has(id));
  if (!adding.length) return [];
  const max = MAX_SQUAD_MEMBERS;
  if (existing.size + adding.length > max) throw new AppError(409, 'squad_full', `A squad can have up to ${max} people.`);
  await assertInvitable(c, inviterId, adding, await activeIds(c, squadId));
  await c.query(`INSERT INTO squad_members (squad_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3`, [squadId, adding, inviterId]);
  return adding;
}

export const announceInvited = (deps: SquadDeps, squadId: string, inviterId: string, userIds: string[]) => tellInvited(deps, squadId, inviterId, userIds);

/**
 * Accept an invite: checked again against who is in the squad now (blocks, minor protection,
 * family settings), then you're in, and in its chat. Members are told.
 */
export async function acceptInvite(deps: SquadDeps, squadId: string, userId: string): Promise<void> {
  const { db, realtime } = deps;
  const joined = await tx(db, async (c) => {
    await c.query(`SELECT 1 FROM squads WHERE id = $1 FOR UPDATE`, [squadId]);
    const m = await membership(c, squadId, userId);
    if (m.status === 'active') return null;
    const active = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM squad_members WHERE user_id = $1 AND status = 'active'`, [userId])).rows[0]!.n;
    if (active >= SQUAD_RULES.maxSquads) throw tooManySquads();
    if (await clashWith(c, userId, await activeIds(c, squadId))) throw new AppError(403, 'squad_not_allowed', 'You can’t join this squad now.');
    const row = (
      await c.query<{ invited_by: string | null }>(
        `UPDATE squad_members SET status = 'active', joined_at = now() WHERE squad_id = $1 AND user_id = $2 RETURNING invited_by`,
        [squadId, userId],
      )
    ).rows[0]!;
    const conv = await conversationOf(c, squadId);
    if (conv)
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member')
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'member', last_read_at = now()`,
        [conv, userId],
      );
    return { conv, by: row.invited_by };
  });
  if (!joined) return;
  // The invite is answered.
  await db.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'squad_invite' AND entity_id = $2`, [userId, squadId]);
  if (joined.conv) {
    await stopSharesOnJoin({ db, realtime }, joined.conv);
    await realtime.publish([userId], { type: 'conversation.created', data: { id: joined.conv } });
    const sender = joined.by && (await activeIds(db, squadId)).includes(joined.by) ? joined.by : userId;
    await chatLine(db, realtime, joined.conv, sender, { action: 'added', people: await namesOf(db, [userId]) });
  }
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM squads WHERE id = $1`, [squadId]);
  for (const other of await activeIds(db, squadId))
    await notify(db, realtime, {
      userId: other,
      category: 'friends',
      type: 'squad_joined',
      actorId: userId,
      entityType: 'squad',
      entityId: squadId,
      data: { name: rows[0]?.name ?? '' },
    });
}

/**
 * Someone is no longer in a squad (they left, were removed, declined or their account went): out of
 * its chat, with a line, and its notifications go from their list. Call after deleting their row.
 */
async function wentOut(deps: SquadDeps, squadId: string, userId: string, line: { senderId: string; action: 'left' | 'removed' } | null): Promise<void> {
  const { db, realtime } = deps;
  await db.query(`DELETE FROM notifications WHERE user_id = $1 AND entity_type = 'squad' AND entity_id = $2`, [userId, squadId]);
  const conv = await conversationOf(db, squadId);
  if (!conv) return;
  const r = await db.query(`UPDATE conversation_members SET left_at = now(), role = 'member' WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [
    conv,
    userId,
  ]);
  if (!r.rowCount) return;
  await stopSharesOnLeave({ db, realtime }, conv, userId);
  await forfeitGamesOnLeave({ db, realtime }, conv, userId);
  await realtime.publish([userId], { type: 'conversation.removed', data: { id: conv } });
  if (line)
    await chatLine(db, realtime, conv, line.senderId, {
      action: line.action,
      ...(line.action === 'removed' ? { people: await namesOf(db, [userId]) } : {}),
    });
}

/** Decline an invite (it's simply gone; nobody is told). */
export async function declineInvite(deps: SquadDeps, squadId: string, userId: string): Promise<void> {
  const r = await deps.db.query(`DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND status = 'invited'`, [squadId, userId]);
  if (!r.rowCount) throw notFound('Squad');
  await deps.db.query(`DELETE FROM notifications WHERE user_id = $1 AND entity_type = 'squad' AND entity_id = $2`, [userId, squadId]);
}

/** Leave a squad. The owner hands it on first (or deletes it). What you shared stays with the squad. */
export async function leaveSquad(deps: SquadDeps, squadId: string, userId: string): Promise<void> {
  const m = await membership(deps.db, squadId, userId);
  if (m.status === 'invited') return declineInvite(deps, squadId, userId);
  if (m.role === 'owner') throw new AppError(409, 'squad_owner', 'Make someone else the owner before you leave.');
  await deps.db.query(`DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2`, [squadId, userId]);
  await wentOut(deps, squadId, userId, { senderId: userId, action: 'left' });
}

/**
 * Take someone out (the owner, or an admin for members), or take back an invite. They aren't told,
 * as in a group chat: the squad is simply gone for them.
 */
export async function removeFromSquad(deps: SquadDeps, squadId: string, actorId: string, userId: string): Promise<void> {
  const actor = await assertManager(deps.db, squadId, actorId);
  if (userId === actorId) return leaveSquad(deps, squadId, userId);
  const target = await membership(deps.db, squadId, userId).catch(() => {
    throw notFound('That person');
  });
  if (target.role === 'owner' || (actor === 'admin' && target.role === 'admin')) throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  await deps.db.query(`DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2`, [squadId, userId]);
  if (target.status === 'invited') {
    await deps.db.query(`DELETE FROM notifications WHERE user_id = $1 AND entity_type = 'squad' AND entity_id = $2`, [userId, squadId]);
    return;
  }
  await wentOut(deps, squadId, userId, { senderId: actorId, action: 'removed' });
}

/** The owner makes a member an admin, or a member again. The chat's admins follow. */
export async function setSquadRole(deps: SquadDeps, squadId: string, ownerId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
  if ((await activeMember(deps.db, squadId, ownerId)) !== 'owner') throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  const r = await deps.db.query<{ role: string }>(
    `UPDATE squad_members SET role = $3 WHERE squad_id = $1 AND user_id = $2 AND status = 'active' AND role <> 'owner' AND role <> $3 RETURNING role`,
    [squadId, userId, role],
  );
  if (!r.rowCount) {
    await activeMember(deps.db, squadId, userId).catch(() => {
      throw notFound('That person');
    });
    return;
  }
  const conv = await conversationOf(deps.db, squadId);
  if (!conv) return;
  await deps.db.query(`UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2`, [conv, userId, chatRole(role)]);
  await chatLine(deps.db, deps.realtime, conv, ownerId, { action: role === 'admin' ? 'admin' : 'unadmin', people: await namesOf(deps.db, [userId]) });
}

/** The owner hands the squad to someone in it, and stays on as an admin. */
export async function transferSquad(deps: SquadDeps, squadId: string, ownerId: string, userId: string): Promise<void> {
  const { db } = deps;
  if ((await activeMember(db, squadId, ownerId)) !== 'owner') throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  const was = await activeMember(db, squadId, userId).catch(() => {
    throw notFound('That person');
  });
  if (userId === ownerId) return;
  await db.query(`UPDATE squad_members SET role = CASE WHEN user_id = $2 THEN 'owner' ELSE 'admin' END WHERE squad_id = $1 AND user_id IN ($2, $3)`, [
    squadId,
    userId,
    ownerId,
  ]);
  await db.query(`UPDATE squads SET owner_id = $2 WHERE id = $1`, [squadId, userId]);
  const conv = await conversationOf(db, squadId);
  if (!conv) return;
  await db.query(`UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id IN ($2, $3)`, [conv, userId, ownerId]);
  if (was === 'member') await chatLine(db, deps.realtime, conv, ownerId, { action: 'admin', people: await namesOf(db, [userId]) });
}

/** Rename it or change its cover (owner and admins). A new name renames the chat too. */
export async function editSquad(
  deps: SquadDeps,
  squadId: string,
  userId: string,
  input: { name?: string; color?: SquadColor; coverMediaId?: string | null },
): Promise<void> {
  const { db } = deps;
  await assertManager(db, squadId, userId);
  if (input.coverMediaId) await assertCover(db, userId, input.coverMediaId);
  const before = (await db.query<{ name: string }>(`SELECT name FROM squads WHERE id = $1`, [squadId])).rows[0]!;
  await db.query(
    `UPDATE squads SET name = coalesce($2, name), color = coalesce($3, color),
                       cover_media_id = CASE WHEN $4::boolean THEN $5::uuid ELSE cover_media_id END
     WHERE id = $1`,
    [squadId, input.name ?? null, input.color ?? null, input.coverMediaId !== undefined, input.coverMediaId ?? null],
  );
  if (input.name && input.name !== before.name) {
    const conv = await conversationOf(db, squadId);
    if (conv) {
      await db.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [conv, input.name]);
      await chatLine(db, deps.realtime, conv, userId, { action: 'renamed', title: input.name });
    }
  }
}

/**
 * Delete a squad (its owner). What was shared with it stays with the people who shared it, seen by
 * them alone (as when a circle is deleted); its chains go (their reels stay with their authors). Its
 * chat stays an ordinary group for the people in it, who can leave it as usual.
 */
export async function deleteSquad(deps: SquadDeps, squadId: string, userId: string): Promise<void> {
  const { db, realtime } = deps;
  if ((await activeMember(db, squadId, userId)) !== 'owner') throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  const conv = await conversationOf(db, squadId);
  const people = (await db.query<{ user_id: string }>(`SELECT user_id FROM squad_members WHERE squad_id = $1`, [squadId])).rows.map((r) => r.user_id);
  await db.query(`DELETE FROM squads WHERE id = $1`, [squadId]);
  await db.query(`DELETE FROM notifications WHERE entity_type = 'squad' AND entity_id = $1`, [squadId]);
  if (conv) await realtime.publish(people, { type: 'conversation.changed', data: { id: conv } });
}

/**
 * An account being deleted leaves its squads. A squad it owned goes to its longest-standing admin
 * (or member); a squad with nobody else in it is deleted.
 */
export async function leaveSquadsOnDeletion(deps: SquadDeps, userId: string): Promise<void> {
  const { db } = deps;
  const { rows } = await db.query<{ squad_id: string; role: SquadRole; status: string }>(
    `SELECT squad_id, role, status FROM squad_members WHERE user_id = $1`,
    [userId],
  );
  for (const r of rows) {
    if (r.role === 'owner') {
      const next = await db.query<{ user_id: string }>(
        `SELECT sm.user_id FROM squad_members sm JOIN users u ON u.id = sm.user_id
         WHERE sm.squad_id = $1 AND sm.user_id <> $2 AND sm.status = 'active' AND u.status = 'active'
         ORDER BY (sm.role = 'admin') DESC, sm.joined_at LIMIT 1`,
        [r.squad_id, userId],
      );
      if (!next.rows[0]) {
        await db.query(`DELETE FROM squads WHERE id = $1`, [r.squad_id]);
        continue;
      }
      await transferSquad(deps, r.squad_id, userId, next.rows[0].user_id);
    }
    await db.query(`DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2`, [r.squad_id, userId]);
    if (r.status === 'active') await wentOut(deps, r.squad_id, userId, null);
  }
}

// ── Reading ────────────────────────────────────────────────────────────

const MEMBER_COLS = `sm.role, sm.status, sm.joined_at, ${PUBLIC_USER_COLS}`;

/** A squad, for someone in it or invited to it (not found for anyone else). */
export async function squadFor(db: Q, squadId: string, viewer: string): Promise<Squad> {
  const m = await membership(db, squadId, viewer);
  const { rows } = await db.query(
    `SELECT sq.id, sq.name, sq.color, sq.conversation_id, sq.created_at, ${COVER_SQL()} AS cover,
            (SELECT count(*)::int FROM squad_members x WHERE x.squad_id = sq.id) AS member_count,
            ib.user_id AS i_id, ib.username AS i_username, ib.display_name AS i_display_name, ib.avatar_url AS i_avatar_url, ib.mode AS i_mode, ${plusCol('i_', 'ib')}
     FROM squads sq LEFT JOIN squad_members me ON me.squad_id = sq.id AND me.user_id = $2 LEFT JOIN profiles ib ON ib.user_id = me.invited_by
     WHERE sq.id = $1`,
    [squadId, viewer],
  );
  const r = rows[0]!;
  // Members see who is in it and who is invited; someone invited sees who is in it. Blocked people (either way) are left out.
  const people = await db.query(
    `SELECT ${MEMBER_COLS} FROM squad_members sm JOIN profiles pr ON pr.user_id = sm.user_id JOIN users u ON u.id = sm.user_id
     WHERE sm.squad_id = $1 AND u.status = 'active' AND (sm.status = 'active' OR $3) AND (sm.user_id = $2 OR ${notBlockedSql('sm.user_id', '$2')})
     ORDER BY (sm.role = 'owner') DESC, (sm.role = 'admin') DESC, sm.status, sm.joined_at NULLS LAST, sm.invited_at`,
    [squadId, viewer, m.status === 'active'],
  );
  const members: SquadMember[] = people.rows.map((p) => ({
    user: toPublicUser(p as PublicUserRow),
    role: p.role,
    invited: p.status === 'invited',
    joinedAt: p.joined_at ? new Date(p.joined_at).toISOString() : null,
  }));
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    cover: coverOf(r),
    members,
    memberCount: r.member_count,
    conversationId: m.status === 'active' ? (r.conversation_id ?? null) : null,
    createdAt: new Date(r.created_at).toISOString(),
    memory: m.status === 'active' ? await currentMemory(db, squadId, viewer) : null,
    viewer: { role: m.status === 'active' ? m.role : null, invited: m.status === 'invited', invitedBy: r.i_id ? publicUserFrom(r, 'i_') : null },
  };
}

/** Your squads and the invites waiting for you: invites first, then the squads with something new. */
export async function squadCards(db: Q, viewer: string): Promise<SquadCard[]> {
  const { rows } = await db.query(
    `SELECT sq.id, sq.name, sq.color, ${COVER_SQL()} AS cover, me.role, me.status,
            (SELECT count(*)::int FROM squad_members x WHERE x.squad_id = sq.id) AS member_count,
            (SELECT coalesce(json_agg(json_build_object('id', fp.user_id, 'username', fp.username, 'displayName', fp.display_name, 'avatarUrl', fp.avatar_url, 'mode', fp.mode)
                                      ORDER BY f.joined_at), '[]')
               FROM (SELECT x.user_id, x.joined_at FROM squad_members x JOIN users xu ON xu.id = x.user_id
                     WHERE x.squad_id = sq.id AND x.status = 'active' AND xu.status = 'active' AND x.user_id <> $1 AND ${notBlockedSql('x.user_id', '$1')}
                     ORDER BY x.joined_at LIMIT 4) f JOIN profiles fp ON fp.user_id = f.user_id) AS faces,
            ib.user_id AS i_id, ib.username AS i_username, ib.display_name AS i_display_name, ib.avatar_url AS i_avatar_url, ib.mode AS i_mode, ${plusCol('i_', 'ib')},
            greatest(sq.created_at, (SELECT max(p.created_at) FROM posts p WHERE p.squad_id = sq.id AND p.visibility = 'squad' AND p.deleted_at IS NULL)) AS last_at
     FROM squad_members me JOIN squads sq ON sq.id = me.squad_id LEFT JOIN profiles ib ON ib.user_id = me.invited_by
     WHERE me.user_id = $1
     ORDER BY (me.status = 'invited') DESC, last_at DESC`,
    [viewer],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    cover: coverOf(r),
    memberCount: r.member_count,
    faces: r.faces as PublicUser[],
    role: r.status === 'active' ? r.role : null,
    invitedBy: r.status === 'invited' && r.i_id ? publicUserFrom(r, 'i_') : null,
  }));
}

/**
 * People you could invite: friends, and people you follow who follow you back, who aren't in the
 * squad or invited yet, matching `q` when given. Blocks with anyone in the squad and minor protection
 * leave people out here; everything is checked again when inviting.
 */
export async function inviteCandidates(db: Q, viewer: string, squadId: string | null, q: string | null, limit = 30): Promise<PublicUser[]> {
  const members = squadId ? await activeIds(db, squadId) : [viewer];
  const { rows } = await db.query<PublicUserRow>(
    `SELECT ${PUBLIC_USER_COLS} FROM profiles pr JOIN users u ON u.id = pr.user_id
     WHERE u.status = 'active' AND pr.user_id <> $1
       AND (EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = pr.user_id) OR (fr.user_b = $1 AND fr.user_a = pr.user_id))
            OR (EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = $1 AND f1.followee_id = pr.user_id)
                AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = pr.user_id AND f2.followee_id = $1)))
       AND ($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM squad_members x WHERE x.squad_id = $2 AND x.user_id = pr.user_id))
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = pr.user_id AND b.blocked_id = ANY($3::uuid[])) OR (b.blocked_id = pr.user_id AND b.blocker_id = ANY($3::uuid[])))
       AND NOT EXISTS (SELECT 1 FROM unnest($3::uuid[]) AS mm(id) JOIN users mu ON mu.id = mm.id
                       WHERE coalesce(mu.birth_date > current_date - interval '18 years', false) <> coalesce(u.birth_date > current_date - interval '18 years', false)
                         AND NOT EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST(mm.id, pr.user_id) AND fr.user_b = GREATEST(mm.id, pr.user_id)))
       AND ($4::text IS NULL OR pr.username ILIKE $4 || '%' OR pr.display_name ILIKE '%' || $4 || '%')
     ORDER BY pr.display_name LIMIT $5`,
    [viewer, squadId, members, q, limit],
  );
  return rows.map(toPublicUser);
}

/** The squad's posts and reels for a member, newest first (cursor: created_at and id). */
export async function squadPostIds(db: Q, squadId: string, viewer: string, limit: number, cursor: { t: string; id: string } | null) {
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `SELECT p.id, p.created_at FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.squad_id = $2 AND p.visibility = 'squad' AND ${postVisibleSql('$1')} ${cursor ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
     ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
    cursor ? [viewer, squadId, limit + 1, cursor.t, cursor.id] : [viewer, squadId, limit + 1],
  );
  return rows;
}

/** Check a post, story or chain may go to this squad: the author is in it. */
export async function assertCanShare(db: Q, squadId: string | null | undefined, userId: string): Promise<string> {
  if (!squadId) throw notFound('Squad');
  await activeMember(db, squadId, userId);
  return squadId;
}

/**
 * A post went out to a squad: everyone else in it hears, batched per squad while unread ("Ada and 2
 * others shared in Crew"), following their settings, pauses and quiet hours (notify).
 */
export async function announceSquadPost(deps: SquadDeps, postId: string, authorId: string): Promise<void> {
  const { db, realtime } = deps;
  const { rows } = await db.query<{ squad_id: string; name: string }>(
    `SELECT sq.id AS squad_id, sq.name FROM posts p JOIN squads sq ON sq.id = p.squad_id WHERE p.id = $1 AND p.visibility = 'squad'`,
    [postId],
  );
  const sq = rows[0];
  if (!sq) return;
  const members = await db.query<{ user_id: string }>(
    `SELECT sm.user_id FROM squad_members sm WHERE sm.squad_id = $1 AND sm.status = 'active' AND sm.user_id <> $2
       AND EXISTS (SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id WHERE p.id = $3 AND ${postVisibleSql('sm.user_id')})`,
    [sq.squad_id, authorId, postId],
  );
  for (const m of members.rows)
    await notify(db, realtime, {
      userId: m.user_id,
      category: 'friends',
      type: 'squad_post',
      actorId: authorId,
      entityType: 'squad',
      entityId: sq.squad_id,
      data: { name: sq.name, postId },
      group: sq.squad_id,
    });
}

// ── Weekly memory ──────────────────────────────────────────────────────

/** The Monday (UTC) a week starts on, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

/**
 * Make last week's memories: for each squad that shared something from Monday to Sunday (UTC) and
 * has no memory for that week yet, a "Your squad's week" card (counts, who shared, the top moments)
 * and one notification for each member. A quiet week makes nothing. Safe to run on every instance:
 * a week's memory is made once. Returns how many were made.
 */
export async function sweepSquadMemories(deps: SquadDeps, opts: { now?: Date; limit?: number } = {}): Promise<number> {
  const { db, realtime } = deps;
  const now = opts.now ?? new Date();
  const thisWeek = weekStartOf(now);
  const lastWeek = weekStartOf(new Date(Date.parse(`${thisWeek}T00:00:00Z`) - 86_400_000));
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT sq.id, sq.name FROM squads sq
     WHERE NOT EXISTS (SELECT 1 FROM squad_memories sm WHERE sm.squad_id = sq.id AND sm.week_start = $1::date)
       AND EXISTS (SELECT 1 FROM posts p WHERE p.squad_id = sq.id AND p.visibility = 'squad' AND p.deleted_at IS NULL AND p.status = 'published'
                   AND p.moderation_status = 'normal' AND p.created_at >= $1::date AND p.created_at < $2::date)
     LIMIT $3`,
    [lastWeek, thisWeek, opts.limit ?? 200],
  );
  let made = 0;
  for (const sq of rows) {
    const live = `p.squad_id = $1 AND p.visibility = 'squad' AND p.deleted_at IS NULL AND p.status = 'published' AND p.moderation_status = 'normal'
                  AND p.created_at >= $2::date AND p.created_at < $3::date`;
    const counts = (
      await db.query(
        `SELECT count(*) FILTER (WHERE p.format <> 'reel')::int AS posts, count(*) FILTER (WHERE p.format = 'reel')::int AS reels,
                coalesce(array_agg(DISTINCT p.author_id), '{}') AS people,
                (SELECT count(*)::int FROM moments m WHERE m.squad_id = $1 AND m.visibility = 'squad' AND m.created_at >= $2::date AND m.created_at < $3::date
                   AND m.moderation_status = 'normal') AS stories
         FROM posts p WHERE ${live}`,
        [sq.id, lastWeek, thisWeek],
      )
    ).rows[0];
    const top = (
      await db.query<{ id: string }>(`SELECT p.id FROM posts p WHERE ${live} ORDER BY (p.like_count + 2 * p.comment_count) DESC, p.created_at DESC LIMIT $4`, [
        sq.id,
        lastWeek,
        thisWeek,
        SQUAD_RULES.memoryTop,
      ])
    ).rows.map((r) => r.id);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO squad_memories (squad_id, week_start, summary) VALUES ($1, $2::date, $3) ON CONFLICT (squad_id, week_start) DO NOTHING RETURNING id`,
      [sq.id, lastWeek, { posts: counts.posts, reels: counts.reels, stories: counts.stories, people: counts.people, top }],
    );
    const id = ins.rows[0]?.id;
    if (!id) continue;
    made++;
    for (const member of await activeIds(db, sq.id))
      await notify(db, realtime, {
        userId: member,
        category: 'friends',
        type: 'squad_memory',
        entityType: 'squad',
        entityId: sq.id,
        data: { name: sq.name, memoryId: id, weekStart: lastWeek },
      });
  }
  return made;
}

/** The memory made this week (about last week), pinned on the squad page until the next one. */
async function currentMemory(db: Q, squadId: string, viewer: string): Promise<SquadMemory | null> {
  const { rows } = await db.query(
    `SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, to_char(week_start + 6, 'YYYY-MM-DD') AS week_end, summary
     FROM squad_memories WHERE squad_id = $1 AND week_start >= $2::date ORDER BY week_start DESC LIMIT 1`,
    [squadId, weekStartOf(new Date(Date.now() - 7 * 86_400_000))],
  );
  const r = rows[0];
  if (!r) return null;
  return memoryOut(db, r, viewer);
}

/** A memory read back now: top posts the viewer can still see, and the people who shared, minus anyone blocked either way. */
async function memoryOut(db: Q, r: Record<string, any>, viewer: string): Promise<SquadMemory> {
  const s = r.summary as { posts: number; reels: number; stories: number; people: string[]; top: string[] };
  const visible = s.top.length
    ? (
        await db.query<{ id: string }>(
          `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
           WHERE p.id = ANY($2::uuid[]) AND ${postVisibleSql('$1')}`,
          [viewer, s.top],
        )
      ).rows.map((x) => x.id)
    : [];
  const people = s.people.length
    ? (
        await db.query<PublicUserRow>(
          `SELECT ${PUBLIC_USER_COLS} FROM profiles pr JOIN users u ON u.id = pr.user_id
           WHERE pr.user_id = ANY($2::uuid[]) AND u.status = 'active' AND (pr.user_id = $1 OR ${notBlockedSql('pr.user_id', '$1')})`,
          [viewer, s.people],
        )
      ).rows.map(toPublicUser)
    : [];
  return {
    id: r.id,
    weekStart: r.week_start,
    weekEnd: r.week_end,
    counts: { posts: s.posts, reels: s.reels, stories: s.stories, people: s.people.length },
    people,
    top: await hydratePosts(
      db,
      s.top.filter((id) => visible.includes(id)),
      viewer,
    ),
  };
}

/** A squad member reads one of its memories (not found for anyone else). */
export async function memoryFor(db: Q, squadId: string, memoryId: string, viewer: string): Promise<SquadMemory> {
  await activeMember(db, squadId, viewer);
  const { rows } = await db.query(
    `SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, to_char(week_start + 6, 'YYYY-MM-DD') AS week_end, summary
     FROM squad_memories WHERE squad_id = $1 AND id = $2`,
    [squadId, memoryId],
  );
  if (!rows[0]) throw notFound('Squad');
  return memoryOut(db, rows[0], viewer);
}
