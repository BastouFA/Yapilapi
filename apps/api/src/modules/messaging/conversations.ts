import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
  type Page,
} from '@yapilapi/shared';
import { withTransaction, type Tx } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import type { FastifyRequest } from 'fastify';
import {
  CONV_COLS,
  contactDenial,
  denialError,
  directKey,
  loadAccess,
  requireAccess,
  teenGroupDenial,
  type ConvAccess,
  type ConversationRow,
} from './access.js';
import { publishConv, publishUser } from './events.js';

export const MAX_GROUP_MEMBERS = 100;

interface PersonRow {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}
const person = (p: PersonRow) => ({
  id: p.user_id,
  username: p.username,
  displayName: p.display_name,
  avatarUrl: p.avatar_url,
});

async function people(ctx: AppContext, ids: string[]): Promise<Map<string, PersonRow>> {
  if (!ids.length) return new Map();
  const { rows } = await ctx.db.query<PersonRow>(
    'SELECT user_id, username, display_name, avatar_url FROM profiles WHERE user_id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(rows.map((r) => [r.user_id, r]));
}

/** Active, non-deleted account ids among `ids`. */
async function activeUsers(db: AppContext['db'] | Tx, ids: string[]): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status IN ('active','pending_deletion')`,
    [ids],
  );
  return new Set(rows.map((r) => r.id));
}

export interface InboxRow extends ConversationRow {
  sort_ts: string;
  last_read_at: Date | null;
  muted_until: Date | null;
  pinned: boolean;
  my_role: string | null;
  unread: number;
  lm_id: string | null;
  lm_sender_id: string | null;
  lm_kind: string | null;
  lm_body: string | null;
  lm_created_at: Date | null;
  peer_id: string | null;
}

function conversationBase(c: ConversationRow) {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    communityId: c.community_id,
    channelName: c.channel_name,
    channelKind: c.channel_kind,
    createdBy: c.created_by,
    createdAt: c.created_at.toISOString(),
    lastMessageAt: c.last_message_at?.toISOString() ?? null,
  };
}

const UNREAD_SQL = `(SELECT count(*)::int FROM (
      SELECT 1 FROM messages um WHERE um.conversation_id = c.id AND um.deleted_at IS NULL AND um.moderation_status = 'approved'
         AND um.sender_id IS DISTINCT FROM $1::uuid AND um.created_at > COALESCE(cm.last_read_at, cm.joined_at)
       LIMIT 100) u)`;
const LAST_SQL = `LEFT JOIN LATERAL (
      SELECT lm.id, lm.sender_id, lm.kind, lm.body, lm.created_at FROM messages lm
       WHERE lm.conversation_id = c.id AND lm.deleted_at IS NULL AND lm.moderation_status = 'approved' AND lm.created_at >= COALESCE(cm.joined_at, 'epoch')
       ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1) lm ON true`;

export async function listInbox(
  ctx: AppContext,
  userId: string,
  opts: {
    cursor?: string | undefined;
    limit?: number | undefined;
    pinned?: boolean | undefined;
    kind?: 'direct' | 'group' | undefined;
  },
): Promise<Page<Record<string, unknown>>> {
  const limit = clampLimit(opts.limit);
  const cur = decodeCursor<{ t: string; id: string }>(opts.cursor);
  const { rows } = await ctx.db.query<InboxRow>(
    `SELECT c.id, c.kind, c.title, c.direct_key, c.community_id, c.channel_name, c.channel_kind, c.created_by, c.last_message_at, c.created_at,
            COALESCE(c.last_message_at, c.created_at)::text AS sort_ts,
            cm.last_read_at, cm.muted_until, cm.pinned, cm.role AS my_role,
            ${UNREAD_SQL} AS unread,
            lm.id AS lm_id, lm.sender_id AS lm_sender_id, lm.kind AS lm_kind, lm.body AS lm_body, lm.created_at AS lm_created_at,
            (SELECT o.user_id FROM conversation_members o WHERE o.conversation_id = c.id AND o.user_id <> $1 AND c.kind = 'direct' LIMIT 1) AS peer_id
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       ${LAST_SQL}
      WHERE cm.user_id = $1 AND cm.left_at IS NULL AND c.kind IN ('direct','group')
        AND ($5::boolean IS NULL OR cm.pinned = $5::boolean)
        AND ($6::text IS NULL OR c.kind = $6::text)
        AND NOT (c.kind = 'direct' AND EXISTS (
              SELECT 1 FROM conversation_members o JOIN user_blocks b ON (b.blocker_id = $1 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $1)
               WHERE o.conversation_id = c.id AND o.user_id <> $1))
        AND ($2::timestamptz IS NULL OR (COALESCE(c.last_message_at, c.created_at), c.id) < ($2::timestamptz, $3::uuid))
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT $4`,
    [userId, cur?.t ?? null, cur?.id ?? null, limit + 1, opts.pinned ?? null, opts.kind ?? null],
  );
  const page = rows.slice(0, limit);
  const peers = await people(
    ctx,
    page.map((r) => r.peer_id).filter((x): x is string => !!x),
  );
  const items = page.map((r) => ({
    ...conversationBase(r),
    peer: r.peer_id && peers.get(r.peer_id) ? person(peers.get(r.peer_id)!) : null,
    unreadCount: r.unread, // capped at 100
    pinned: r.pinned,
    mutedUntil: r.muted_until?.toISOString() ?? null,
    muted: r.muted_until !== null && r.muted_until.getTime() > Date.now(),
    lastReadAt: r.last_read_at?.toISOString() ?? null,
    lastMessage: r.lm_id
      ? {
          id: r.lm_id,
          senderId: r.lm_sender_id,
          kind: r.lm_kind,
          preview: (r.lm_body ?? '').slice(0, 140),
          createdAt: r.lm_created_at!.toISOString(),
        }
      : null,
  }));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.sort_ts, id: last.id }) : null,
  };
}

export async function unreadSummary(
  ctx: AppContext,
  userId: string,
): Promise<{ conversations: number; messages: number }> {
  const { rows } = await ctx.db.query<{ unread: number }>(
    `SELECT ${UNREAD_SQL} AS unread FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.user_id = $1 AND cm.left_at IS NULL AND c.kind IN ('direct','group') AND (cm.muted_until IS NULL OR cm.muted_until <= now())
        AND NOT (c.kind = 'direct' AND EXISTS (
              SELECT 1 FROM conversation_members o JOIN user_blocks b ON (b.blocker_id = $1 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $1)
               WHERE o.conversation_id = c.id AND o.user_id <> $1))`,
    [userId],
  );
  const withUnread = rows.filter((r) => r.unread > 0);
  return {
    conversations: withUnread.length,
    messages: withUnread.reduce((a, r) => a + r.unread, 0),
  };
}

export async function getConversationView(
  ctx: AppContext,
  userId: string,
  access: ConvAccess,
): Promise<Record<string, unknown>> {
  const c = access.conv;
  const me = await ctx.db.query<{
    last_read_at: Date | null;
    muted_until: Date | null;
    pinned: boolean;
    joined_at: Date;
    read_raw: string | null;
    joined_raw: string;
  }>(
    'SELECT last_read_at, muted_until, pinned, joined_at, last_read_at::text AS read_raw, joined_at::text AS joined_raw FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [c.id, userId],
  );
  const m = me.rows[0];
  const unread = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM messages um WHERE um.conversation_id = $1 AND um.deleted_at IS NULL AND um.moderation_status = 'approved'
        AND um.sender_id IS DISTINCT FROM $2::uuid AND um.created_at > COALESCE($3::timestamptz, $4::timestamptz, 'epoch') LIMIT 100) x`,
    [c.id, userId, m?.read_raw ?? null, m?.joined_raw ?? null],
  );
  const view: Record<string, unknown> = {
    ...conversationBase(c),
    role: access.role,
    canSend: access.canSend,
    canManage: access.canManage,
    me: {
      lastReadAt: m?.last_read_at?.toISOString() ?? null,
      mutedUntil: m?.muted_until?.toISOString() ?? null,
      muted: !!m?.muted_until && m.muted_until.getTime() > Date.now(),
      pinned: m?.pinned ?? false,
    },
    unreadCount: unread.rows[0]!.n,
  };
  if (c.kind !== 'community_channel') {
    const { rows } = await ctx.db.query<{
      user_id: string;
      role: string;
      joined_at: Date;
      last_read_at: Date | null;
    }>(
      `SELECT user_id, role, joined_at, last_read_at FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL ORDER BY joined_at, user_id LIMIT ${MAX_GROUP_MEMBERS + 1}`,
      [c.id],
    );
    const p = await people(
      ctx,
      rows.map((r) => r.user_id),
    );
    const members = rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      joinedAt: r.joined_at.toISOString(),
      lastReadAt: r.last_read_at?.toISOString() ?? null,
      profile: p.get(r.user_id) ? person(p.get(r.user_id)!) : null,
    }));
    view.members = members;
    view.memberCount = members.length;
    if (c.kind === 'direct') view.peer = members.find((x) => x.userId !== userId)?.profile ?? null;
  }
  return view;
}

