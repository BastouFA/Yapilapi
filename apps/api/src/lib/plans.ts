import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import {
  PLAN_RULES,
  planDebts,
  owedBy,
  splitEvenly,
  type FreeFriend,
  type FreeNow,
  type Plan,
  type PlanAnswer,
  type PlanCard,
  type PlanCosts,
  type PlanCounts,
  type PlanPersonAnswer,
  type PlanPlace,
  type PlanPlaceKind,
  type PublicUser,
} from '@yapilapi/shared';
import { forfeitGamesOnLeave } from './chat-games.ts';
import { AppError, badRequest, notFound } from './errors.ts';
import { activeControls } from './family.ts';
import { stopSharesOnJoin, stopSharesOnLeave } from './location.ts';
import { analyzeText } from './moderation.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { chatLine, clashWith } from './squads.ts';
import { stashVisibleSql } from './stash.ts';
import { PUBLIC_USER_COLS, toPublicUser, usersByIds, type PublicUserRow } from './users.ts';
import { eventVisibleSql, notBlockedSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Go out together (docs/product/go-out-together.md): "I'm free", plans with friends, their group
 * chat, and a cost split that only keeps count.
 *
 * A plan is a row of `plans` with a time (`starts_at`; rows without one are a chat's older
 * structured plans). Everyone in it has a `plan_people` row with their answer. Its chat is an
 * ordinary group conversation (`plans.conversation_id`) whose members follow the answers: the
 * maker and everyone who said I'm in or Maybe are in it; people invited who haven't answered aren't
 * yet, and answering Can't takes you out. The chat's own add, remove, rename and leave are refused
 * while the plan is on (modules/messaging.ts, `plan_chat`); polls in it are ordinary chat polls.
 *
 * Who can be invited: the inviter's friends (or, for a squad, its members), and only people who may
 * be in a group chat with everyone already in the plan: no block either way, an adult and someone
 * under 18 only when they are friends or family-linked, and a supervised teen's family settings for
 * messages (the squads rule, lib/squads.ts clashWith). Anyone outside a plan gets "not found".
 */

export interface PlanDeps {
  db: Pool;
  realtime: RealtimeHub;
}

const planGone = () => notFound('Plan');
const cancelledError = () => new AppError(409, 'plan_cancelled', 'This plan was cancelled.');
const riskyWords = () => new AppError(422, 'content_blocked', "This wasn't sent because it may put someone at risk.");

/** Words people put in a plan (its title, details, place, an expense, "I'm free"), checked like a message. */
function assertWords(...texts: (string | null | undefined)[]): void {
  if (texts.some((x) => x && analyzeText(x).risk === 'escalate')) throw riskyWords();
}

interface PlanRow {
  id: string;
  title: string;
  note: string;
  starts_at: Date;
  status: string;
  created_by: string;
  conversation_id: string | null;
  place_kind: PlanPlaceKind | null;
  place_id: string | null;
  place_name: string | null;
  squad_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const PLAN_COLS = `p.id, p.title, p.note, p.starts_at, p.status, p.created_by, p.conversation_id, p.place_kind, p.place_id, p.place_name, p.squad_id, p.created_at, p.updated_at`;

async function planRow(db: Q, planId: string, lock = false): Promise<PlanRow> {
  const { rows } = await db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans p WHERE p.id = $1 AND p.starts_at IS NOT NULL ${lock ? 'FOR UPDATE' : ''}`, [
    planId,
  ]);
  if (!rows[0]) throw planGone();
  return rows[0];
}

/** Your answer in a plan; not found for anyone not in it. */
export async function answerOf(db: Q, planId: string, userId: string): Promise<PlanPersonAnswer> {
  const { rows } = await db.query<{ answer: PlanPersonAnswer }>(`SELECT answer FROM plan_people WHERE plan_id = $1 AND user_id = $2`, [planId, userId]);
  if (!rows[0]) throw planGone();
  return rows[0].answer;
}

const inChat = (a: PlanPersonAnswer) => a === 'in' || a === 'maybe';

/** Everyone who is (or will be, once they answer) in the plan's chat: all but those who said Can't. */
const possibleMembers = async (db: Q, planId: string): Promise<string[]> =>
  (await db.query<{ user_id: string }>(`SELECT user_id FROM plan_people WHERE plan_id = $1 AND answer <> 'cant'`, [planId])).rows.map((r) => r.user_id);

const chatMembers = async (db: Q, conversationId: string): Promise<string[]> =>
  (await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [conversationId])).rows.map(
    (r) => r.user_id,
  );

const namesOf = async (db: Q, ids: string[]) => {
  const users = await usersByIds(db, ids);
  return ids.flatMap((id) => (users.get(id) ? [{ id, displayName: users.get(id)!.displayName }] : []));
};

function clashError(clash: 'blocked' | 'minor' | 'family'): AppError {
  if (clash === 'blocked') return new AppError(403, 'blocked_in_group', 'Someone you’re adding can’t be in this group with someone already in it.');
  if (clash === 'minor')
    return new AppError(
      403,
      'minor_protection',
      'To keep younger people safe, adults and people under 18 can be in a group together only when they are friends.',
    );
  return new AppError(403, 'family_controls', 'Family settings on this account limit who it can message.');
}

/** The place as given, checked: a place page that's up, an event or a stash the person can see, or words. */
async function resolvePlace(
  db: Q,
  userId: string,
  place: { kind: PlanPlaceKind; id?: string; name?: string } | null | undefined,
): Promise<{ kind: PlanPlaceKind; id: string | null; name: string | null } | null> {
  if (!place) return null;
  if (place.kind === 'text') {
    assertWords(place.name);
    return { kind: 'text', id: null, name: place.name ?? null };
  }
  const sql =
    place.kind === 'place'
      ? `SELECT name FROM places WHERE id = $1 AND deleted_at IS NULL AND $2::uuid IS NOT NULL`
      : place.kind === 'event'
        ? `SELECT e.title AS name FROM events e WHERE e.id = $1 AND ${eventVisibleSql('$2::uuid')}`
        : `SELECT s.title AS name FROM stashes s WHERE s.id = $1 AND ${stashVisibleSql('$2::uuid')}`;
  const { rows } = await db.query<{ name: string | null }>(sql, [place.id, userId]);
  if (!rows[0]) throw notFound(place.kind === 'place' ? 'Place' : place.kind === 'event' ? 'Event' : 'That stash');
  return { kind: place.kind, id: place.id!, name: rows[0].name };
}

function assertWhen(startsAt: string): Date {
  const d = new Date(startsAt);
  const now = Date.now();
  if (Number.isNaN(d.getTime()) || d.getTime() < now - 60 * 60_000 || d.getTime() > now + PLAN_RULES.aheadDays * 86_400_000)
    throw new AppError(400, 'plan_time', 'Choose a time from now to 90 days ahead.');
  return d;
}

/**
 * The people a plan invite reaches: `userIds` must be the inviter's friends (the whole invite is
 * refused otherwise); a squad the inviter is in adds its members, leaving out anyone who couldn't be
 * in the chat with the others. Everyone is checked against the people in the plan (`members`).
 */
async function invitees(db: Q, inviterId: string, input: { userIds: string[]; squadId?: string }, members: string[]): Promise<string[]> {
  const already = new Set(members);
  const direct = [...new Set(input.userIds)].filter((id) => id !== inviterId && !already.has(id));
  if (direct.length) {
    const { rows } = await db.query<{ id: string; known: boolean; friend: boolean }>(
      `SELECT x.id, (u.id IS NOT NULL) AS known,
              EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST($1::uuid, x.id) AND fr.user_b = GREATEST($1::uuid, x.id)) AS friend
       FROM unnest($2::uuid[]) AS x(id) LEFT JOIN users u ON u.id = x.id AND u.status = 'active'`,
      [inviterId, direct],
    );
    for (const r of rows) {
      if (!r.known) throw notFound('That person');
      if (!r.friend) throw new AppError(403, 'plan_invite_not_allowed', 'You can invite your friends to a plan.');
    }
  }
  const group = [...members];
  for (const id of direct) {
    const clash = await clashWith(db, id, group);
    if (clash) throw clashError(clash);
    group.push(id);
  }
  if (input.squadId) {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT sm.user_id FROM squad_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.squad_id = $1 AND sm.status = 'active' AND u.status = 'active'
         AND EXISTS (SELECT 1 FROM squad_members me WHERE me.squad_id = $1 AND me.user_id = $2 AND me.status = 'active')
       ORDER BY sm.joined_at`,
      [input.squadId, inviterId],
    );
    if (!rows.length) throw notFound('Squad');
    for (const r of rows) {
      if (group.includes(r.user_id)) continue;
      // Squad members who couldn't be in this chat with the others (a block since, say) are left out.
      if (await clashWith(db, r.user_id, group)) continue;
      group.push(r.user_id);
    }
  }
  const adding = group.filter((id) => !already.has(id));
  if (members.length + adding.length > PLAN_RULES.maxPeople) throw new AppError(409, 'plan_full', 'A plan can have up to 30 people.');
  return adding;
}

