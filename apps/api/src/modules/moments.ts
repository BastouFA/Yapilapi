import type { FastifyInstance } from 'fastify';
import { createMomentSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { analyzeText } from '../lib/moderation.ts';
import { track } from '../lib/services.ts';
import { publicUserFrom } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Moments: short-lived posts (1h, 24h, custom or permanent) shown to your people. */
export default async function momentsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.post('/v1/moments', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createMomentSchema, req.body);
    if (!input.body && !input.mediaUrl) throw new AppError(400, 'validation_failed', 'Add text or media to your moment.');
    if (analyzeText(input.body).risk !== 'normal') throw new AppError(422, 'content_blocked', "This moment can't be shared.");
    const hours = input.expiresIn === '1h' ? 1 : input.expiresIn === '24h' ? 24 : input.expiresIn === 'custom' ? (input.customHours ?? 24) : null;
    const { rows } = await db.query(
      `INSERT INTO moments (author_id, body, media_url, media_kind, visibility, location_text, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(hours => $7::int) END) RETURNING id, expires_at, created_at`,
      [u.id, input.body, input.mediaUrl ?? null, input.mediaKind ?? null, input.visibility, input.locationText ?? null, hours],
    );
    track(db, u.id, 'moment_created', { expiresIn: input.expiresIn });
    reply.code(201);
    return { moment: rows[0] };
  });

  /** Active moments from people the viewer follows or is friends with, grouped by author. */
  app.get('/v1/moments', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT m.id, m.body, m.media_url, m.media_kind, m.location_text, m.expires_at, m.created_at,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM moments m JOIN profiles pr ON pr.user_id = m.author_id JOIN users au ON au.id = m.author_id
       WHERE m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) AND au.status = 'active'
         AND ${notBlockedSql('m.author_id', '$1')}
         AND (m.author_id = $1
           OR (m.visibility IN ('public','followers') AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = m.author_id))
           OR (m.visibility IN ('public','followers','friends') AND EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = m.author_id) OR (fr.user_b = $1 AND fr.user_a = m.author_id))))
       ORDER BY m.author_id = $1 DESC, m.created_at DESC LIMIT 200`,
      [u.id],
    );
    const groups = new Map<string, { author: ReturnType<typeof publicUserFrom>; moments: unknown[] }>();
    for (const r of rows) {
      const g = groups.get(r.a_id) ?? { author: publicUserFrom(r, 'a_'), moments: [] };
      g.moments.push({ id: r.id, body: r.body, mediaUrl: r.media_url, mediaKind: r.media_kind, locationText: r.location_text, expiresAt: r.expires_at, createdAt: r.created_at });
      groups.set(r.a_id, g);
    }
    return { items: [...groups.values()] };
  });

  app.delete('/v1/moments/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await db.query(`UPDATE moments SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Moment');
    return { ok: true };
  });
}