// ------------------------------------------------------------------ create

export async function createOrGetDirect(
  ctx: AppContext,
  userId: string,
  targetId: string,
): Promise<{ conversationId: string; created: boolean }> {
  if (targetId === userId) throw invalid('You cannot start a conversation with yourself');
  if (!(await activeUsers(ctx.db, [targetId])).has(targetId)) throw notFound('User');
  if (await isBlockedEitherWay(ctx.db, userId, targetId)) throw notFound('User'); // never reveal blocks

  const key = directKey(userId, targetId);
  const existing = await ctx.db.query<{ id: string }>(
    'SELECT id FROM conversations WHERE direct_key = $1',
    [key],
  );
  if (existing.rows[0]) {
    // Both participants stay members of their DM forever, but heal a row that was somehow closed.
    await ctx.db.query(
      'UPDATE conversation_members SET left_at = NULL WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NOT NULL',
      [existing.rows[0].id, userId],
    );
    return { conversationId: existing.rows[0].id, created: false };
  }
  const denial = await contactDenial(ctx.db, userId, targetId);
  if (denial) throw denialError(denial);

  return withTransaction(ctx.db, async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO conversations (kind, direct_key, created_by) VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL DO NOTHING RETURNING id`,
      [key, userId],
    );
    if (!ins.rows[0]) {
      const again = await tx.query<{ id: string }>(
        'SELECT id FROM conversations WHERE direct_key = $1',
        [key],
      );
      return { conversationId: again.rows[0]!.id, created: false };
    }
    const id = ins.rows[0].id;
    await tx.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member'), ($1,$3,'member')`,
      [id, userId, targetId],
    );
    return { conversationId: id, created: true };
  });
}