async function tellInvited(deps: PlanDeps, planId: string, inviterId: string, userIds: string[]): Promise<void> {
  const p = await planRow(deps.db, planId);
  for (const userId of userIds)
    await notify(deps.db, deps.realtime, {
      userId,
      category: 'friends',
      type: 'plan_invite',
      actorId: inviterId,
      entityType: 'plan',
      entityId: planId,
      data: { title: p.title, startsAt: p.starts_at.toISOString() },
    });
}

/** Everyone in a plan hears it changed, in its chat and on their plan page. */
async function publishChanged(deps: PlanDeps, planId: string): Promise<void> {
  const { rows } = await deps.db.query<{ user_id: string }>(`SELECT user_id FROM plan_people WHERE plan_id = $1`, [planId]);
  await deps.realtime.publish(
    rows.map((r) => r.user_id),
    { type: 'plan.changed', data: { id: planId } },
  );
}

// ── Making and changing a plan ─────────────────────────────────────────

/**
 * Make a plan: its maker is in, the people invited answer, and its chat is made with the maker in
 * it (the others join as they say I'm in or Maybe). Returns its id and who was invited.
 */
export async function createPlan(
  deps: PlanDeps,
  makerId: string,
  input: {
    title: string;
    startsAt: string;
    place?: { kind: PlanPlaceKind; id?: string; name?: string } | null;
    note?: string;
    userIds: string[];
    squadId?: string;
  },
): Promise<{ id: string; invited: string[] }> {
  const { db } = deps;
  const when = assertWhen(input.startsAt);
  assertWords(input.title, input.note);
  const made = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plans WHERE created_by = $1 AND starts_at IS NOT NULL AND created_at > now() - interval '1 day'`,
      [makerId],
    )
  ).rows[0]!.n;
  if (made >= PLAN_RULES.perDay) throw new AppError(429, 'plan_limit', 'You’ve made a lot of plans today. Try again tomorrow.');
  const place = await resolvePlace(db, makerId, input.place);
  const invited = await invitees(db, makerId, { userIds: input.userIds, squadId: input.squadId }, [makerId]);
  const id = await tx(db, async (c) => {
    const conv = await c.query<{ id: string }>(`INSERT INTO conversations (kind, title, created_by) VALUES ('group',$1,$2) RETURNING id`, [
      input.title,
      makerId,
    ]);
    const conversationId = conv.rows[0]!.id;
    await c.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')`, [conversationId, makerId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO plans (conversation_id, created_by, title, note, starts_at, status, place_kind, place_id, place_name, squad_id)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9) RETURNING id`,
      [conversationId, makerId, input.title, input.note ?? '', when, place?.kind ?? null, place?.id ?? null, place?.name ?? null, input.squadId ?? null],
    );
    const planId = rows[0]!.id;
    await c.query(`INSERT INTO plan_people (plan_id, user_id, answer, answered_at) VALUES ($1,$2,'in',now())`, [planId, makerId]);
    if (invited.length) await c.query(`INSERT INTO plan_people (plan_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3`, [planId, invited, makerId]);
    return planId;
  });
  await tellInvited(deps, id, makerId, invited);
  return { id, invited };
}

/** Invite more (the maker, and anyone who said I'm in or Maybe): their friends, or a squad they're in. */
export async function inviteToPlan(deps: PlanDeps, planId: string, inviterId: string, input: { userIds: string[]; squadId?: string }): Promise<string[]> {
  const { db } = deps;
  const invited = await tx(db, async (c) => {
    const p = await planRow(c, planId, true);
    const mine = await answerOf(c, planId, inviterId);
    if (!inChat(mine)) throw new AppError(403, 'forbidden', "You don't have permission to do that.");
    if (p.status === 'cancelled') throw cancelledError();
    const everyone = (await c.query<{ user_id: string }>(`SELECT user_id FROM plan_people WHERE plan_id = $1`, [planId])).rows.map((r) => r.user_id);
    // People who said Can't are already in the plan (they can change their answer); the check is against everyone who may be in the chat.
    const members = await possibleMembers(c, planId);
    const adding = (await invitees(c, inviterId, input, members)).filter((id) => !everyone.includes(id));
    if (everyone.length + adding.length > PLAN_RULES.maxPeople) throw new AppError(409, 'plan_full', 'A plan can have up to 30 people.');
    if (adding.length) await c.query(`INSERT INTO plan_people (plan_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3`, [planId, adding, inviterId]);
    return adding;
  });
  await tellInvited(deps, planId, inviterId, invited);
  if (invited.length) await publishChanged(deps, planId);
  return invited;
}

/**
 * Answer: I'm in or Maybe puts you in the plan's chat (checked again against who is in it now),
 * Can't takes you out of it. The maker is always in (they cancel instead). The maker hears, batched
 * per plan while unread.
 */
export async function answerPlan(deps: PlanDeps, planId: string, userId: string, answer: PlanAnswer): Promise<void> {
  const { db, realtime } = deps;
  const change = await tx(db, async (c) => {
    const p = await planRow(c, planId, true);
    const before = await answerOf(c, planId, userId);
    if (p.status === 'cancelled') throw cancelledError();
    if (p.created_by === userId) {
      if (answer !== 'in') throw new AppError(409, 'plan_maker', 'You made this plan. Cancel it instead.');
      return null;
    }
    if (before === answer) return null;
    const conv = p.conversation_id;
    const joining = inChat(answer) && !inChat(before);
    const leaving = !inChat(answer) && inChat(before);
    if (joining && conv && (await clashWith(c, userId, await chatMembers(c, conv))))
      throw new AppError(403, 'plan_not_allowed', 'You can’t join this plan now.');
    const row = (
      await c.query<{ invited_by: string | null }>(
        `UPDATE plan_people SET answer = $3, answered_at = now() WHERE plan_id = $1 AND user_id = $2 RETURNING invited_by`,
        [planId, userId, answer],
      )
    ).rows[0]!;
    if (joining && conv)
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member')
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'member', last_read_at = now()`,
        [conv, userId],
      );
    if (leaving && conv)
      await c.query(`UPDATE conversation_members SET left_at = now(), role = 'member' WHERE conversation_id = $1 AND user_id = $2`, [conv, userId]);
    return { p, conv, joining, leaving, by: row.invited_by };
  });
  if (!change) return;
  const { p, conv } = change;
  await db.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'plan_invite' AND entity_id = $2`, [userId, planId]);
  if (conv && change.joining) {
    await stopSharesOnJoin({ db, realtime }, conv);
    await realtime.publish([userId], { type: 'conversation.created', data: { id: conv } });
    const members = await chatMembers(db, conv);
    const sender = change.by && members.includes(change.by) ? change.by : userId;
    await chatLine(db, realtime, conv, sender, { action: 'added', people: await namesOf(db, [userId]) });
  }
  if (conv && change.leaving) {
    await stopSharesOnLeave({ db, realtime }, conv, userId);
    await forfeitGamesOnLeave({ db, realtime }, conv, userId);
    await realtime.publish([userId], { type: 'conversation.removed', data: { id: conv } });
    await chatLine(db, realtime, conv, userId, { action: 'left' });
  }
  await notify(db, realtime, {
    userId: p.created_by,
    category: 'friends',
    type: 'plan_answer',
    actorId: userId,
    entityType: 'plan',
    entityId: planId,
    group: planId,
    data: { title: p.title, answer },
  });
  await publishChanged(deps, planId);
}

/**
 * The maker changes what, when, where or the details. A new title renames the chat; a new time
 * or place (or title) writes a line in the chat and tells everyone who hasn't said Can't.
 */
export async function editPlan(
  deps: PlanDeps,
  planId: string,
  userId: string,
  input: { title?: string; startsAt?: string; place?: { kind: PlanPlaceKind; id?: string; name?: string } | null; note?: string },
): Promise<void> {
  const { db, realtime } = deps;
  const p = await planRow(db, planId);
  await answerOf(db, planId, userId);
  if (p.created_by !== userId) throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  if (p.status === 'cancelled') throw cancelledError();
  const when = input.startsAt !== undefined ? assertWhen(input.startsAt) : null;
  assertWords(input.title, input.note);
  const place = input.place !== undefined ? await resolvePlace(db, userId, input.place) : undefined;
  await db.query(
    `UPDATE plans SET title = coalesce($2, title), note = coalesce($3, note), starts_at = coalesce($4, starts_at),
                      place_kind = CASE WHEN $5::boolean THEN $6 ELSE place_kind END,
                      place_id = CASE WHEN $5::boolean THEN $7::uuid ELSE place_id END,
                      place_name = CASE WHEN $5::boolean THEN $8 ELSE place_name END
     WHERE id = $1`,
    [planId, input.title ?? null, input.note ?? null, when, place !== undefined, place?.kind ?? null, place?.id ?? null, place?.name ?? null],
  );
  const title = input.title ?? p.title;
  const moved =
    (when && when.getTime() !== p.starts_at.getTime()) ||
    (place !== undefined && (place?.kind ?? null) + (place?.id ?? place?.name ?? '') !== (p.place_kind ?? null) + (p.place_id ?? p.place_name ?? '')) ||
    title !== p.title;
  if (p.conversation_id && title !== p.title) await db.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [p.conversation_id, title]);
  if (moved) {
    if (p.conversation_id) await chatLine(db, realtime, p.conversation_id, userId, { type: 'plan', planId, action: 'changed', title });
    const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM plan_people WHERE plan_id = $1 AND answer <> 'cant' AND user_id <> $2`, [
      planId,
      userId,
    ]);
    for (const r of rows)
      await notify(db, realtime, {
        userId: r.user_id,
        category: 'friends',
        type: 'plan_changed',
        actorId: userId,
        entityType: 'plan',
        entityId: planId,
        data: { title },
      });
  }
  await publishChanged(deps, planId);
}

