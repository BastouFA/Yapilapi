import type { FastifyRequest } from 'fastify';
import { conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import { withTransaction, type Tx } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import {
  assertCanContactPeer,
  loadAccess,
  requireAccess,
  requireSend,
  type ConvAccess,
} from './access.js';
import { publishConv } from './events.js';
import { announceMessage, insertMessageTx, newRoomId } from './service.js';

/** WebRTC here is peer-to-peer mesh: every participant connects to every other one, so keep rooms small. */
export const MAX_CALL_PARTICIPANTS = 8;
/** A call nobody joined within this many seconds is marked 'missed'. Applied lazily on access (no background worker). */
export const RING_TIMEOUT_SEC = 60;

interface CallRow {
  id: string;
  conversation_id: string;
  initiator_id: string;
  kind: 'audio' | 'video';
  status: string;
  room_id: string;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}
const CALL_COLS =
  'id, conversation_id, initiator_id, kind, status, room_id, started_at, ended_at, created_at';

async function expireStale(ctx: AppContext, conversationId?: string): Promise<void> {
  await ctx.db.query(
    `UPDATE calls SET status = 'missed', ended_at = now()
      WHERE status = 'ringing' AND created_at < now() - make_interval(secs => $1)
        AND ($2::uuid IS NULL OR conversation_id = $2)
        AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = calls.id AND p.user_id <> calls.initiator_id AND p.joined_at IS NOT NULL)`,
    [RING_TIMEOUT_SEC, conversationId ?? null],
  );
}

export async function callView(ctx: AppContext, c: CallRow) {
  const { rows } = await ctx.db.query<{
    user_id: string;
    joined_at: Date | null;
    left_at: Date | null;
  }>(
    'SELECT user_id, joined_at, left_at FROM call_participants WHERE call_id = $1 ORDER BY joined_at NULLS LAST, user_id',
    [c.id],
  );
  return {
    id: c.id,
    conversationId: c.conversation_id,
    initiatorId: c.initiator_id,
    kind: c.kind,
    status: c.status,
    startedAt: c.started_at?.toISOString() ?? null,
    endedAt: c.ended_at?.toISOString() ?? null,
    createdAt: c.created_at.toISOString(),
    participants: rows.map((p) => ({
      userId: p.user_id,
      joinedAt: p.joined_at?.toISOString() ?? null,
      leftAt: p.left_at?.toISOString() ?? null,
      active: p.joined_at !== null && p.left_at === null,
    })),
    // Signaling only. Media flows peer-to-peer; ICE/TURN servers are configured by the client/deployment (see docs/architecture/messaging.md).
    signaling: {
      transport: 'websocket',
      path: '/v1/ws',
      frame: 'call.signal',
      media: 'webrtc-p2p-mesh',
      maxParticipants: MAX_CALL_PARTICIPANTS,
    },
  };
}

async function loadCall(
  ctx: AppContext,
  userId: string,
  callId: string,
): Promise<{ call: CallRow; access: ConvAccess }> {
  await expireStale(ctx);
  const { rows } = await ctx.db.query<CallRow>(`SELECT ${CALL_COLS} FROM calls WHERE id = $1`, [
    callId,
  ]);
  const call = rows[0];
  if (!call) throw notFound('Call');
  const access = await loadAccess(ctx.db, call.conversation_id, userId);
  if (!access) throw notFound('Call');
  return { call, access };
}

const isOpen = (c: CallRow) => c.status === 'ringing' || c.status === 'active';

async function callMessage(
  ctx: AppContext,
  tx: Tx,
  conversationId: string,
  userId: string,
  callId: string,
  kind: string,
) {
  return insertMessageTx(ctx, tx, {
    conversationId,
    senderId: userId,
    kind: 'call',
    body: '',
    metadata: { callId, callKind: kind },
  });
}

export async function startCall(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  kind: 'audio' | 'video',
  req?: FastifyRequest,
) {
  const access = await requireAccess(ctx.db, conversationId, userId);
  requireSend(access);
  await assertCanContactPeer(ctx.db, access, userId);
  await expireStale(ctx, conversationId);
  const open = await ctx.db.query(
    "SELECT 1 FROM calls WHERE conversation_id = $1 AND status IN ('ringing','active')",
    [conversationId],
  );
  if (open.rowCount) throw conflict('A call is already in progress in this conversation');

  // The partial unique index calls_one_open_per_conversation makes a concurrent double-start fail with 409.
  const { call, msg } = await withTransaction(ctx.db, async (tx) => {
    const c = await tx.query<CallRow>(
      `INSERT INTO calls (conversation_id, initiator_id, kind, room_id) VALUES ($1,$2,$3,$4) RETURNING ${CALL_COLS}`,
      [conversationId, userId, kind, newRoomId()],
    );
    await tx.query(
      'INSERT INTO call_participants (call_id, user_id, joined_at) VALUES ($1,$2,now())',
      [c.rows[0]!.id, userId],
    );
    const m = await callMessage(ctx, tx, conversationId, userId, c.rows[0]!.id, kind);
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'call.started',
        targetType: 'call',
        targetId: c.rows[0]!.id,
        metadata: { kind, conversationId },
      },
      req,
      tx,
    );
    return { call: c.rows[0]!, msg: m.row };
  });
  const view = await callView(ctx, call);
  publishConv(ctx, conversationId, { type: 'call.started', call: view });
  await announceMessage(ctx, msg, access);
  if (access.conv.kind !== 'community_channel') {
    const { rows } = await ctx.db.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2',
      [conversationId, userId],
    );
    for (const r of rows)
      await notify(ctx, {
        userId: r.user_id,
        kind: 'call',
        actorId: userId,
        targetType: 'call',
        targetId: call.id,
        data: { conversationId, callKind: kind },
      }).catch(() => undefined);
  }
  return view;
}

