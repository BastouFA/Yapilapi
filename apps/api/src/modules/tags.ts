import type { FastifyInstance } from 'fastify';
import { extractHashtags, normalizeTag } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { hydratePosts } from '../lib/posts.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const VISIBLE = postVisibleSql('$1');
const FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;
/** Public, unflagged posts only: what trending counts. */
const PUBLIC_POST = `p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'normal' AND au.status = 'active' AND NOT ap.is_private`;

const tagParam = z.object({
  tag: z
    .string()
    .transform((s) => normalizeTag(decodeURIComponent(s)))
    .pipe(z.string().regex(/^[\p{L}\p{M}\p{N}_]{2,40}$/u, 'That is not a hashtag.')),
});

/**
 * Hashtags: every #tag in a post becomes one of its topics. Each tag has a
 * page (recent and top posts, how many people use it, related tags) and can be
 * followed, which adds it to your interests so For you leans towards it.
 * Trending ranks tags by how many different people used them recently.
 */
export default async function tagsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.get('/v1/trending', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) }), req.query);
    const { rows } = await db.query(
      `SELECT t AS tag,
              count(*) FILTER (WHERE p.created_at > now() - interval '24 hours') AS today,
              count(*) FILTER (WHERE p.created_at <= now() - interval '24 hours' AND p.created_at > now() - interval '48 hours') AS yesterday,
              count(*) AS week,
              count(DISTINCT p.author_id) AS people
       ${FROM}, unnest(p.topics) t
       WHERE p.created_at > now() - interval '7 days' AND ${PUBLIC_POST}
       GROUP BY t
       ORDER BY count(DISTINCT p.author_id) * 3 + count(*) FILTER (WHERE p.created_at > now() - interval '24 hours') * 2 + count(*) DESC, t
       LIMIT $1`,
      [limit],
    );
    return {
      items: rows.map((r) => ({
        tag: r.tag as string,
        posts: Number(r.week),
        people: Number(r.people),
        rising: Number(r.today) > Math.max(1, Number(r.yesterday)),
      })),
    };
  });

  app.get('/v1/tags/:tag', async (req) => {
    const viewer = req.user?.id ?? null;
    const { tag } = parse(tagParam, req.params);
    const [counts, related, following] = await Promise.all([
      db.query(
        `SELECT count(*) AS posts, count(DISTINCT author_id) AS people, count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week
         FROM (SELECT p.author_id, p.created_at ${FROM} WHERE $2 = ANY(p.topics) AND ${VISIBLE} LIMIT 10000) x`,
        [viewer, tag],
      ),
      db.query(
        `SELECT t AS tag, count(*) AS n ${FROM}, unnest(p.topics) t
         WHERE $1 = ANY(p.topics) AND t <> $1 AND ${PUBLIC_POST} AND p.created_at > now() - interval '30 days'
         GROUP BY t ORDER BY count(*) DESC, t LIMIT 8`,
        [tag],
      ),
      viewer ? db.query(`SELECT 1 FROM user_interests ui JOIN topics tp ON tp.id = ui.topic_id WHERE ui.user_id = $1 AND tp.slug = $2`, [viewer, tag]) : null,
    ]);
    const c = counts.rows[0];
    return {
      tag,
      posts: Number(c.posts),
      people: Number(c.people),
      postsThisWeek: Number(c.week),
      related: related.rows.map((r) => r.tag as string),
      following: !!following?.rowCount,
    };
  });

  /** Posts with a tag, newest first or top (most liked, commented and reposted in the last 30 days). */
  app.get('/v1/tags/:tag/posts', async (req) => {
    const viewer = req.user?.id ?? null;
    const { tag } = parse(tagParam, req.params);
    const q = parse(
      z.object({
        sort: z.enum(['recent', 'top']).default('recent'),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      req.query,
    );
    if (q.sort === 'top') {
      const c = decodeCursor<{ o: number }>(q.cursor);
      const offset = Math.max(0, Math.min(c?.o ?? 0, 500));
      const { rows } = await db.query(
        `SELECT p.id ${FROM} WHERE $2 = ANY(p.topics) AND ${VISIBLE} AND p.created_at > now() - interval '30 days'
         ORDER BY p.like_count + 2 * p.comment_count + 3 * p.repost_count DESC, p.created_at DESC, p.id LIMIT $3 OFFSET $4`,
        [viewer, tag, q.limit + 1, offset],
      );
      const page = rows.slice(0, q.limit);
      return {
        items: await hydratePosts(
          db,
          page.map((r) => r.id),
          viewer,
        ),
        nextCursor: rows.length > q.limit && offset + q.limit < 500 ? encodeCursor({ o: offset + q.limit }) : null,
      };
    }
    const c = decodeCursor<{ t: string; id: string }>(q.cursor);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${FROM} WHERE $2 = ANY(p.topics) AND ${VISIBLE}
       ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      c ? [viewer, tag, q.limit + 1, c.t, c.id] : [viewer, tag, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
  });

  app.put('/v1/tags/:tag/follow', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { tag } = parse(tagParam, req.params);
    const count = await db.query(`SELECT count(*)::int AS n FROM user_interests WHERE user_id = $1`, [u.id]);
    if (count.rows[0].n >= 200) throw new AppError(400, 'validation_failed', 'You follow a lot of tags already. Unfollow some first.');
    const { rows } = await db.query(`INSERT INTO topics (slug, name) VALUES ($1, $1) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`, [
      tag,
    ]);
    await db.query(`INSERT INTO user_interests (user_id, topic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [u.id, rows[0].id]);
    return { following: true };
  });

  app.delete('/v1/tags/:tag/follow', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { tag } = parse(tagParam, req.params);
    await db.query(`DELETE FROM user_interests ui USING topics tp WHERE tp.id = ui.topic_id AND ui.user_id = $1 AND tp.slug = $2`, [u.id, tag]);
    return { following: false };
  });
}

/** A post's topics: the ones chosen plus every #tag in its text, at most 10. */
export function topicsFor(chosen: string[], body: string | null | undefined): string[] {
  return [...new Set([...chosen.map(normalizeTag), ...extractHashtags(body)])].slice(0, 10);
}