/** The maker cancels: everyone who hadn't said Can't is told, and a line says so. The chat stays an ordinary group. */
export async function cancelPlan(deps: PlanDeps, planId: string, userId: string): Promise<void> {
  const { db, realtime } = deps;
  const p = await planRow(db, planId);
  await answerOf(db, planId, userId);
  if (p.created_by !== userId) throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  if (p.status === 'cancelled') return;
  await db.query(`UPDATE plans SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [planId]);
  await db.query(`DELETE FROM notifications WHERE type = 'plan_invite' AND entity_id = $1`, [planId]);
  if (p.conversation_id) await chatLine(db, realtime, p.conversation_id, userId, { type: 'plan', planId, action: 'cancelled', title: p.title });
  const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM plan_people WHERE plan_id = $1 AND answer <> 'cant' AND user_id <> $2`, [
    planId,
    userId,
  ]);
  for (const r of rows)
    await notify(db, realtime, {
      userId: r.user_id,
      category: 'friends',
      type: 'plan_cancelled',
      actorId: userId,
      entityType: 'plan',
      entityId: planId,
      data: { title: p.title },
    });
  await publishChanged(deps, planId);
}

/**
 * An account being deleted: plans it made go on with the person who said I'm in first (or are
 * deleted when nobody else is in), its "I'm free" goes, it's out of every plan (its answer becomes
 * Can't, so the others' cost split still adds up), and the words of expenses it added go.
 * Its chats are left by the account deletion itself.
 */
