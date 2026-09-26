import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createMomentSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { analyzeText } from '../lib/moderation.ts';
import { track } from '../lib/services.ts';
import { publicUserFrom } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Stories the viewer ($1) may see: their own, and active ones from people they follow or are friends with. */
const STORY_VISIBLE = `m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) AND au.status = 'active'
  AND ${notBlockedSql('m.author_id', '$1')}
  AND (m.author_id = $1
    OR (m.visibility IN ('public','followers') AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = m.author_id))
    OR (m.visibility IN ('public','followers','friends') AND EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = m.author_id) OR (fr.user_b = $1 AND fr.user_a = m.author_id))))`;

/**
 * Stories (called moments in the API): short-lived photos, videos or text
 * (1h, 24h, custom or permanent) shown to your people, with views, likes and
 * replies that arrive as a direct message.
 */
export default async function momentsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function visibleStory(id: string, viewer: string) {
    const { rows } = await db.query(
      `SELECT m.id, m.author_id, m.body FROM moments m JOIN users au ON au.id = m.author_id WHERE m.id = $2 AND ${STORY_VISIBLE}`,
      [viewer, id],
    );
    if (!rows[0]) throw notFound('Story');
    return rows[0] as { id: string; author_id: string; body: string };
  }

  app.post('/v1/moments', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createMomentSchema, req.body);
    let mediaUrl = input.mediaUrl ?? null;
    let mediaKind = input.mediaKind ?? null;
    if (input.mediaId) {
      // Only your own upload; its URL and kind come from the stored item, not the request.
      const m = (await db.query(`SELECT url, kind FROM media WHERE id = $1 AND owner_id = $2`, [input.mediaId, u.id])).rows[0];
      if (!m) throw notFound('That photo or video');
      mediaUrl = m.url;
      mediaKind = m.kind;
    }
    if (!input.body && !mediaUrl) throw new AppError(400, 'validation_failed', 'Add text, a photo or a video to your story.');
    if (analyzeText(input.body).risk !== 'normal') throw new AppError(422, 'content_blocked', "This story can't be shared.");
    const hours = input.expiresIn === '1h' ? 1 : input.expiresIn === '24h' ? 24 : input.expiresIn === 'custom' ? (input.customHours ?? 24) : null;
    const { rows } = await db.query(
      `INSERT INTO moments (author_id, body, media_url, media_kind, media_id, visibility, location_text, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(hours => $8::int) END) RETURNING id, expires_at, created_at`,
      [u.id, input.body, mediaUrl, mediaKind, input.mediaId ?? null, input.visibility, input.locationText ?? null, hours],
    );
    track(db, u.id, 'moment_created', { expiresIn: input.expiresIn });
    reply.code(201);
    return { moment: rows[0] };
  });

  /**
   * Active stories grouped by author: yours first, then people with stories you
   * haven't seen, newest first. Each story says whether you've seen and liked
   * it; your own carry their view count.
   */
  app.get('/v1/moments', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT m.id, m.body, m.media_url, m.media_kind, m.location_text, m.expires_at, m.created_at,
              md.poster_url, md.hls_url, md.variants, md.duration_ms,
              v.viewer_id IS NOT NULL AS seen, coalesce(v.liked, false) AS liked,
              CASE WHEN m.author_id = $1 THEN (SELECT count(*) FROM moment_views mv WHERE mv.moment_id = m.id AND mv.viewer_id <> $1) END AS views,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM moments m JOIN profiles pr ON pr.user_id = m.author_id JOIN users au ON au.id = m.author_id
       LEFT JOIN media md ON md.id = m.media_id
       LEFT JOIN moment_views v ON v.moment_id = m.id AND v.viewer_id = $1
       WHERE ${STORY_VISIBLE}
       ORDER BY m.created_at ASC LIMIT 300`,
      [u.id],
    );
    type Story = Record<string, unknown> & { seen: boolean; createdAt: Date };
    const groups = new Map<string, { author: ReturnType<typeof publicUserFrom>; mine: boolean; allSeen: boolean; latest: number; moments: Story[] }>();
    for (const r of rows) {
      const mine = r.a_id === u.id;
      const g = groups.get(r.a_id) ?? { author: publicUserFrom(r, 'a_'), mine, allSeen: true, latest: 0, moments: [] };
      const seen = mine || r.seen;
      g.moments.push({
        id: r.id,
        body: r.body,
        mediaUrl: r.variants?.mp4 ?? r.media_url,
        mediaKind: r.media_kind,
        posterUrl: r.poster_url ?? null,
        hlsUrl: r.hls_url ?? null,
        durationMs: r.duration_ms ?? null,
        locationText: r.location_text,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        seen,
        liked: r.liked,
        views: r.views === null || r.views === undefined ? undefined : Number(r.views),
      });
      g.allSeen &&= seen;
      g.latest = Math.max(g.latest, new Date(r.created_at).getTime());
      groups.set(r.a_id, g);
    }
    const items = [...groups.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.allSeen) - Number(b.allSeen) || b.latest - a.latest);
    return { items };
  });

  const idParam = z.object({ id: z.string().uuid() });

  app.post('/v1/moments/:id/view', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await visibleStory(id, u.id);
    if (s.author_id !== u.id) await db.query(`INSERT INTO moment_views (moment_id, viewer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
    return { ok: true };
  });

  app.put('/v1/moments/:id/like', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { liked } = parse(z.object({ liked: z.boolean() }), req.body);
    const s = await visibleStory(id, u.id);
    if (s.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't like your own story.");
    await db.query(
      `INSERT INTO moment_views (moment_id, viewer_id, liked) VALUES ($1,$2,$3) ON CONFLICT (moment_id, viewer_id) DO UPDATE SET liked = EXCLUDED.liked`,
      [id, u.id, liked],
    );
    return { liked };
  });

  /** Who saw your story (only yours), with who liked it. */
  app.get('/v1/moments/:id/viewers', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await visibleStory(id, u.id);
    if (s.author_id !== u.id) throw forbidden();
    const { rows } = await db.query(
      `SELECT v.liked, v.viewed_at, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM moment_views v JOIN profiles pr ON pr.user_id = v.viewer_id
       WHERE v.moment_id = $1 AND ${notBlockedSql('v.viewer_id', '$2')} ORDER BY v.liked DESC, v.viewed_at DESC LIMIT 500`,
      [id, u.id],
    );
    return { items: rows.map((r) => ({ user: publicUserFrom(r, 'a_'), liked: r.liked, viewedAt: r.viewed_at })) };
  });

  /**
   * Reply to a story: it arrives in your direct conversation with the author.
   * Sent through the messaging endpoints as you, so blocks, minor protection
   * and family settings apply exactly as for any message.
   */
  app.post('/v1/moments/:id/reply', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(1000) }), req.body);
    const s = await visibleStory(id, u.id);
    if (s.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't reply to your own story.");
    const asViewer = asSameUser(req);
    const convo = await app.inject({ method: 'POST', url: '/v1/conversations', headers: asViewer, payload: { memberIds: [s.author_id] } });
    if (convo.statusCode >= 300) return reply.code(convo.statusCode).send(convo.json());
    const conversationId = convo.json().conversation.id as string;
    const quote = s.body ? `“${s.body.slice(0, 80)}${s.body.length > 80 ? '…' : ''}”` : 'your story';
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: asViewer,
      payload: { body: `Replied to ${quote}: ${body}`, clientId: `story-${id}-${Date.now()}` },
    });
    if (sent.statusCode >= 300) return reply.code(sent.statusCode).send(sent.json());
    reply.code(201);
    return { conversationId };
  });

  app.delete('/v1/moments/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE moments SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Story');
    return { ok: true };
  });
}

/** The caller's own credentials, for an internal call made on their behalf. */
function asSameUser(req: FastifyRequest): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (req.headers.authorization) h.authorization = req.headers.authorization;
  if (req.headers.cookie) h.cookie = req.headers.cookie;
  if (req.headers['x-csrf-token']) h['x-csrf-token'] = String(req.headers['x-csrf-token']);
  return h;
}
