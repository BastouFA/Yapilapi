import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { WATCH_MAX_MEMBERS, WATCH_REACTIONS, type WatchSkipReason } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { notify } from '../lib/services.ts';
import { isBlockedEitherWay } from '../lib/users.ts';
import {
  activeSummary,
  addToQueue,
  advance,
  chatMembers,
  endSession,
  leaveSession,
  publishPlayback,
  publishUpdated,
  sessionFor,
  watchingIds,
} from '../lib/watch.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import type { ChatHelpers } from './chat-polls-lists.ts';

const idParam = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const postIds = z.array(z.string().uuid()).max(10);
/** A moment on the server's clock, as the player estimated it; ignored when it's far from the server's own. */
const atServer = z.number().int().nonnegative().optional();

const controlSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('play'),
    positionMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000)
      .optional(),
    atServerMs: atServer,
  }),
  z.object({
    action: z.literal('pause'),
    positionMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000)
      .optional(),
    atServerMs: atServer,
  }),
  z.object({
    action: z.literal('seek'),
    positionMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000),
    atServerMs: atServer,
  }),
  /** Next item. `fromItemId` makes it happen once when several players reach the end together. */
  z.object({ action: z.literal('next'), fromItemId: z.string().uuid().optional() }),
  /** Straight to one queued item. */
  z.object({ action: z.literal('jump'), itemId: z.string().uuid() }),
]);

const heartbeatSchema = z.object({
  /** The host's player: where it is, on which item, at which state. Others send nothing. */
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3_600_000)
    .optional(),
  itemId: z.string().uuid().nullable().optional(),
  seq: z.number().int().nonnegative().optional(),
  atServerMs: atServer,
});

const tooBig = () => new AppError(400, 'watch_too_many', `Watch together is for chats of up to ${WATCH_MAX_MEMBERS} people, you included.`);
const notWatching = () => new AppError(409, 'watch_not_watching', 'Join to do that.');
const ended = () => new AppError(410, 'watch_ended', 'This watch together session has ended.');

/** A moment the player gave, or now when it's missing or more than 10 seconds from the server's clock. */
function momentOf(atServerMs: number | undefined): Date {
  const now = Date.now();
  return atServerMs !== undefined && Math.abs(atServerMs - now) <= 10_000 ? new Date(atServerMs) : new Date(now);
}

/**
 * Watch together: people in a one-to-one chat or a group of up to 8 watch reels and video posts
 * at the same time. Only people in the chat see a session; only people watching get its playback,
 * reactions and changes. The side chat is the conversation itself (messages are sent as usual).
 */