export async function leavePlansOnDeletion(db: Q, userId: string): Promise<void> {
  await db.query(`DELETE FROM free_now WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM plans WHERE created_by = $1 AND starts_at IS NULL`, [userId]);
  const made = await db.query<{ id: string; conversation_id: string | null }>(
    `SELECT id, conversation_id FROM plans WHERE created_by = $1 AND starts_at IS NOT NULL`,
    [userId],
  );
  for (const p of made.rows) {
    const next = await db.query<{ user_id: string }>(
      `SELECT pp.user_id FROM plan_people pp JOIN users u ON u.id = pp.user_id
       WHERE pp.plan_id = $1 AND pp.user_id <> $2 AND pp.answer IN ('in', 'maybe') AND u.status = 'active'
       ORDER BY (pp.answer = 'in') DESC, pp.answered_at LIMIT 1`,
      [p.id, userId],
    );
    if (!next.rows[0]) {
      await db.query(`DELETE FROM plans WHERE id = $1`, [p.id]);
      continue;
    }
    await db.query(`UPDATE plans SET created_by = $2 WHERE id = $1`, [p.id, next.rows[0].user_id]);
    await db.query(`UPDATE plan_people SET answer = 'in' WHERE plan_id = $1 AND user_id = $2`, [p.id, next.rows[0].user_id]);
    if (p.conversation_id)
      await db.query(`UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`, [p.conversation_id, next.rows[0].user_id]);
  }
  await db.query(`UPDATE plan_people SET answer = 'cant', answered_at = now() WHERE user_id = $1`, [userId]);
  await db.query(`UPDATE plan_expenses SET title = '' WHERE added_by = $1`, [userId]);
}

