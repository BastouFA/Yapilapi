import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { AppError, conflict, forbidden, notFound, unauthenticated } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { redeemTicket, type Principal } from '../messaging/realtime.js';
import { loadAccess } from './access.js';
import { LIVE_EVENTS } from './events.js';
import { postMessage, react } from './interact.js';
import { joinSession, leaveSession } from './sessions.js';
import { REACTIONS } from './rules.js';

/** Tunables (module-level so tests can shorten them). */
export const liveSocketSettings = {
  heartbeatMs: 30_000,
  maxPayloadBytes: 4 * 1024,
  frameBudget: 60,
  maxSocketsPerUserPerLive: 3,
};

const frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('chat'), body: z.string().trim().min(1).max(500) }),
  z.object({
    type: z.literal('react'),
    kind: z.enum(REACTIONS),
    count: z.number().int().min(1).max(10).default(1),
  }),
]);

const principals = new WeakMap<
  FastifyRequest,
  Principal & { ageBand: 'teen' | 'adult'; liveId: string }
>();
const sockets = new Map<string, Set<WebSocket>>(); // `${liveId}:${userId}`

/** GET /v1/live/:id/ws?ticket=... — same single-use ticket scheme as /v1/ws (POST /v1/ws/ticket). */
export async function registerLiveSocket(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(websocket, { options: { maxPayload: liveSocketSettings.maxPayloadBytes } });

  app.get(
    '/v1/live/:id/ws',
    {
      websocket: true,
      // Runs BEFORE the upgrade: a rejected request gets a plain HTTP error and no socket.
      preValidation: async (req: FastifyRequest) => {
        if (!req.ws) throw notFound('Route');
        const origin = req.headers.origin;
        if (origin && !ctx.config.corsAllowedOrigins.includes(origin))
          throw new AppError('forbidden', 'Origin not allowed');
        if (ctx.config.RATE_LIMIT_ENABLED) {
          const r = await ctx.limiter.hit(`livews:${req.ip}`, 60, 60);
          if (!r.allowed) throw new AppError('rate_limited', 'Too many connection attempts');
        }
        const liveId = z.uuid().safeParse((req.params as { id?: unknown }).id);
        if (!liveId.success) throw notFound('Live session');
        const ticket = (req.query as { ticket?: unknown } | undefined)?.ticket;
        if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 200)
          throw unauthenticated('A valid ticket is required');
        const p = await redeemTicket(ctx, ticket);
        if (!p) throw unauthenticated('Ticket is invalid, expired or already used');
        await ctx.flags.require('LIVE', p.userId);
        const a = await loadAccess(ctx.db, p.userId, liveId.data); // 404 when hidden or banned
        if (a.session.status !== 'live')
          throw conflict('This session is not on air', {
            reason: 'not_live',
            status: a.session.status,
          });
        if (!a.entitled)
          throw new AppError('payment_required', 'You need a ticket for this live session', {
            reason: 'ticket_required',
          });
        const open = sockets.get(`${liveId.data}:${p.userId}`);
        if (open && open.size >= liveSocketSettings.maxSocketsPerUserPerLive)
          throw forbidden('Too many open connections');
        const u = (
          await ctx.db.query<{ age_band: 'teen' | 'adult' }>(
            'SELECT age_band FROM users WHERE id = $1',
            [p.userId],
          )
        ).rows[0]!;
        principals.set(req, { ...p, ageBand: u.age_band, liveId: liveId.data });
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const p = principals.get(req);
      if (!p) return void socket.close(1008, 'unauthenticated');
      void handle(ctx, socket, p);
    },
  );
}

async function blockedSet(ctx: AppContext, userId: string): Promise<Set<string>> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = $1 UNION SELECT blocker_id FROM user_blocks WHERE blocked_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.id));
}

