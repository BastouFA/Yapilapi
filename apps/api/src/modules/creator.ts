import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../lib/context.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Creator Studio foundation: performance of your own content and audience growth. */
export default async function creatorModule(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/creator/analytics', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const [totals, top, growth] = await Promise.all([
      ctx.db.query(
        `SELECT count(*) AS posts, coalesce(sum(like_count), 0) AS likes, coalesce(sum(comment_count), 0) AS comments,
                (SELECT count(*) FROM saves s JOIN posts p2 ON p2.id = s.post_id WHERE p2.author_id = $1) AS saves,
                (SELECT count(*) FROM follows WHERE followee_id = $1) AS followers
         FROM posts WHERE author_id = $1 AND deleted_at IS NULL AND created_at > now() - interval '28 days'`,
        [u.id],
      ),
      ctx.db.query(
        `SELECT id, left(body, 120) AS excerpt, kind, like_count, comment_count, created_at FROM posts
         WHERE author_id = $1 AND deleted_at IS NULL ORDER BY like_count + 2 * comment_count DESC, created_at DESC LIMIT 5`,
        [u.id],
      ),
      ctx.db.query(
        `SELECT date_trunc('day', d)::date AS day, (SELECT count(*) FROM follows WHERE followee_id = $1 AND created_at::date = d::date) AS new_followers
         FROM generate_series(now() - interval '27 days', now(), interval '1 day') d ORDER BY day`,
        [u.id],
      ),
    ]);
    return { period: 'last_28_days', totals: totals.rows[0], topPosts: top.rows, followerGrowth: growth.rows };
  });
}