// ── Reading ────────────────────────────────────────────────────────────

/** The place as this viewer may see it: a place page, event or stash only when they can see it themselves. */
async function placeFor(db: Q, p: PlanRow, viewer: string): Promise<PlanPlace | null> {
  if (!p.place_kind) return null;
  if (p.place_kind === 'text') return { kind: 'text', id: null, name: p.place_name };
  const r = await resolvePlace(db, viewer, { kind: p.place_kind, id: p.place_id ?? undefined }).catch(() => null);
  return r ? { kind: r.kind, id: r.id, name: r.name } : null;
}

const countsOf = (answers: PlanPersonAnswer[]): PlanCounts => ({
  in: answers.filter((a) => a === 'in').length,
  maybe: answers.filter((a) => a === 'maybe').length,
  cant: answers.filter((a) => a === 'cant').length,
  pending: answers.filter((a) => a === 'pending').length,
});

/** Who paid for what in a plan, what was paid back, and who owes whom now (simplified). */
async function costsOf(db: Q, planId: string, makerId: string, viewer: string): Promise<PlanCosts> {
  const ex = await db.query<{
    id: string;
    title: string;
    amount_cents: string;
    currency: string;
    paid_by: string;
    added_by: string;
    created_at: Date;
    shares: { userId: string; shareCents: number }[];
  }>(
    `SELECT e.id, e.title, e.amount_cents, e.currency, e.paid_by, e.added_by, e.created_at,
            coalesce((SELECT json_agg(json_build_object('userId', s.user_id, 'shareCents', s.share_cents) ORDER BY s.share_cents DESC, s.user_id)
                      FROM plan_expense_shares s WHERE s.expense_id = e.id), '[]') AS shares
     FROM plan_expenses e WHERE e.plan_id = $1 ORDER BY e.created_at, e.id`,
    [planId],
  );
  const st = await db.query<{ id: string; from_id: string; to_id: string; amount_cents: string; currency: string; marked_by: string; created_at: Date }>(
    `SELECT id, from_id, to_id, amount_cents, currency, marked_by, created_at FROM plan_settlements WHERE plan_id = $1 ORDER BY created_at, id`,
    [planId],
  );
  const expenses = ex.rows.map((e) => ({
    id: e.id,
    title: e.title,
    amountCents: Number(e.amount_cents),
    currency: e.currency,
    paidBy: e.paid_by,
    addedBy: e.added_by,
    shares: e.shares.map((s) => ({ userId: s.userId, shareCents: Number(s.shareCents) })),
    createdAt: e.created_at.toISOString(),
    canRemove: e.added_by === viewer || makerId === viewer,
  }));
  const settlements = st.rows.map((s) => ({
    id: s.id,
    from: s.from_id,
    to: s.to_id,
    amountCents: Number(s.amount_cents),
    currency: s.currency,
    createdAt: s.created_at.toISOString(),
    canUndo: s.marked_by === viewer,
  }));
  return { expenses, settlements, debts: planDebts(expenses, settlements) };
}