async function handle(
  ctx: AppContext,
  socket: WebSocket,
  p: Principal & { ageBand: 'teen' | 'adult'; liveId: string },
): Promise<void> {
  const { userId, liveId } = p;
  const auth: AuthContext = {
    userId,
    sessionId: p.sessionId,
    platformRole: 'user',
    ageBand: p.ageBand,
    mfaVerified: false,
    emailVerified: false,
    via: 'bearer',
  };
  const key = `${liveId}:${userId}`;
  const set = sockets.get(key) ?? new Set<WebSocket>();
  set.add(socket);
  sockets.set(key, set);
  let closed = false;
  let alive = true;
  let unsub: (() => Promise<void>) | null = null;
  let blocked = new Set<string>();
  let budget = liveSocketSettings.frameBudget;

  const send = (f: Record<string, unknown>) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 1_048_576) return void socket.terminate(); // slow consumer: drop instead of buffering forever
    socket.send(JSON.stringify(f));
  };

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(budgetTimer);
    set.delete(socket);
    if (!set.size) {
      sockets.delete(key);
      // Presence follows the socket: the last socket of this person closing takes them out of the room (and the viewer count).
      await leaveSession(ctx, auth, liveId).catch(() => undefined);
    }
    if (unsub) await unsub().catch(() => undefined);
  };

  const heartbeat = async () => {
    if (closed) return;
    if (!alive) return void socket.terminate();
    alive = false;
    try {
      socket.ping();
    } catch {
      /* closing */
    }
    try {
      const s = await ctx.db.query(
        `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL AND u.status NOT IN ('suspended','deactivated','deleted')`,
        [p.sessionId],
      );
      if (!s.rowCount) return void socket.close(4401, 'session ended');
      const a = await loadAccess(ctx.db, userId, liveId).catch(() => null); // defence in depth: bans/blocks/visibility can change without an event reaching us
      if (!a || a.session.status !== 'live') return void socket.close(4404, 'gone');
      blocked = await blockedSet(ctx, userId);
    } catch (err) {
      ctx.log.warn({ err }, 'live socket heartbeat failed');
    }
  };
  const timer = setInterval(() => void heartbeat(), liveSocketSettings.heartbeatMs);
  timer.unref();
  const budgetTimer = setInterval(() => {
    budget = liveSocketSettings.frameBudget;
  }, 10_000);
  budgetTimer.unref();
  socket.on('pong', () => {
    alive = true;
  });
  socket.on('close', () => void cleanup());
  socket.on('error', () => socket.terminate());

  const ready = (async () => {
    blocked = await blockedSet(ctx, userId);
    const isTeam = (await loadAccess(ctx.db, userId, liveId)).role !== 'audience';
    unsub = await ctx.pubsub.subscribe(`live:${liveId}`, (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown> & { type?: unknown };
      if (typeof m.type !== 'string' || !LIVE_EVENTS.has(m.type)) return;
      if (m.type === 'chat.message') {
        const author = (m.message as { userId?: string | null } | undefined)?.userId;
        if (author && blocked.has(author)) return; // the people you blocked (or who blocked you) are invisible to you
      }
      if (m.type === 'participant.banned' || m.type === 'participant.muted') {
        if (m.userId === userId) {
          send(
            m.type === 'participant.banned'
              ? { type: 'removed', reason: 'banned' }
              : { type: 'muted', until: m.until ?? null },
          );
          if (m.type === 'participant.banned') socket.close(4403, 'banned');
        } else if (isTeam) send(m);
        return;
      }
      send({ ...m, liveId }); // every frame names its session, whichever module published it
      if (m.type === 'live.ended') socket.close(1000, 'live ended');
    });
    await joinSession(ctx, auth, liveId);
    send({ type: 'ready', liveId, heartbeatMs: liveSocketSettings.heartbeatMs });
  })().catch((err) => {
    if (err instanceof AppError) send({ type: 'error', code: err.code });
    socket.close(err instanceof AppError && err.code === 'not_found' ? 4404 : 1011, 'init failed');
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
      const parsed = frame.safeParse(json);
      if (!parsed.success) return send({ type: 'error', code: 'invalid_frame' });
      const f = parsed.data;
      if (f.type === 'ping') return send({ type: 'pong' });
      // Every frame goes through the same service rules as the REST endpoints (role, mute, slow mode, filters, moderation).
      if (f.type === 'chat') {
        await postMessage(ctx, auth, liveId, f.body);
        return;
      }
      await react(ctx, auth, liveId, { kind: f.kind, count: f.count });
    })().catch((err) => {
      if (err instanceof AppError)
        send({
          type: 'error',
          code: err.code,
          reason: (err.details as { reason?: string } | undefined)?.reason,
        });
      else ctx.log.warn({ err }, 'live socket frame failed');
    });
  });
}

/** Test/ops helper: open live sockets in this process. */
export const openLiveSocketCount = () => [...sockets.values()].reduce((n, s) => n + s.size, 0);
