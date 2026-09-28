import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  LOCATION_APPROXIMATE_METRES,
  LOCATION_REQUEST_MINUTES,
  LOCATION_UPDATE_SECONDS,
  locationPointSchema,
  pointFor,
  startLocationSchema,
  type LocationPrecision,
  type MessageSystemInfo,
} from '@yapilapi/shared';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import { enqueue } from '../lib/jobs.ts';
import { LOCATION_EXPIRE_JOB, locationReaders, publishShare, SHARE_COLS, shareById, presentShares, stopShare, type ShareRow } from '../lib/location.ts';
import { notify } from '../lib/services.ts';
import { assertMessagePace } from '../lib/spam.ts';
import { ageOf, areFriends } from '../lib/users.ts';
import { me, requireAuth, type AuthUser } from '../plugins/auth.ts';
import type { ChatHelpers } from './chat-polls-lists.ts';

const idParam = z.object({ id: z.string().uuid() });

const MINOR_SHARE =
  'To keep younger people safe, sharing where you are is only for friends when someone in the chat is under 18. Everyone here needs to be friends with you.';

/**
 * Sharing where you are with a chat (one-to-one and groups): live for 15 minutes, an hour or 8 hours,
 * or a pin sent once. The server keeps only the latest point of each share and deletes it when the
 * share ends. Points go to the chat's members as `location.updated` (never to anyone else), at most
 * one every LOCATION_UPDATE_SECONDS per share. Coordinates travel only in request bodies (never in
 * URLs, so request logs never hold them) and are never tracked, exported or shown to AI helpers.
 */
