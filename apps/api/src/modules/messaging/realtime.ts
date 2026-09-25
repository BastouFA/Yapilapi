import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { randomToken, sha256Hex } from '@yapilapi/security';
import { AppError, forbidden, notFound, unauthenticated } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { route } from '../../lib/route.js';
import { loadAccess } from './access.js';
import { canRelaySignal } from './calls.js';
import { publishConv, publishUser } from './events.js';

export const TICKET_TTL_SEC = 60;

/** Tunables (module-level so tests can shorten them; production uses the defaults). */
export const realtimeSettings = {
  heartbeatMs: 30_000,
  maxPayloadBytes: 16 * 1024,
  maxSocketsPerUser: 8,
  maxSubscriptionsPerSocket: 500,
  /** Frames a client may send per 10 s before the socket is closed. */
  frameBudget: 200,
  typingThrottleMs: 1_500,
};

const CONV_EVENTS = new Set([
  'message.new',
  'message.updated',
  'message.deleted',
  'conversation.read',
  'conversation.updated',
  'conversation.member.added',
  'conversation.member.removed',
  'conversation.member.updated',
  'typing',
  'call.started',
  'call.updated',
  'plan.updated',
]);
const USER_EVENTS = new Set([
  'notification',
  'call.signal',
  'conversation.added',
  'conversation.removed',
]);

const clientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe'), conversationId: z.uuid() }),
  z.object({ type: z.literal('unsubscribe'), conversationId: z.uuid() }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.uuid(),
    state: z.enum(['start', 'stop']).default('start'),
  }),
  z.object({
    type: z.literal('call.signal'),
    callId: z.uuid(),
    to: z.uuid(),
    signal: z.object({ kind: z.enum(['offer', 'answer', 'ice', 'bye']), data: z.unknown() }),
  }),
]);

export interface Principal {
  userId: string;
  sessionId: string;
}
const principals = new WeakMap<FastifyRequest, Principal>();
const socketsByUser = new Map<string, Set<WebSocket>>();

/** Redeem a single-use ticket. Returns null for unknown, used, expired tickets or for a session/user that is no longer valid. */
export async function redeemTicket(ctx: AppContext, ticket: string): Promise<Principal | null> {
  const { rows } = await ctx.db.query<{ user_id: string; session_id: string }>(
    `UPDATE ws_tickets t SET used_at = now()
       FROM sessions s, users u
      WHERE t.ticket_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
        AND s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.id = t.user_id AND u.deleted_at IS NULL AND u.status NOT IN ('suspended','deactivated','deleted')
      RETURNING t.user_id, t.session_id`,
    [sha256Hex(ticket)],
  );
  return rows[0] ? { userId: rows[0].user_id, sessionId: rows[0].session_id } : null;
}