export function registerWatch(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };

  /** A session for someone in its chat, or not found (nothing is revealed to anyone else). */
  async function sessionRow(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT s.* FROM watch_sessions s
       WHERE s.id = $1 AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = s.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL)`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Watch together session');
    return rows[0] as Record<string, any>;
  }

  async function assertWatching(sessionId: string, userId: string) {
    const r = await db.query(`SELECT 1 FROM watch_participants WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`, [sessionId, userId]);
    if (!r.rowCount) throw notWatching();
  }

  /** Watch together works in one-to-one chats and groups of up to 8, where nobody blocked anyone they'd watch with one-to-one. */
  async function assertWatchableChat(conversationId: string, userId: string) {
    await h.assertMember(conversationId, userId);
    const kind = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [conversationId])).rows[0]?.kind;
    if (kind !== 'direct' && kind !== 'group') throw new AppError(400, 'watch_not_here', 'Watch together works in one-to-one chats and groups.');
    const members = await chatMembers(db, conversationId);
    if (members.length > WATCH_MAX_MEMBERS) throw tooBig();
    if (kind === 'direct') {
      const other = members.find((m) => m !== userId);
      if (!other || (await isBlockedEitherWay(db, userId, other))) throw new AppError(403, 'forbidden', "You can't watch with this person.");
    }
    return members;
  }

  async function join(sessionId: string, userId: string) {
    await db.query(
      `INSERT INTO watch_participants (session_id, user_id) VALUES ($1,$2)
       ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, last_seen_at = now(), joined_at = CASE WHEN watch_participants.left_at IS NULL THEN watch_participants.joined_at ELSE now() END`,
      [sessionId, userId],
    );
  }

  /** Start watching together in a chat, or join the session already running there. `postIds` go in the queue. */
  app.post('/v1/watch', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(z.object({ conversationId: z.string().uuid(), postIds: postIds.default([]) }), req.body);
    const members = await assertWatchableChat(input.conversationId, u.id);
    const run = () =>
      tx(db, async (c) => {
        const existing = (await c.query(`SELECT id FROM watch_sessions WHERE conversation_id = $1 AND status = 'active' FOR UPDATE`, [input.conversationId]))
          .rows[0];
        let sessionId: string;
        let created = false;
        let lineId: string | null = null;
        if (existing) sessionId = existing.id;
        else {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO watch_sessions (conversation_id, started_by, host_id, state_by) VALUES ($1,$2,$2,$2) RETURNING id`,
            [input.conversationId, u.id],
          );
          sessionId = rows[0]!.id;
          created = true;
          // A line in the chat: "{name} started watching together", with a way to join.
          const line = await c.query<{ id: string }>(
            `INSERT INTO messages (conversation_id, sender_id, body, kind, meta) VALUES ($1,$2,'','system',$3) RETURNING id`,
            [input.conversationId, u.id, { type: 'watch', sessionId }],
          );
          lineId = line.rows[0]!.id;
          await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [input.conversationId]);
        }
        await c.query(
          `INSERT INTO watch_participants (session_id, user_id) VALUES ($1,$2)
         ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, last_seen_at = now()`,
          [sessionId, u.id],
        );
        const q = await addToQueue(c, sessionId, input.conversationId, u.id, input.postIds, true);
        return { sessionId, created, lineId, ...q };
      });
    // Two people starting in the same chat at the same moment: the second joins the first one's session.
    const out = await run().catch((e: { code?: string }) => (e.code === '23505' ? run() : Promise.reject(e)));
    if (out.created) {
      const others = await h.notBlocking(
        u.id,
        members.filter((m) => m !== u.id),
      );
      if (out.lineId)
        for (const m of [u.id, ...others]) {
          const line = await h.loadMessage(out.lineId, m);
          if (line) await ctx.realtime.publish([m], { type: 'message.created', data: line });
        }
      await ctx.realtime.publish([u.id, ...others], {
        type: 'watch.started',
        data: { sessionId: out.sessionId, conversationId: input.conversationId, startedBy: u.id },
      });
      for (const m of others)
        await notify(db, ctx.realtime, {
          userId: m,
          category: 'messages',
          type: 'watch_invite',
          actorId: u.id,
          entityType: 'watch',
          entityId: out.sessionId,
          data: { conversationId: input.conversationId },
        });
    } else await publishUpdated(deps, out.sessionId, out.added.length ? 'queue' : 'people');
    if (out.changedPlayback) await publishPlayback(deps, out.sessionId);
    reply.code(out.created ? 201 : 200);
    return { session: await sessionFor(db, out.sessionId, u.id), created: out.created, added: out.added, skipped: out.skipped };
  });

  /** The session running in a chat, if any (people in the chat only). */
  app.get('/v1/conversations/:id/watch', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await h.assertMember(id, u.id);
    return { session: await activeSummary(db, id, u.id) };
  });

  app.get('/v1/watch/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await sessionRow(id, u.id);
    return { session: await sessionFor(db, id, u.id) };
  });

  app.post('/v1/watch/:id/join', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await sessionRow(id, u.id);
    if (s.status !== 'active') throw ended();
    await assertWatchableChat(s.conversation_id, u.id);
    const before = await watchingIds(db, id);
    await join(id, u.id);
    if (!s.host_id) await db.query(`UPDATE watch_sessions SET host_id = $2 WHERE id = $1 AND host_id IS NULL`, [id, u.id]);
    if (!before.includes(u.id)) await publishUpdated(deps, id, 'people');
    return { session: await sessionFor(db, id, u.id) };
  });

  /** Leave anytime. When the host leaves, the person watching longest becomes host; when the last person leaves, it ends. */
  app.post('/v1/watch/:id/leave', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await sessionRow(id, u.id);
    await leaveSession(deps, id, u.id);
    return { ok: true };
  });

  /** End it for everyone: the host only. */
  app.post('/v1/watch/:id/end', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await sessionRow(id, u.id);
    if (s.host_id !== u.id) throw new AppError(403, 'forbidden', 'Only the host can end it for everyone. You can leave anytime.');
    await endSession(deps, id);
    return { ok: true };
  });

  /** Add reels or video posts. Only what everyone in the chat can see goes in; the rest comes back as skipped, with why. */
  app.post('/v1/watch/:id/queue', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ postIds: postIds.min(1) }), req.body);
    const s = await sessionRow(id, u.id);
    if (s.status !== 'active') throw ended();
    await assertWatching(id, u.id);
    const out = await tx(db, (c) => addToQueue(c, id, s.conversation_id, u.id, input.postIds));
    if (out.added.length) await publishUpdated(deps, id, 'queue');
    if (out.changedPlayback) await publishPlayback(deps, id);
    return { session: await sessionFor(db, id, u.id), added: out.added, skipped: out.skipped };
  });

  /** Take an item out of the queue: whoever added it, or the host. */
  app.delete('/v1/watch/:id/queue/:itemId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const s = await sessionRow(id, u.id);
    if (s.status !== 'active') throw ended();
    await assertWatching(id, u.id);
    const r = await db.query(
      `UPDATE watch_queue_items SET status = 'removed' WHERE id = $1 AND session_id = $2 AND status = 'queued' AND (added_by = $3 OR $4) RETURNING id`,
      [itemId, id, u.id, s.host_id === u.id],
    );
    if (!r.rowCount) throw notFound('Queue item');
    await publishUpdated(deps, id, 'queue');
    return { session: await sessionFor(db, id, u.id) };
  });

  /**
   * Play, pause, seek, next or jump: anyone watching can. The new playback goes to everyone
   * watching with a higher `seq`. Positions are taken as of `atServerMs` (the player's estimate
   * of the server's clock when it read its position), so the time the request took is counted.
   */
  app.post('/v1/watch/:id/control', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(controlSchema, req.body);
    await sessionRow(id, u.id);
    await assertWatching(id, u.id);
    const out = await tx(db, async (c) => {
      const s = (await c.query(`SELECT * FROM watch_sessions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (s.status !== 'active') throw ended();
      let skipped: WatchSkipReason[] = [];
      if (input.action === 'next' || input.action === 'jump') {
        // Several players reaching the end together move on once.
        if (input.action === 'next' && input.fromItemId && input.fromItemId !== s.current_item_id) return { skipped, changed: false };
        const r = await advance(c, s, u.id, input.action === 'jump' ? input.itemId : undefined);
        if (input.action === 'jump' && !r.moved && !r.skipped.length) throw notFound('Queue item');
        skipped = r.skipped;
        return { skipped, changed: r.moved };
      }
      if (!s.current_item_id) throw new AppError(409, 'watch_nothing_on', 'Add something to watch first.');
      const at = momentOf(input.atServerMs);
      const now = Date.now();
      // Where it is at `at`: the given position, or where the shared playback says.
      const expected = s.playing ? Number(s.position_ms) + Math.max(0, at.getTime() - s.state_at.getTime()) : Number(s.position_ms);
      const position = input.positionMs ?? expected;
      const playing = input.action === 'play' ? true : input.action === 'pause' ? false : s.playing;
      // Stored as of now: a playing video has moved on since `at`.
      const positionNow = playing ? position + Math.max(0, now - at.getTime()) : position;
      await c.query(
        `UPDATE watch_sessions SET playing = $2, position_ms = $3, state_at = to_timestamp($4 / 1000.0), state_seq = state_seq + 1, state_by = $5 WHERE id = $1`,
        [id, playing, Math.round(positionNow), now, u.id],
      );
      return { skipped, changed: true };
    });
    const playback = out.changed ? await publishPlayback(deps, id, { skipped: out.skipped }) : null;
    if (out.skipped.length || (out.changed && (input.action === 'next' || input.action === 'jump'))) await publishUpdated(deps, id, 'queue');
    return { playback: playback ?? (await sessionFor(db, id, u.id))!.playback, skipped: out.skipped, serverTime: Date.now() };
  });

  /**
   * Every few seconds from each player: still here. The host's also carries where its player is
   * (the clock everyone follows), accepted only for the current item and state.
   */
  app.post('/v1/watch/:id/heartbeat', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(heartbeatSchema, req.body);
    const s = await sessionRow(id, u.id);
    if (s.status !== 'active') throw ended();
    const seen = await db.query(`UPDATE watch_participants SET last_seen_at = now() WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`, [id, u.id]);
    if (!seen.rowCount) throw notWatching();
    let updated = false;
    if (
      s.host_id === u.id &&
      s.playing &&
      input.positionMs !== undefined &&
      input.seq === Number(s.state_seq) &&
      (input.itemId ?? null) === (s.current_item_id ?? null)
    ) {
      const at = momentOf(input.atServerMs);
      const now = Date.now();
      const r = await db.query(
        `UPDATE watch_sessions SET position_ms = $2, state_at = to_timestamp($3 / 1000.0) WHERE id = $1 AND state_seq = $4 AND playing`,
        [id, Math.round(input.positionMs + Math.max(0, now - at.getTime())), now, input.seq],
      );
      updated = !!r.rowCount;
    }
    if (updated) await publishPlayback(deps, id);
    return { ok: true, serverTime: Date.now() };
  });

  /** A reaction floating over the video for everyone watching (icon names, never emoji). */
  app.post('/v1/watch/:id/reactions', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(WATCH_REACTIONS) }), req.body);
    const s = await sessionRow(id, u.id);
    if (s.status !== 'active') throw ended();
    await assertWatching(id, u.id);
    const watching = await watchingIds(db, id);
    // People who blocked the sender don't see their reactions.
    await ctx.realtime.publish(await h.notBlocking(u.id, watching), { type: 'watch.reaction', data: { sessionId: id, userId: u.id, kind } });
    return { ok: true };
  });
}