export function registerLocation(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };

  /** Friends, or a teen and a guardian they accepted through a family link. */
  async function trusted(a: string, b: string): Promise<boolean> {
    if (await areFriends(db, a, b)) return true;
    const linked = await db.query(
      `SELECT 1 FROM family_links WHERE status = 'active' AND ((guardian_id = $1 AND teen_id = $2) OR (guardian_id = $2 AND teen_id = $1))`,
      [a, b],
    );
    return !!linked.rowCount;
  }

  /** The chat, and everyone else in it. Only one-to-one chats and groups. */
  async function chatOf(u: AuthUser, conversationId: string) {
    await h.assertMember(conversationId, u.id);
    const conv = (
      await db.query<{ kind: string; disappearing_seconds: number | null }>(`SELECT kind, disappearing_seconds FROM conversations WHERE id = $1`, [
        conversationId,
      ])
    ).rows[0];
    if (!conv) throw notFound('Conversation');
    if (conv.kind !== 'direct' && conv.kind !== 'group')
      throw new AppError(400, 'location_unavailable', 'Sharing where you are is for one-to-one chats and groups.');
    const others = (await h.memberIds(conversationId)).filter((m) => m !== u.id);
    if (!others.length) throw new AppError(400, 'nobody_here', 'There’s nobody else in this chat.');
    const { rows } = await db.query<{ id: string; birth_date: Date | null }>(`SELECT id, birth_date FROM users WHERE id = ANY($1::uuid[])`, [others]);
    const minors = new Set(rows.filter((r) => (ageOf(r.birth_date) ?? 18) < 18).map((r) => r.id));
    return { conv, others, minors, iAmMinor: (ageOf(u.birthDate) ?? 18) < 18 };
  }

  /**
   * Whether `u` may share where they are here: the same rules as a message (blocks, who can message
   * whom, group safety), nobody in the chat blocked either way, and, when anyone involved is under 18,
   * only with friends: someone under 18 shares only in a one-to-one chat with a friend or a group where
   * everyone is a friend, and an adult shares with someone under 18 only when they're friends.
   */
  async function assertCanShare(u: AuthUser, conversationId: string) {
    const { conv, others, minors, iAmMinor } = await chatOf(u, conversationId);
    if (conv.kind === 'direct') await h.assertCanMessage(u.id, u.birthDate, others[0]!);
    else await h.assertGroupSafe([u.id], [u.id, ...others]);
    const blocks = await db.query(
      `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = ANY($2::uuid[])) OR (blocked_id = $1 AND blocker_id = ANY($2::uuid[])) LIMIT 1`,
      [u.id, others],
    );
    if (blocks.rowCount) throw new AppError(403, 'location_blocked', 'You can’t share where you are in this chat.');
    for (const other of others) if ((iAmMinor || minors.has(other)) && !(await trusted(u.id, other))) throw new AppError(403, 'minor_protection', MINOR_SHARE);
    return conv;
  }

  /** The point as it's kept: snapped for approximate shares, with an accuracy that says so. */
  function keptPoint(input: { lat: number; lng: number; accuracy?: number }, precision: LocationPrecision) {
    const p = pointFor(input, precision);
    const accuracy = input.accuracy === undefined ? null : Math.round(input.accuracy);
    return { ...p, accuracy: precision === 'approximate' ? Math.max(accuracy ?? 0, LOCATION_APPROXIMATE_METRES) : accuracy };
  }

  /** Your own share, or 404 (someone else's, or one you can't see, is "not found" too). */
  async function ownShare(id: string, userId: string): Promise<ShareRow> {
    const row = (await db.query<ShareRow>(`SELECT ${SHARE_COLS} FROM location_shares s WHERE s.id = $1 AND s.user_id = $2`, [id, userId])).rows[0];
    if (!row) throw notFound('Location share');
    return row;
  }

  /**
   * Start sharing where you are (`mode: 'live'`, for `minutes`), or send it once. The card goes in
   * the chat as a message from you; a retry with the same clientId returns the first one. One live
   * share per person per chat at a time. The others in the chat get a quiet notification.
   */
  app.post('/v1/conversations/:id/location', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(startLocationSchema, req.body);
    const conv = await assertCanShare(u, id);
    await assertMessagePace(db, ctx.config, u.id);
    const live = input.mode === 'live';
    const point = keptPoint(input, input.precision);
    const seconds = conv.disappearing_seconds;
    const made = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, body, client_id, kind, expires_at)
         VALUES ($1,$2,$3,$4,'message', now() + make_interval(secs => $5::int))
         ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, conversation_id, (xmax = 0) AS inserted`,
        [id, u.id, live ? 'Live location' : 'Location', input.clientId ?? null, seconds],
      );
      const r = rows[0] as { id: string; conversation_id: string; inserted: boolean };
      if (r.conversation_id !== id) throw badRequest('That clientId was used in another chat.');
      if (!r.inserted) return { messageId: r.id, inserted: false };
      if (live) {
        const running = (
          await c.query<{ id: string }>(
            `SELECT id FROM location_shares WHERE conversation_id = $1 AND user_id = $2 AND mode = 'live' AND stopped_at IS NULL AND ends_at > now()`,
            [id, u.id],
          )
        ).rows[0];
        if (running) throw new AppError(409, 'already_sharing', 'You’re already sharing where you are in this chat.', { shareId: running.id });
        // One that ran out but wasn't cleared yet ends now.
        await c.query(
          `UPDATE location_shares SET lat = NULL, lng = NULL, accuracy_m = NULL, point_at = NULL, stopped_at = now(), stop_reason = 'expired'
           WHERE conversation_id = $1 AND user_id = $2 AND mode = 'live' AND stopped_at IS NULL`,
          [id, u.id],
        );
      }
      const share = await c.query<{ id: string }>(
        `INSERT INTO location_shares (message_id, conversation_id, user_id, mode, precision, lat, lng, accuracy_m, point_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), CASE WHEN $4 = 'live' THEN now() + make_interval(mins => $9::int) END) RETURNING id`,
        [r.id, id, u.id, input.mode, input.precision, point.lat, point.lng, point.accuracy, input.minutes ?? null],
      );
      if (live) await enqueue(c, LOCATION_EXPIRE_JOB, { shareId: share.rows[0]!.id }, input.minutes! * 60 + 1);
      if (seconds) await enqueue(c, 'messages.expire', { messageId: r.id }, seconds + 1);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, u.id]);
      return { messageId: r.id, inserted: true };
    });
    const message = await h.loadMessage(made.messageId, u.id);
    if (!message) throw notFound('Message');
    if (made.inserted) {
      const readers = await locationReaders(db, id, u.id);
      await ctx.realtime.publish(readers, { type: 'message.created', data: message });
      // "Ada is sharing where they are with you": in the app, and a quiet push.
      if (live)
        for (const r of readers.filter((x) => x !== u.id))
          await notify(db, ctx.realtime, { userId: r, category: 'friends', type: 'location_shared', actorId: u.id, entityType: 'conversation', entityId: id });
    }
    reply.code(201);
    return { message };
  });

  /** Live shares running in this chat that you can see (yours included), for the banner and the cards. */
  app.get('/v1/conversations/:id/location-shares', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await h.assertMember(id, u.id);
    const { rows } = await db.query<ShareRow>(
      `SELECT ${SHARE_COLS} FROM location_shares s JOIN messages m ON m.id = s.message_id
       WHERE s.conversation_id = $1 AND s.mode = 'live' AND s.stopped_at IS NULL AND s.ends_at > now()
         AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = s.user_id) OR (b.blocker_id = s.user_id AND b.blocked_id = $2))
       ORDER BY s.started_at`,
      [id, u.id],
    );
    return { items: await presentShares(db, rows, u.id) };
  });

  /**
   * A new point on your live share. At most one every LOCATION_UPDATE_SECONDS (429
   * `location_too_soon` otherwise, with `retryAfter` in seconds); a share that ended says 409 `share_ended`.
   */
  app.post('/v1/location-shares/:id/point', { preHandler: requireAuth, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(locationPointSchema, req.body);
    const share = await ownShare(id, u.id);
    if (!share.running) throw new AppError(409, 'share_ended', 'You’ve stopped sharing where you are here.');
    await h.assertMember(share.conversation_id, u.id);
    const point = keptPoint(input, share.precision);
    const done = await db.query<{ point_at: Date }>(
      `UPDATE location_shares SET lat = $2, lng = $3, accuracy_m = $4, point_at = now()
       WHERE id = $1 AND stopped_at IS NULL AND ends_at > now() AND (point_at IS NULL OR point_at <= now() - make_interval(secs => $5))
       RETURNING point_at`,
      [id, point.lat, point.lng, point.accuracy, LOCATION_UPDATE_SECONDS],
    );
    if (!done.rowCount) {
      const now = await ownShare(id, u.id);
      if (!now.running) throw new AppError(409, 'share_ended', 'You’ve stopped sharing where you are here.');
      const wait = now.point_at ? Math.max(1, Math.ceil(LOCATION_UPDATE_SECONDS - (Date.now() - now.point_at.getTime()) / 1000)) : 1;
      throw new AppError(429, 'location_too_soon', `Where you are updates every ${LOCATION_UPDATE_SECONDS} seconds at most.`, { retryAfter: wait });
    }
    return { location: await publishShare(deps, id) };
  });

  /** Stop sharing now. The point is deleted; the card says you stopped. Stopping twice is fine. */
  app.post('/v1/location-shares/:id/stop', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const share = await ownShare(id, u.id);
    if (share.mode !== 'live') throw new AppError(400, 'not_live', 'This is a location sent once. Unsend it to remove it.');
    if (await stopShare(db, id, 'stopped')) return { location: await publishShare(deps, id) };
    return { location: await shareById(db, id, u.id) };
  });

  /**
   * Ask the others in the chat where they are: a line in the chat with a button to share (each person
   * chooses; nothing is shared by asking). Adults can't ask when someone in the chat is under 18, and
   * someone under 18 can ask only when everyone in the chat is a friend. Once per person per chat
   * every LOCATION_REQUEST_MINUTES.
   */
  app.post(
    '/v1/conversations/:id/location/request',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = me(req);
      const { id } = parse(idParam, req.params);
      const { conv, others, minors, iAmMinor } = await chatOf(u, id);
      if (conv.kind === 'direct') await h.assertCanMessage(u.id, u.birthDate, others[0]!);
      else await h.assertGroupSafe([u.id], [u.id, ...others]);
      if (!iAmMinor && minors.size) throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can’t ask someone under 18 where they are.');
      if (iAmMinor) for (const other of others) if (!(await trusted(u.id, other))) throw new AppError(403, 'minor_protection', MINOR_SHARE);
      const recent = await db.query(
        `SELECT 1 FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND kind = 'system' AND meta->>'type' = 'location_request'
         AND created_at > now() - make_interval(mins => $3)`,
        [id, u.id, LOCATION_REQUEST_MINUTES],
      );
      if (recent.rowCount)
        throw new AppError(429, 'location_request_too_soon', `You asked a moment ago. You can ask again in ${LOCATION_REQUEST_MINUTES} minutes.`);
      await assertMessagePace(db, ctx.config, u.id);
      const meta: MessageSystemInfo = { type: 'location_request' };
      const messageId = await tx(db, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO messages (conversation_id, sender_id, body, kind, meta, expires_at)
         VALUES ($1,$2,'','system',$3, now() + make_interval(secs => $4::int)) RETURNING id`,
          [id, u.id, meta, conv.disappearing_seconds],
        );
        if (conv.disappearing_seconds) await enqueue(c, 'messages.expire', { messageId: rows[0]!.id }, conv.disappearing_seconds + 1);
        await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [id]);
        return rows[0]!.id;
      });
      const message = await h.loadMessage(messageId, u.id);
      if (!message) throw notFound('Message');
      await ctx.realtime.publish(await h.notBlocking(u.id, await h.memberIds(id)), { type: 'message.created', data: message });
      reply.code(201);
      return { message };
    },
  );
}