export async function createGroup(
  ctx: AppContext,
  userId: string,
  input: { title: string; memberIds: string[] },
  req?: FastifyRequest,
): Promise<string> {
  const others = [...new Set(input.memberIds)].filter((id) => id !== userId);
  if (!others.length) throw invalid('A group needs at least one other member');
  if (others.length + 1 > MAX_GROUP_MEMBERS)
    throw invalid(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
  const active = await activeUsers(ctx.db, others);
  for (const id of others) {
    // Missing/deleted and block-related members are reported identically so blocks are not revealed.
    if (!active.has(id) || (await isBlockedEitherWay(ctx.db, userId, id)))
      throw invalid('One or more members are unavailable');
    const denial = await contactDenial(ctx.db, userId, id);
    if (denial) throw denialError(denial);
  }
  if (await teenGroupDenial(ctx.db, [userId, ...others], [userId, ...others])) {
    throw new AppError(
      'forbidden',
      'Accounts for people under 18 can only be in groups with their accepted friends',
      { reason: 'teen_friends_only' },
    );
  }
  const id = await withTransaction(ctx.db, async (tx) => {
    const c = await tx.query<{ id: string }>(
      `INSERT INTO conversations (kind, title, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [input.title.trim(), userId],
    );
    const cid = c.rows[0]!.id;
    await tx.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'owner')`,
      [cid, userId],
    );
    for (const m of others)
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member')`,
        [cid, m],
      );
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'conversation.group_created',
        targetType: 'conversation',
        targetId: cid,
        metadata: { members: others.length + 1 },
      },
      req,
      tx,
    );
    return cid;
  });
  for (const m of others) publishUser(ctx, m, { type: 'conversation.added', conversationId: id });
  return id;
}