export async function joinCall(ctx: AppContext, userId: string, callId: string) {
  const { call, access } = await loadCall(ctx, userId, callId);
  if (!isOpen(call)) throw conflict('This call has ended');
  await assertCanContactPeer(ctx.db, access, userId);
  const updated = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    const cnt = await tx.query<{ n: number; me: boolean }>(
      `SELECT count(*)::int AS n, COALESCE(bool_or(user_id = $2), false) AS me FROM call_participants WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL`,
      [callId, userId],
    );
    if (!cnt.rows[0]!.me && cnt.rows[0]!.n >= MAX_CALL_PARTICIPANTS)
      throw conflict(`Calls are limited to ${MAX_CALL_PARTICIPANTS} participants`);
    await tx.query(
      `INSERT INTO call_participants (call_id, user_id, joined_at) VALUES ($1,$2,now())
       ON CONFLICT (call_id, user_id) DO UPDATE SET joined_at = COALESCE(call_participants.joined_at, now()), left_at = NULL`,
      [callId, userId],
    );
    const r = await tx.query<CallRow>(
      `UPDATE calls SET status = 'active', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status IN ('ringing','active') AND $2::uuid <> initiator_id RETURNING ${CALL_COLS}`,
      [callId, userId],
    );
    if (r.rows[0]) return r.rows[0];
    return (await tx.query<CallRow>(`SELECT ${CALL_COLS} FROM calls WHERE id = $1`, [callId]))
      .rows[0]!;
  });
  const view = await callView(ctx, updated);
  publishConv(ctx, updated.conversation_id, { type: 'call.updated', call: view });
  return view;
}

async function finishIfEmpty(ctx: AppContext, tx: Tx, call: CallRow): Promise<CallRow> {
  const left = await tx.query(
    'SELECT 1 FROM call_participants WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL LIMIT 1',
    [call.id],
  );
  if (left.rowCount) return call;
  const r = await tx.query<CallRow>(
    `UPDATE calls SET status = CASE WHEN started_at IS NULL THEN 'missed' ELSE 'ended' END, ended_at = now() WHERE id = $1 AND status IN ('ringing','active') RETURNING ${CALL_COLS}`,
    [call.id],
  );
  return r.rows[0] ?? call;
}

export async function leaveCall(ctx: AppContext, userId: string, callId: string) {
  const { call } = await loadCall(ctx, userId, callId);
  const updated = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    const r = await tx.query(
      'UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2 AND joined_at IS NOT NULL AND left_at IS NULL',
      [callId, userId],
    );
    if (!r.rowCount) return call;
    return finishIfEmpty(ctx, tx, call);
  });
  const fresh =
    (await ctx.db.query<CallRow>(`SELECT ${CALL_COLS} FROM calls WHERE id = $1`, [callId]))
      .rows[0] ?? updated;
  const view = await callView(ctx, fresh);
  publishConv(ctx, fresh.conversation_id, { type: 'call.updated', call: view });
  return view;
}