/** Which of these conversations may the user still read? (direct/group membership + blocks; channels via community membership.) */
async function stillAllowed(ctx: AppContext, userId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const ok = new Set<string>();
  const { rows } = await ctx.db.query<{ id: string; kind: string }>(
    `SELECT c.id, c.kind FROM conversations c WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  const simple = rows.filter((r) => r.kind !== 'community_channel').map((r) => r.id);
  if (simple.length) {
    const r = await ctx.db.query<{ id: string }>(
      `SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
        WHERE c.id = ANY($2::uuid[]) AND NOT (c.kind = 'direct' AND EXISTS (
              SELECT 1 FROM conversation_members o JOIN user_blocks b ON (b.blocker_id = $1 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $1)
               WHERE o.conversation_id = c.id AND o.user_id <> $1))`,
      [userId, simple],
    );
    for (const x of r.rows) ok.add(x.id);
  }
  for (const c of rows.filter((r) => r.kind === 'community_channel'))
    if (await loadAccess(ctx.db, c.id, userId)) ok.add(c.id);
  return ok;
}

export async function registerRealtime(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(websocket, { options: { maxPayload: realtimeSettings.maxPayloadBytes } });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/ws/ticket',
    summary: 'Get a single-use, 60-second ticket to open the realtime WebSocket',
    tags: ['messaging'],
    auth: 'user',
    rateLimit: { limit: 30, windowSec: 60, by: 'user' },
    handler: async ({ auth, reply }) => {
      const ticket = randomToken(32);
      await ctx.db.query("DELETE FROM ws_tickets WHERE expires_at < now() - interval '1 hour'");
      await ctx.db.query(
        `INSERT INTO ws_tickets (ticket_hash, user_id, session_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4))`,
        [sha256Hex(ticket), auth.userId, auth.sessionId, TICKET_TTL_SEC],
      );
      void reply.header('cache-control', 'no-store');
      return { ticket, expiresInSec: TICKET_TTL_SEC, url: `/v1/ws?ticket=${ticket}` };
    },
  });

  app.get(
    '/v1/ws',
    {
      websocket: true,
      // Runs BEFORE the upgrade is accepted: a rejected request gets a plain HTTP error and no socket.
      preValidation: async (req: FastifyRequest) => {
        if (!req.ws) throw notFound('Route');
        const origin = req.headers.origin;
        if (origin && !ctx.config.corsAllowedOrigins.includes(origin))
          throw new AppError('forbidden', 'Origin not allowed');
        if (ctx.config.RATE_LIMIT_ENABLED) {
          const r = await ctx.limiter.hit(`ws:${req.ip}`, 60, 60);
          if (!r.allowed) throw new AppError('rate_limited', 'Too many connection attempts');
        }
        const ticket = (req.query as { ticket?: unknown } | undefined)?.ticket;
        if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 200)
          throw unauthenticated('A valid ticket is required');
        const p = await redeemTicket(ctx, ticket);
        if (!p) throw unauthenticated('Ticket is invalid, expired or already used');
        const existing = socketsByUser.get(p.userId);
        if (existing && existing.size >= realtimeSettings.maxSocketsPerUser)
          throw forbidden('Too many open connections');
        principals.set(req, p);
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const p = principals.get(req);
      if (!p) return void socket.close(1008, 'unauthenticated');
      void handleConnection(ctx, socket, p);
    },
  );
}

async function handleConnection(ctx: AppContext, socket: WebSocket, p: Principal): Promise<void> {
  const { userId } = p;
  const subs = new Map<string, () => Promise<void>>();
  let userUnsub: (() => Promise<void>) | null = null;
  let closed = false;
  let alive = true;
  const typingAt = new Map<string, number>();
  let budget = realtimeSettings.frameBudget;

  const set = socketsByUser.get(userId) ?? new Set<WebSocket>();
  set.add(socket);
  socketsByUser.set(userId, set);

  const send = (frame: Record<string, unknown>) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 1_048_576) return void socket.terminate(); // slow consumer: drop instead of buffering forever
    socket.send(JSON.stringify(frame));
  };

  const subscribeConv = async (conversationId: string): Promise<void> => {
    if (closed || subs.has(conversationId)) return;
    if (subs.size >= realtimeSettings.maxSubscriptionsPerSocket)
      throw new AppError('forbidden', 'Too many subscriptions');
    subs.set(conversationId, async () => undefined); // reserve to avoid double subscription races
    try {
      const unsub = await ctx.pubsub.subscribe(`conv:${conversationId}`, (msg) => {
        if (!msg || typeof msg !== 'object') return;
        const m = msg as Record<string, unknown>;
        if (typeof m.type !== 'string' || !CONV_EVENTS.has(m.type)) return;
        if (m.type === 'typing' && m.userId === userId) return; // no echo
        send(m);
      });
      if (closed || !subs.has(conversationId)) await unsub();
      else subs.set(conversationId, unsub);
    } catch (err) {
      subs.delete(conversationId);
      throw err;
    }
  };
  const unsubscribeConv = async (conversationId: string) => {
    const u = subs.get(conversationId);
    subs.delete(conversationId);
    typingAt.delete(conversationId);
    if (u) await u().catch(() => undefined);
  };

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    set.delete(socket);
    if (!set.size) socketsByUser.delete(userId);
    const all = [...subs.values(), ...(userUnsub ? [userUnsub] : [])];
    subs.clear();
    await Promise.allSettled(all.map((u) => u()));
  };

  const heartbeat = async () => {
    if (closed) return;
    if (!alive) return void socket.terminate();
    alive = false;
    try {
      socket.ping();
    } catch {
      /* socket already closing */
    }
    try {
      const s = await ctx.db.query(
        "SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL AND u.status NOT IN ('suspended','deactivated','deleted')",
        [p.sessionId],
      );
      if (!s.rowCount) return void socket.close(4401, 'session ended');
      // Defence in depth: membership may have changed without an event reaching us (missed pub/sub message, block).
      const ids = [...subs.keys()];
      const ok = await stillAllowed(ctx, userId, ids);
      for (const id of ids)
        if (!ok.has(id)) {
          await unsubscribeConv(id);
          send({ type: 'unsubscribed', conversationId: id, reason: 'access_revoked' });
        }
    } catch (err) {
      ctx.log.warn({ err }, 'realtime heartbeat check failed');
    }
  };
  const timer = setInterval(() => void heartbeat(), realtimeSettings.heartbeatMs);
  timer.unref();
  const budgetTimer = setInterval(() => {
    budget = realtimeSettings.frameBudget;
  }, 10_000);
  budgetTimer.unref();

  socket.on('pong', () => {
    alive = true;
  });
  socket.on('close', () => {
    clearInterval(budgetTimer);
    void cleanup();
  });
  socket.on('error', () => {
    socket.terminate();
  });

  const ready = (async () => {
    // user channel: notifications (bridged from lib/notify.ts), membership changes, call signaling addressed to this user.
    userUnsub = await ctx.pubsub.subscribe(`user:${userId}`, (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      if (typeof m.type !== 'string' || !USER_EVENTS.has(m.type)) return;
      if (m.type === 'conversation.added' && typeof m.conversationId === 'string') {
        const id = m.conversationId;
        void loadAccess(ctx.db, id, userId)
          .then((a) => (a ? subscribeConv(id).then(() => send(m)) : undefined))
          .catch(() => undefined);
        return;
      }
      if (m.type === 'conversation.removed' && typeof m.conversationId === 'string') {
        void unsubscribeConv(m.conversationId).then(() => send(m));
        return;
      }
      send(m);
    });
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT c.id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = $1 AND cm.left_at IS NULL AND c.kind IN ('direct','group')
        ORDER BY c.last_message_at DESC NULLS LAST LIMIT $2`,
      [userId, realtimeSettings.maxSubscriptionsPerSocket],
    );
    const ok = await stillAllowed(
      ctx,
      userId,
      rows.map((r) => r.id),
    ); // drops DMs with blocked people
    for (const id of ok) await subscribeConv(id);
    send({
      type: 'ready',
      userId,
      subscriptions: subs.size,
      heartbeatMs: realtimeSettings.heartbeatMs,
    });
  })().catch((err) => {
    ctx.log.warn({ err }, 'realtime init failed');
    socket.close(1011, 'init failed');
  });

  socket.on('message', (data, isBinary) => {
    void (async () => {
      await ready;
      if (closed) return;
      if (isBinary) return void socket.close(1003, 'text frames only');
      if (--budget < 0) return void socket.close(1008, 'rate limit');
      let json: unknown;
      try {
        json = JSON.parse((data as Buffer).toString('utf8'));
      } catch {
        return send({ type: 'error', code: 'invalid_frame' });
      }
      const parsed = clientFrame.safeParse(json);
      if (!parsed.success) return send({ type: 'error', code: 'invalid_frame' });
      const f = parsed.data;
      switch (f.type) {
        case 'ping':
          return send({ type: 'pong' });
        case 'subscribe': {
          const a = await loadAccess(ctx.db, f.conversationId, userId);
          if (!a)
            return send({ type: 'error', code: 'not_found', conversationId: f.conversationId });
          await subscribeConv(f.conversationId);
          return send({ type: 'subscribed', conversationId: f.conversationId });
        }
        case 'unsubscribe':
          await unsubscribeConv(f.conversationId);
          return send({ type: 'unsubscribed', conversationId: f.conversationId });
        case 'typing': {
          if (!subs.has(f.conversationId))
            return send({
              type: 'error',
              code: 'not_subscribed',
              conversationId: f.conversationId,
            });
          const now = Date.now();
          if (
            f.state === 'start' &&
            now - (typingAt.get(f.conversationId) ?? 0) < realtimeSettings.typingThrottleMs
          )
            return;
          typingAt.set(f.conversationId, now);
          // Access is re-checked (cheap) so a user who lost send permission cannot spam typing indicators.
          const a = await loadAccess(ctx.db, f.conversationId, userId);
          if (!a?.canSend)
            return send({ type: 'error', code: 'forbidden', conversationId: f.conversationId });
          return publishConv(ctx, f.conversationId, { type: 'typing', userId, state: f.state });
        }
        case 'call.signal': {
          if (JSON.stringify(f.signal).length > 12_000)
            return send({ type: 'error', code: 'signal_too_large' });
          if (!(await canRelaySignal(ctx, f.callId, userId, f.to)))
            return send({ type: 'error', code: 'signal_rejected', callId: f.callId });
          // `from` is stamped by the server; a client can never impersonate another participant.
          return publishUser(ctx, f.to, {
            type: 'call.signal',
            callId: f.callId,
            from: userId,
            signal: f.signal,
          });
        }
      }
    })().catch((err) => {
      if (err instanceof AppError) send({ type: 'error', code: err.code });
      else ctx.log.warn({ err }, 'realtime frame failed');
    });
  });
}

/** Test/ops helper: number of open realtime sockets in this process. */
export const openSocketCount = () => [...socketsByUser.values()].reduce((a, s) => a + s.size, 0);