// ------------------------------------------------------------------ group management

function requireGroupManager(access: ConvAccess): void {
  if (access.conv.kind !== 'group') throw invalid('Only group conversations support this');
  if (!access.canManage) throw forbidden('Only group owners and admins can do that');
}

export async function renameGroup(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  title: string,
  req?: FastifyRequest,
): Promise<void> {
  const access = await requireAccess(ctx.db, conversationId, userId);
  requireGroupManager(access);
  await ctx.db.query('UPDATE conversations SET title = $2 WHERE id = $1', [
    conversationId,
    title.trim(),
  ]);
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'conversation.renamed',
      targetType: 'conversation',
      targetId: conversationId,
    },
    req,
  );
  publishConv(ctx, conversationId, { type: 'conversation.updated', title: title.trim() });
}

export async function addMembers(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  userIds: string[],
  req?: FastifyRequest,
): Promise<string[]> {
  const access = await requireAccess(ctx.db, conversationId, userId);
  requireGroupManager(access);
  const wanted = [...new Set(userIds)].filter((id) => id !== userId);
  if (!wanted.length) throw invalid('Provide at least one other user');
  const active = await activeUsers(ctx.db, wanted);
  for (const id of wanted) {
    if (!active.has(id) || (await isBlockedEitherWay(ctx.db, userId, id)))
      throw invalid('One or more users are unavailable');
    const denial = await contactDenial(ctx.db, userId, id);
    if (denial) throw denialError(denial);
  }
  const added = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]); // serialize the size check
    const cur = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
      [conversationId],
    );
    const current = new Set(cur.rows.map((r) => r.user_id));
    const fresh = wanted.filter((id) => !current.has(id));
    if (current.size + fresh.length > MAX_GROUP_MEMBERS)
      throw conflict(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
    if (fresh.length && (await teenGroupDenial(tx, [...current, ...fresh], fresh))) {
      throw new AppError(
        'forbidden',
        'Accounts for people under 18 can only be in groups with their accepted friends',
        { reason: 'teen_friends_only' },
      );
    }
    for (const id of fresh) {
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES ($1,$2,'member', now())
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now(), role = 'member', last_read_at = NULL, muted_until = NULL, pinned = false`,
        [conversationId, id],
      );
      await audit(
        ctx,
        {
          actorId: userId,
          action: 'conversation.member_added',
          targetType: 'conversation',
          targetId: conversationId,
          metadata: { userId: id },
        },
        req,
        tx,
      );
    }
    return fresh;
  });
  for (const id of added) {
    publishUser(ctx, id, { type: 'conversation.added', conversationId });
    publishConv(ctx, conversationId, { type: 'conversation.member.added', userId: id });
  }
  return added;
}

/** If the owner is leaving/leaving via deletion, hand ownership to the longest-standing admin, else member. */
export async function transferOwnershipIfNeeded(tx: Tx, conversationId: string): Promise<void> {
  const owner = await tx.query(
    "SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL AND role = 'owner'",
    [conversationId],
  );
  if (owner.rowCount) return;
  await tx.query(
    `UPDATE conversation_members SET role = 'owner' WHERE (conversation_id, user_id) = (
       SELECT conversation_id, user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL
        ORDER BY (role = 'admin') DESC, joined_at, user_id LIMIT 1)`,
    [conversationId],
  );
}

export async function removeMember(
  ctx: AppContext,
  actorId: string,
  conversationId: string,
  targetId: string,
  req?: FastifyRequest,
): Promise<void> {
  const access = await requireAccess(ctx.db, conversationId, actorId);
  requireGroupManager(access);
  if (targetId === actorId) throw invalid('Use the leave endpoint to leave a conversation');
  const t = await ctx.db.query<{ role: string }>(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
    [conversationId, targetId],
  );
  if (!t.rows[0]) throw notFound('Member');
  if (t.rows[0].role === 'owner') throw forbidden('The owner cannot be removed');
  if (t.rows[0].role === 'admin' && access.role !== 'owner')
    throw forbidden('Only the owner can remove an admin');
  await ctx.db.query(
    'UPDATE conversation_members SET left_at = now(), pinned = false WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, targetId],
  );
  await audit(
    ctx,
    {
      actorId,
      action: 'conversation.member_removed',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { userId: targetId },
    },
    req,
  );
  publishUser(ctx, targetId, { type: 'conversation.removed', conversationId });
  publishConv(ctx, conversationId, { type: 'conversation.member.removed', userId: targetId });
}

export async function leaveGroup(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  req?: FastifyRequest,
): Promise<void> {
  const access = await requireAccess(ctx.db, conversationId, userId);
  if (access.conv.kind !== 'group') throw invalid('Only group conversations can be left');
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      'UPDATE conversation_members SET left_at = now(), pinned = false WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId],
    );
    await transferOwnershipIfNeeded(tx, conversationId);
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'conversation.left',
        targetType: 'conversation',
        targetId: conversationId,
      },
      req,
      tx,
    );
  });
  publishUser(ctx, userId, { type: 'conversation.removed', conversationId });
  publishConv(ctx, conversationId, { type: 'conversation.member.removed', userId });
}

export async function setMemberRole(
  ctx: AppContext,
  actorId: string,
  conversationId: string,
  targetId: string,
  role: 'admin' | 'member',
  req?: FastifyRequest,
): Promise<void> {
  const access = await requireAccess(ctx.db, conversationId, actorId);
  if (access.conv.kind !== 'group') throw invalid('Only group conversations have roles');
  if (access.role !== 'owner') throw forbidden('Only the owner can change roles');
  const r = await ctx.db.query(
    `UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL AND role <> 'owner'`,
    [conversationId, targetId, role],
  );
  if (!r.rowCount) throw notFound('Member');
  await audit(
    ctx,
    {
      actorId,
      action: 'conversation.role_changed',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { userId: targetId, role },
    },
    req,
  );
  publishConv(ctx, conversationId, { type: 'conversation.member.updated', userId: targetId, role });
}

export async function updateMyPrefs(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  prefs: { mutedUntil?: Date | null | undefined; pinned?: boolean | undefined },
): Promise<{ mutedUntil: string | null; pinned: boolean }> {
  await requireAccess(ctx.db, conversationId, userId);
  // Community channels have no membership row until first needed.
  await ctx.db.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`,
    [conversationId, userId],
  );
  const { rows } = await ctx.db.query<{ muted_until: Date | null; pinned: boolean }>(
    `UPDATE conversation_members SET
        muted_until = CASE WHEN $3::boolean THEN $4::timestamptz ELSE muted_until END,
        pinned = COALESCE($5::boolean, pinned)
      WHERE conversation_id = $1 AND user_id = $2 RETURNING muted_until, pinned`,
    [
      conversationId,
      userId,
      prefs.mutedUntil !== undefined,
      prefs.mutedUntil ?? null,
      prefs.pinned ?? null,
    ],
  );
  return { mutedUntil: rows[0]!.muted_until?.toISOString() ?? null, pinned: rows[0]!.pinned };
}

export { loadAccess, CONV_COLS };