/** A plan, for someone in it (not found for anyone else). */
export async function planFor(db: Q, planId: string, viewer: string): Promise<Plan> {
  const p = await planRow(db, planId);
  const answer = await answerOf(db, planId, viewer);
  const people = await db.query<PublicUserRow & { answer: PlanPersonAnswer }>(
    `SELECT pp.answer, ${PUBLIC_USER_COLS} FROM plan_people pp JOIN profiles pr ON pr.user_id = pp.user_id JOIN users u ON u.id = pp.user_id
     WHERE pp.plan_id = $1 AND (pp.user_id = $2 OR (u.status = 'active' AND ${notBlockedSql('pp.user_id', '$2')}))
     ORDER BY (pp.user_id = $3) DESC, array_position(ARRAY['in', 'maybe', 'pending', 'cant'], pp.answer), pp.answered_at NULLS LAST, pr.display_name`,
    [planId, viewer, p.created_by],
  );
  const all = (await db.query<{ answer: PlanPersonAnswer }>(`SELECT answer FROM plan_people WHERE plan_id = $1`, [planId])).rows.map((r) => r.answer);
  const maker = (await usersByIds(db, [p.created_by])).get(p.created_by)!;
  const squad = p.squad_id
    ? ((
        await db.query<{ id: string; name: string }>(
          `SELECT sq.id, sq.name FROM squads sq JOIN squad_members sm ON sm.squad_id = sq.id AND sm.user_id = $2 AND sm.status = 'active' WHERE sq.id = $1`,
          [p.squad_id, viewer],
        )
      ).rows[0] ?? null)
    : null;
  const active = p.status !== 'cancelled';
  return {
    id: p.id,
    title: p.title,
    note: p.note,
    startsAt: p.starts_at.toISOString(),
    place: await placeFor(db, p, viewer),
    status: active ? 'active' : 'cancelled',
    maker,
    squad,
    people: people.rows.map((r) => ({ user: toPublicUser(r), answer: r.answer, maker: r.id === p.created_by })),
    counts: countsOf(all),
    viewer: { answer, maker: p.created_by === viewer, canInvite: active && inChat(answer) },
    conversationId: inChat(answer) ? p.conversation_id : null,
    costs: answer === 'pending' ? null : await costsOf(db, planId, p.created_by, viewer),
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

/** Your plans: coming up (soonest first; one that started in the last 12 hours still counts), then earlier ones. */
export async function planCards(db: Q, viewer: string): Promise<{ upcoming: PlanCard[]; past: PlanCard[] }> {
  const { rows } = await db.query<PlanRow & { answer: PlanPersonAnswer; answers: PlanPersonAnswer[] }>(
    `SELECT ${PLAN_COLS}, me.answer, (SELECT array_agg(x.answer) FROM plan_people x WHERE x.plan_id = p.id) AS answers
     FROM plan_people me JOIN plans p ON p.id = me.plan_id
     WHERE me.user_id = $1 AND p.starts_at IS NOT NULL
       AND (p.created_by = $1 OR ${notBlockedSql('p.created_by', '$1')})
     ORDER BY p.starts_at DESC LIMIT 100`,
    [viewer],
  );
  const makers = await usersByIds(
    db,
    rows.map((r) => r.created_by),
  );
  const cards: PlanCard[] = [];
  for (const r of rows) {
    const maker = makers.get(r.created_by);
    if (!maker) continue;
    cards.push({
      id: r.id,
      title: r.title,
      startsAt: r.starts_at.toISOString(),
      place: await placeFor(db, r, viewer),
      status: r.status === 'cancelled' ? 'cancelled' : 'active',
      maker,
      answer: r.answer,
      counts: countsOf(r.answers ?? []),
      conversationId: inChat(r.answer) ? r.conversation_id : null,
    });
  }
  const soon = Date.now() - 12 * 3_600_000;
  return {
    upcoming: cards.filter((c) => new Date(c.startsAt).getTime() >= soon).reverse(),
    past: cards.filter((c) => new Date(c.startsAt).getTime() < soon),
  };
}

/** The plan a chat belongs to (while it's on, the chat follows its answers), or null. */
export async function planOfChat(db: Q, conversationId: string): Promise<{ id: string; status: string } | null> {
  const { rows } = await db.query<{ id: string; status: string }>(`SELECT id, status FROM plans WHERE conversation_id = $1 AND starts_at IS NOT NULL`, [
    conversationId,
  ]);
  return rows[0] ?? null;
}

// ── Cost split ─────────────────────────────────────────────────────────

/** Someone in a plan who has answered (expenses and paying back are for them, not people only invited). */
async function assertAnswered(db: Q, planId: string, userId: string): Promise<PlanRow> {
  const p = await planRow(db, planId);
  if ((await answerOf(db, planId, userId)) === 'pending') throw new AppError(403, 'plan_answer_first', 'Answer the plan first.');
  return p;
}

/**
 * Add an expense: anyone who said I'm in or Maybe (and the maker), paid by one of them and split
 * equally between some of them. Only a record: no money moves through YAPILAPI.
 */
export async function addExpense(
  deps: PlanDeps,
  planId: string,
  userId: string,
  input: { title: string; amountCents: number; currency: string; paidBy: string; splitWith: string[] },
): Promise<void> {
  const { db } = deps;
  await planRow(db, planId);
  if (!inChat(await answerOf(db, planId, userId))) throw new AppError(403, 'forbidden', "You don't have permission to do that.");
  assertWords(input.title);
  const people = new Set(
    (await db.query<{ user_id: string }>(`SELECT user_id FROM plan_people WHERE plan_id = $1 AND answer IN ('in', 'maybe')`, [planId])).rows.map(
      (r) => r.user_id,
    ),
  );
  const split = [...new Set(input.splitWith)];
  if (!people.has(input.paidBy) || split.some((id) => !people.has(id)))
    throw badRequest('Choose people who are in the plan.', { fields: { splitWith: 'Choose people who are in the plan.' } });
  await tx(db, async (c) => {
    await c.query(`SELECT 1 FROM plans WHERE id = $1 FOR UPDATE`, [planId]);
    const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM plan_expenses WHERE plan_id = $1`, [planId])).rows[0]!.n;
    if (n >= PLAN_RULES.maxExpenses) throw new AppError(409, 'plan_expenses_full', 'A plan can have up to 100 expenses.');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO plan_expenses (plan_id, added_by, paid_by, title, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [planId, userId, input.paidBy, input.title, input.amountCents, input.currency],
    );
    for (const s of splitEvenly(input.amountCents, split))
      await c.query(`INSERT INTO plan_expense_shares (expense_id, user_id, share_cents) VALUES ($1,$2,$3)`, [rows[0]!.id, s.userId, s.shareCents]);
  });
  await publishChanged(deps, planId);
}

/** Remove an expense (whoever added it, or the plan's maker). */
export async function removeExpense(deps: PlanDeps, planId: string, userId: string, expenseId: string): Promise<void> {
  const p = await assertAnswered(deps.db, planId, userId);
  const r = await deps.db.query(`DELETE FROM plan_expenses WHERE id = $1 AND plan_id = $2 AND (added_by = $3 OR $4::boolean)`, [
    expenseId,
    planId,
    userId,
    p.created_by === userId,
  ]);
  if (!r.rowCount) throw notFound('That item');
  await publishChanged(deps, planId);
}

/**
 * "Paid back": one of the two marks that `from` paid `to` back, up to what `from` owes `to` now
 * (in the simplified debts). Only a record, like the rest.
 */
export async function markPaidBack(
  deps: PlanDeps,
  planId: string,
  userId: string,
  input: { from: string; to: string; amountCents: number; currency: string },
): Promise<void> {
  const { db } = deps;
  const p = await assertAnswered(db, planId, userId);
  if (userId !== input.from && userId !== input.to)
    throw new AppError(403, 'plan_paid_back', 'Only the person who paid back, or the person paid, can mark it.');
  await tx(db, async (c) => {
    await c.query(`SELECT 1 FROM plans WHERE id = $1 FOR UPDATE`, [planId]);
    const { debts } = await costsOf(c, planId, p.created_by, userId);
    if (input.amountCents > owedBy(debts, input.from, input.to, input.currency))
      throw new AppError(409, 'plan_not_owed', 'That’s more than is owed. Check the amounts again.');
    await c.query(`INSERT INTO plan_settlements (plan_id, from_id, to_id, amount_cents, currency, marked_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
      planId,
      input.from,
      input.to,
      input.amountCents,
      input.currency,
      userId,
    ]);
  });
  await publishChanged(deps, planId);
}

/** Undo a "paid back" you marked. */
export async function undoPaidBack(deps: PlanDeps, planId: string, userId: string, settlementId: string): Promise<void> {
  await assertAnswered(deps.db, planId, userId);
  const r = await deps.db.query(`DELETE FROM plan_settlements WHERE id = $1 AND plan_id = $2 AND marked_by = $3`, [settlementId, planId, userId]);
  if (!r.rowCount) throw notFound('That item');
  await publishChanged(deps, planId);
}

// ── I'm free ───────────────────────────────────────────────────────────

/** Say you're free until a time (from 15 minutes to 18 hours from now), with a few words. Friends see it. */
export async function setFree(db: Q, userId: string, input: { until: string; note?: string }): Promise<FreeNow> {
  const until = new Date(input.until);
  const now = Date.now();
  if (
    Number.isNaN(until.getTime()) ||
    until.getTime() < now + PLAN_RULES.freeMinMinutes * 60_000 - 60_000 ||
    until.getTime() > now + PLAN_RULES.freeMaxHours * 3_600_000
  )
    throw new AppError(400, 'free_until', 'Choose a time in the next 18 hours.');
  assertWords(input.note);
  const { rows } = await db.query<{ note: string; until: Date }>(
    `INSERT INTO free_now (user_id, note, until) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET note = EXCLUDED.note, until = EXCLUDED.until, created_at = now()
     RETURNING note, until`,
    [userId, input.note ?? '', until],
  );
  return { note: rows[0]!.note, until: rows[0]!.until.toISOString() };
}

export async function clearFree(db: Q, userId: string): Promise<void> {
  await db.query(`DELETE FROM free_now WHERE user_id = $1`, [userId]);
}

export async function ownFree(db: Q, userId: string): Promise<FreeNow | null> {
  const { rows } = await db.query<{ note: string; until: Date }>(`SELECT note, until FROM free_now WHERE user_id = $1 AND until > now()`, [userId]);
  return rows[0] ? { note: rows[0].note, until: rows[0].until.toISOString() } : null;
}

/**
 * Friends who said they're free, newest first: friends only (both ways, by definition), active, no
 * block either way. A supervised teen whose family settings allow messages from nobody isn't shown
 * (and sees nobody), except to and from their guardians. Nothing about where anyone is.
 */
export async function freeFriends(db: Q, viewer: string): Promise<FreeFriend[]> {
  const { rows } = await db.query<PublicUserRow & { note: string; until: Date }>(
    `SELECT fn.note, fn.until, ${PUBLIC_USER_COLS} FROM free_now fn JOIN profiles pr ON pr.user_id = fn.user_id JOIN users u ON u.id = fn.user_id
     WHERE fn.until > now() AND u.status = 'active' AND fn.user_id <> $1
       AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST(fn.user_id, $1::uuid) AND fr.user_b = GREATEST(fn.user_id, $1::uuid))
       AND ${notBlockedSql('fn.user_id', '$1')}
     ORDER BY fn.created_at DESC LIMIT 50`,
    [viewer],
  );
  const mine = await activeControls(db, viewer);
  const out: FreeFriend[] = [];
  for (const r of rows) {
    if (mine?.messagesFrom === 'nobody' && !mine.guardianIds.includes(r.id)) continue;
    const theirs = await activeControls(db, r.id);
    if (theirs?.messagesFrom === 'nobody' && !theirs.guardianIds.includes(viewer)) continue;
    out.push({ user: toPublicUser(r), note: r.note, until: r.until.toISOString() });
  }
  return out;
}

/** "I'm free" ends by itself; ended ones are deleted (the job worker's minute sweep). */
export async function sweepFreeNow(db: Q): Promise<number> {
  return (await db.query(`DELETE FROM free_now WHERE until <= now()`)).rowCount ?? 0;
}

/** Friends you could invite (to a new plan, or to this one: people not in it yet), with a search. */
export async function planCandidates(db: Q, viewer: string, planId: string | null, q: string | null, limit = 50): Promise<PublicUser[]> {
  const { rows } = await db.query<PublicUserRow>(
    `SELECT ${PUBLIC_USER_COLS} FROM friendships fr
       JOIN profiles pr ON pr.user_id = CASE WHEN fr.user_a = $1 THEN fr.user_b ELSE fr.user_a END JOIN users u ON u.id = pr.user_id
     WHERE (fr.user_a = $1 OR fr.user_b = $1) AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$1')}
       AND ($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM plan_people x WHERE x.plan_id = $2 AND x.user_id = pr.user_id))
       AND ($3::text IS NULL OR pr.username ILIKE $3 || '%' OR pr.display_name ILIKE '%' || $3 || '%')
     ORDER BY pr.display_name LIMIT $4`,
    [viewer, planId, q, limit],
  );
  return rows.map(toPublicUser);
}
