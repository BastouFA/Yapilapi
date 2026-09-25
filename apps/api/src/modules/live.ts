import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashToken } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { analyzeText } from '../lib/moderation.ts';
import { isEnabled, notify, track } from '../lib/services.ts';
import { publicUserFrom } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Video transport is a provider concern (RTMP/WHIP ingest + HLS/WebRTC playback).
 * The dev adapter returns local URLs; production plugs in a live-video provider.
 */
export interface LiveVideoProvider {
  ingest(sessionId: string, streamKey: string): { url: string; streamKey: string };
  playback(sessionId: string, token: string): string;
}

/**
 * MediaMTX: streaming software publishes RTMP to <server>/live with stream key
 * "<sessionId>?key=<secret>"; viewers get HLS at /live/<sessionId>/index.m3u8
 * with a short-lived signed token. MediaMTX asks /v1/live/hooks/auth for both.
 */
export function mediamtxVideo(rtmpBase: string, hlsBase: string): LiveVideoProvider {
  return {
    ingest: (id, streamKey) => ({ url: `${rtmpBase}/live`, streamKey: `${id}?key=${streamKey}` }),
    playback: (id, token) => `${hlsBase}/live/${id}/index.m3u8?token=${encodeURIComponent(token)}`,
  };
}

/** Live sessions: host, co-hosts, audience, chat, Q&A, moderation. Behind the LIVE flag. */
export default async function liveModule(app: FastifyInstance, ctx: AppContext, videoOverride?: LiveVideoProvider) {
  const db = ctx.db;
  const video = videoOverride ?? mediamtxVideo(ctx.config.LIVE_RTMP_URL, ctx.config.LIVE_HLS_BASE);
  // Viewer tokens: HMAC(sessionId.userId.expiry), valid for 6 hours.
  const signView = (sessionId: string, userId: string) => {
    const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
    const mac = createHmac('sha256', ctx.config.LIVE_HOOK_SECRET).update(`${sessionId}.${userId}.${exp}`).digest('base64url');
    return `${userId}.${exp}.${mac}`;
  };
  const checkView = (sessionId: string, token: string) => {
    const [userId, exp, mac] = token.split('.');
    if (!userId || !exp || !mac || Number(exp) < Date.now() / 1000) return false;
    const expected = createHmac('sha256', ctx.config.LIVE_HOOK_SECRET).update(`${sessionId}.${userId}.${exp}`).digest('base64url');
    return expected.length === mac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
  };
  const gate = async (req: FastifyRequest) => {
    await requireAuth(req, undefined as never);
    if (!(await isEnabled(db, 'LIVE'))) throw featureDisabled('Live');
  };

  const VISIBLE = `(
    ${notBlockedSql('l.host_id', '$1')} AND (
      l.host_id = $1 OR l.visibility = 'public'
      OR (l.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = l.host_id))
      OR (l.visibility = 'friends' AND EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = l.host_id) OR (fr.user_b = $1 AND fr.user_a = l.host_id)))))`;
  const SELECT = `SELECT l.*, pr.user_id AS h_id, pr.username AS h_username, pr.display_name AS h_display_name, pr.avatar_url AS h_avatar_url, pr.mode AS h_mode,
      (SELECT count(*) FROM live_participants p WHERE p.session_id = l.id AND p.left_at IS NULL AND p.role = 'viewer') AS viewers,
      (SELECT role FROM live_participants p WHERE p.session_id = l.id AND p.user_id = $1) AS my_role,
      (SELECT banned FROM live_participants p WHERE p.session_id = l.id AND p.user_id = $1) AS banned
    FROM live_sessions l JOIN profiles pr ON pr.user_id = l.host_id`;

  function dto(r: Record<string, any>, viewerId: string) {
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      visibility: r.visibility,
      host: publicUserFrom(r, 'h_'),
      viewers: Number(r.viewers),
      peakViewers: r.peak_viewers,
      scheduledFor: r.scheduled_for,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      myRole: r.my_role,
      playbackUrl: r.status === 'live' && !r.banned ? video.playback(r.id, signView(r.id, viewerId)) : null,
    };
  }

  async function load(id: string, viewer: string) {
    const { rows } = await db.query(`${SELECT} WHERE l.id = $2 AND ${VISIBLE}`, [viewer, id]);
    if (!rows[0]) throw notFound('Live');
    return rows[0];
  }
  async function audience(id: string): Promise<string[]> {
    return (await db.query(`SELECT user_id FROM live_participants WHERE session_id = $1 AND left_at IS NULL`, [id])).rows.map((r) => r.user_id);
  }
  const canModerate = (role: string | null) => role === 'host' || role === 'cohost' || role === 'moderator';

  app.get('/v1/live', { preHandler: gate }, async (req) => {
    const { rows } = await db.query(
      `${SELECT} WHERE ${VISIBLE} AND l.status IN ('live','scheduled') ORDER BY l.status = 'live' DESC, coalesce(l.started_at, l.scheduled_for) DESC LIMIT 50`,
      [me(req).id],
    );
    return { items: rows.map((r) => dto(r, me(req).id)) };
  });

  app.post('/v1/live', { preHandler: gate, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(
      z.object({
        title: z.string().trim().min(1).max(120),
        visibility: z.enum(['public', 'followers', 'friends']).default('public'),
        scheduledFor: z.string().datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    const streamKey = `sk_${randomBytes(20).toString('base64url')}`;
    const id = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO live_sessions (host_id, title, visibility, scheduled_for, stream_key_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [u.id, input.title, input.visibility, input.scheduledFor ?? null, hashToken(streamKey)],
      );
      await c.query(`INSERT INTO live_participants (session_id, user_id, role) VALUES ($1,$2,'host')`, [rows[0].id, u.id]);
      return rows[0].id as string;
    });
    reply.code(201);
    return { live: dto(await load(id, u.id), u.id), ingest: video.ingest(id, streamKey), message: 'Keep the stream key private. It is shown once.' };
  });

  app.get('/v1/live/:id', { preHandler: gate }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { live: dto(await load(id, me(req).id), me(req).id) };
  });

  app.post('/v1/live/:id/start', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE live_sessions SET status = 'live', started_at = now() WHERE id = $1 AND host_id = $2 AND status = 'scheduled' RETURNING id`,
      [id, u.id],
    );
    if (!r.rowCount) throw badRequest('Only the host can start a scheduled live.');
    // Tell followers (bounded fan-out; larger audiences go through a queue).
    const followers = await db.query<{ follower_id: string }>(`SELECT follower_id FROM follows WHERE followee_id = $1 LIMIT 500`, [u.id]);
    for (const f of followers.rows)
      await notify(db, ctx.realtime, { userId: f.follower_id, category: 'creators', type: 'live_started', actorId: u.id, entityType: 'live', entityId: id });
    track(db, u.id, 'live_started');
    return { live: dto(await load(id, u.id), u.id) };
  });

  app.post('/v1/live/:id/end', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1 AND host_id = $2 AND status <> 'ended' RETURNING id`, [
      id,
      u.id,
    ]);
    if (!r.rowCount) throw badRequest('Only the host can end this live.');
    await ctx.realtime.publish(await audience(id), { type: 'live.status', data: { id, status: 'ended' } });
    await db.query(`UPDATE live_participants SET left_at = now() WHERE session_id = $1 AND left_at IS NULL`, [id]);
    return { live: dto(await load(id, u.id), u.id) };
  });

  app.post('/v1/live/:id/join', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const l = await load(id, u.id);
    if (l.banned) throw forbidden("You can't join this live.");
    if (l.status !== 'live') throw badRequest("This live hasn't started or has ended.");
    await db.query(
      `INSERT INTO live_participants (session_id, user_id) VALUES ($1,$2) ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now()`,
      [id, u.id],
    );
    const viewers = Number(
      (await db.query(`SELECT count(*) AS n FROM live_participants WHERE session_id = $1 AND left_at IS NULL AND role = 'viewer'`, [id])).rows[0].n,
    );
    await db.query(`UPDATE live_sessions SET peak_viewers = greatest(peak_viewers, $2) WHERE id = $1`, [id, viewers]);
    await ctx.realtime.publish(await audience(id), { type: 'live.viewers', data: { id, viewers } });
    return { live: dto(await load(id, u.id), u.id) };
  });

  app.post('/v1/live/:id/leave', { preHandler: gate }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`UPDATE live_participants SET left_at = now() WHERE session_id = $1 AND user_id = $2 AND role = 'viewer'`, [id, me(req).id]);
    return { ok: true };
  });

  app.get('/v1/live/:id/chat', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await load(id, u.id);
    const { rows } = await db.query(
      `SELECT c.id, c.kind, c.body, c.answered, c.created_at, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM live_chat c JOIN profiles pr ON pr.user_id = c.user_id WHERE c.session_id = $1 AND c.deleted_at IS NULL AND ${notBlockedSql('c.user_id', '$2')}
       ORDER BY c.created_at DESC LIMIT 200`,
      [id, u.id],
    );
    return {
      items: rows
        .reverse()
        .map((r) => ({ id: r.id, kind: r.kind, body: r.body, answered: r.answered, author: publicUserFrom(r, 'a_'), createdAt: r.created_at })),
    };
  });

  app.post('/v1/live/:id/chat', { preHandler: gate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ body: z.string().trim().min(1).max(500), kind: z.enum(['chat', 'question', 'reaction']).default('chat') }), req.body);
    const l = await load(id, u.id);
    if (l.status !== 'live') throw badRequest('Chat opens when the live starts.');
    if (!l.my_role || l.banned) throw forbidden('Join the live to chat.');
    const risk = analyzeText(input.body).risk;
    if (risk !== 'normal' && risk !== 'review') throw new AppError(422, 'content_blocked', "That message can't be posted.");
    const { rows } = await db.query(`INSERT INTO live_chat (session_id, user_id, kind, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [
      id,
      u.id,
      input.kind,
      input.body,
    ]);
    const author = (
      await db.query(
        `SELECT user_id AS a_id, username AS a_username, display_name AS a_display_name, avatar_url AS a_avatar_url, mode AS a_mode FROM profiles WHERE user_id = $1`,
        [u.id],
      )
    ).rows[0];
    const msg = { id: rows[0].id, kind: input.kind, body: input.body, answered: false, author: publicUserFrom(author, 'a_'), createdAt: rows[0].created_at };
    await ctx.realtime.publish(await audience(id), { type: 'live.chat', data: { liveId: id, message: msg } });
    reply.code(201);
    return { message: msg };
  });

  app.delete('/v1/live/:id/chat/:messageId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, messageId } = parse(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }), req.params);
    const l = await load(id, u.id);
    const r = await db.query(`UPDATE live_chat SET deleted_at = now() WHERE id = $1 AND session_id = $2 AND (user_id = $3 OR $4) RETURNING id`, [
      messageId,
      id,
      u.id,
      canModerate(l.my_role),
    ]);
    if (!r.rowCount) throw notFound('Message');
    await ctx.realtime.publish(await audience(id), { type: 'live.chat_deleted', data: { liveId: id, messageId } });
    return { ok: true };
  });

  app.post('/v1/live/:id/roles', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ userId: z.string().uuid(), role: z.enum(['cohost', 'moderator', 'viewer']) }), req.body);
    const l = await load(id, u.id);
    if (l.my_role !== 'host') throw forbidden('Only the host can change roles.');
    if (input.userId === u.id) throw badRequest("You're already the host.");
    await db.query(
      `INSERT INTO live_participants (session_id, user_id, role, left_at) VALUES ($1,$2,$3, now()) ON CONFLICT (session_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, input.userId, input.role],
    );
    return { ok: true };
  });

  app.post('/v1/live/:id/ban', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    const l = await load(id, u.id);
    if (!canModerate(l.my_role) || userId === l.host_id) throw forbidden();
    await db.query(
      `INSERT INTO live_participants (session_id, user_id, banned, left_at) VALUES ($1,$2,true,now()) ON CONFLICT (session_id, user_id) DO UPDATE SET banned = true, left_at = now()`,
      [id, userId],
    );
    await ctx.realtime.publish([userId], { type: 'live.status', data: { id, status: 'removed' } });
    return { ok: true };
  });

  /**
   * MediaMTX auth hook. Publish: the stream key must match the session and its host,
   * and the session must not have ended. Read: a valid signed viewer token.
   */
  app.post('/v1/live/hooks/auth', { config: { rateLimit: false } }, async (req, reply) => {
    const secret = (req.query as { secret?: string }).secret ?? '';
    const want = Buffer.from(ctx.config.LIVE_HOOK_SECRET);
    if (secret.length !== want.length || !timingSafeEqual(Buffer.from(secret), want)) return reply.code(401).send();
    const b = (req.body ?? {}) as { action?: string; path?: string; query?: string };
    const m = /^live\/([0-9a-f-]{36})$/.exec(b.path ?? '');
    if (!m) return reply.code(401).send();
    const sessionId = m[1]!;
    const params = new URLSearchParams(b.query ?? '');
    const { rows } = await db.query(`SELECT status, stream_key_hash FROM live_sessions WHERE id = $1`, [sessionId]);
    const l = rows[0];
    if (!l) return reply.code(401).send();
    if (b.action === 'publish') {
      const key = params.get('key') ?? '';
      if (l.status === 'ended' || !l.stream_key_hash || hashToken(key) !== l.stream_key_hash) return reply.code(401).send();
      return reply.code(200).send();
    }
    if (b.action === 'read' || b.action === 'playback') {
      if (l.status !== 'live' || !checkView(sessionId, params.get('token') ?? '')) return reply.code(401).send();
      return reply.code(200).send();
    }
    return reply.code(401).send();
  });
}