export async function declineCall(ctx: AppContext, userId: string, callId: string) {
  const { call, access } = await loadCall(ctx, userId, callId);
  if (call.initiator_id === userId) throw invalid('You started this call; use leave or end');
  if (call.status !== 'ringing') return callView(ctx, call);
  if (access.conv.kind === 'direct') {
    await ctx.db.query(
      `UPDATE calls SET status = 'declined', ended_at = now() WHERE id = $1 AND status = 'ringing'`,
      [callId],
    );
    await ctx.db.query(
      'UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL',
      [callId],
    );
  }
  // In groups one member declining does not end the call for everyone else.
  const fresh = (
    await ctx.db.query<CallRow>(`SELECT ${CALL_COLS} FROM calls WHERE id = $1`, [callId])
  ).rows[0]!;
  const view = await callView(ctx, fresh);
  publishConv(ctx, fresh.conversation_id, { type: 'call.updated', call: view, declinedBy: userId });
  return view;
}

export async function endCall(ctx: AppContext, userId: string, callId: string) {
  const { call, access } = await loadCall(ctx, userId, callId);
  if (call.initiator_id !== userId && !access.canManage)
    throw forbidden(
      'Only the person who started the call or a group admin can end it for everyone',
    );
  if (!isOpen(call)) return callView(ctx, call);
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE calls SET status = 'ended', ended_at = now(), started_at = COALESCE(started_at, now()) WHERE id = $1 AND status IN ('ringing','active')`,
      [callId],
    );
    await tx.query(
      'UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL',
      [callId],
    );
  });
  const fresh = (
    await ctx.db.query<CallRow>(`SELECT ${CALL_COLS} FROM calls WHERE id = $1`, [callId])
  ).rows[0]!;
  const view = await callView(ctx, fresh);
  publishConv(ctx, fresh.conversation_id, { type: 'call.updated', call: view });
  return view;
}

export async function getCall(ctx: AppContext, userId: string, callId: string) {
  const { call } = await loadCall(ctx, userId, callId);
  return callView(ctx, call);
}

export async function listCalls(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  activeOnly: boolean,
) {
  await requireAccess(ctx.db, conversationId, userId);
  await expireStale(ctx, conversationId);
  const { rows } = await ctx.db.query<CallRow>(
    `SELECT ${CALL_COLS} FROM calls WHERE conversation_id = $1 AND ($2::boolean IS FALSE OR status IN ('ringing','active')) ORDER BY created_at DESC LIMIT 20`,
    [conversationId, activeOnly],
  );
  return { items: await Promise.all(rows.map((c) => callView(ctx, c))) };
}

/**
 * May `fromUser` relay a signaling frame to `toUser` for this call? Both must currently be joined participants of an
 * open call, and the sender must still have access to the conversation (e.g. not blocked/removed since).
 */
export async function canRelaySignal(
  ctx: AppContext,
  callId: string,
  fromUser: string,
  toUser: string,
): Promise<boolean> {
  if (fromUser === toUser) return false;
  const { rows } = await ctx.db.query<{ conversation_id: string }>(
    `SELECT c.conversation_id FROM calls c
       JOIN call_participants a ON a.call_id = c.id AND a.user_id = $2 AND a.joined_at IS NOT NULL AND a.left_at IS NULL
       JOIN call_participants b ON b.call_id = c.id AND b.user_id = $3 AND b.joined_at IS NOT NULL AND b.left_at IS NULL
      WHERE c.id = $1 AND c.status IN ('ringing','active')`,
    [callId, fromUser, toUser],
  );
  if (!rows[0]) return false;
  return (
    (await loadAccess(ctx.db, rows[0].conversation_id, fromUser)) !== null &&
    (await loadAccess(ctx.db, rows[0].conversation_id, toUser)) !== null
  );
}

/** Deletion hook helper: a deleted user's open calls end, and they leave the ones they joined. */
export async function purgeUserFromCalls(tx: Tx, userId: string): Promise<void> {
  await tx.query(
    'UPDATE call_participants SET left_at = now() WHERE user_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL',
    [userId],
  );
  await tx.query(`UPDATE calls SET status = CASE WHEN started_at IS NULL THEN 'missed' ELSE 'ended' END, ended_at = now()
                   WHERE status IN ('ringing','active') AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = calls.id AND p.joined_at IS NOT NULL AND p.left_at IS NULL)`);
}
