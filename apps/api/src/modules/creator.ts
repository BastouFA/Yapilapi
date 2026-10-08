import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { byOrWithSql } from '../lib/collabs.ts';
import { notFound, parse } from '../lib/errors.ts';
import { publicUserFrom } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { fairStartOf } from '../lib/fair-start.ts';

/**
 * Creator Studio foundation: performance of your own content (posts you co-author count too),
 * audience growth, one post's insights and the tips (gifts) you sent and got (payouts: modules/payouts.ts).
 */
export default async function creatorModule(app: FastifyInstance, ctx: AppContext) {
  const topSelect = `SELECT id, left(body, 120) AS excerpt, kind, format, like_count, comment_count, view_count, created_at FROM posts p
         WHERE ${byOrWithSql('$1')} AND deleted_at IS NULL AND status = 'published'`;

  app.get('/v1/creator/analytics', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const [totals, top, reels, growth, views] = await Promise.all([
      ctx.db.query(
        `SELECT count(*)::int AS posts, coalesce(sum(like_count), 0)::int AS likes, coalesce(sum(comment_count), 0)::int AS comments,
                (SELECT count(*)::int FROM saves s JOIN posts p2 ON p2.id = s.post_id WHERE ${byOrWithSql('$1', 'p2')} AND p2.status = 'published') AS saves,
                (SELECT count(*)::int FROM follows WHERE followee_id = $1) AS followers
         FROM posts p WHERE ${byOrWithSql('$1')} AND deleted_at IS NULL AND status = 'published' AND created_at > now() - interval '28 days'`,
        [u.id],
      ),
      ctx.db.query(`${topSelect} AND format = 'post' ORDER BY like_count + 2 * comment_count DESC, created_at DESC LIMIT 5`, [u.id]),
      ctx.db.query(`${topSelect} AND format = 'reel' ORDER BY view_count + like_count + 2 * comment_count DESC, created_at DESC LIMIT 5`, [u.id]),
      ctx.db.query(
        `SELECT date_trunc('day', d)::date AS day, (SELECT count(*)::int FROM follows WHERE followee_id = $1 AND created_at::date = d::date) AS new_followers
         FROM generate_series(now() - interval '27 days', now(), interval '1 day') d ORDER BY day`,
        [u.id],
      ),
      // Views in the period: each person counts once per post (views), and once overall (reach).
      ctx.db.query(
        `SELECT count(*)::int AS views, count(DISTINCT v.viewer_id)::int AS reach
         FROM post_views v JOIN posts p ON p.id = v.post_id
         WHERE ${byOrWithSql('$1')} AND p.deleted_at IS NULL AND v.viewer_id <> $1 AND v.viewed_at > now() - interval '28 days'`,
        [u.id],
      ),
    ]);
    return {
      period: 'last_28_days',
      totals: { ...totals.rows[0], views: views.rows[0].views, reach: views.rows[0].reach },
      topPosts: top.rows,
      topReels: reels.rows,
      followerGrowth: growth.rows,
    };
  });

  /** How one of your posts is doing: its counts, and views per day over the last 28 days. Authors and co-authors only. */
  app.get('/v1/posts/:id/insights', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rows } = await ctx.db.query(
      `SELECT p.id, p.format, p.like_count, p.comment_count, p.view_count, p.repost_count AS reposts, p.created_at,
              (SELECT count(*)::int FROM saves s WHERE s.post_id = p.id) AS saves
       FROM posts p WHERE p.id = $2 AND p.deleted_at IS NULL AND p.status = 'published' AND ${byOrWithSql('$1')}`,
      [u.id, id],
    );
    const p = rows[0];
    if (!p) throw notFound('Post');
    const days = await ctx.db.query(
      `SELECT d::date AS day, (SELECT count(*)::int FROM post_views v WHERE v.post_id = $1 AND v.viewed_at::date = d::date) AS views
       FROM generate_series(now() - interval '27 days', now(), interval '1 day') d ORDER BY day`,
      [id],
    );
    return {
      insights: {
        postId: p.id as string,
        format: p.format as 'post' | 'reel',
        createdAt: p.created_at,
        views: p.view_count as number,
        likes: p.like_count as number,
        comments: p.comment_count as number,
        saves: p.saves as number,
        reposts: p.reposts as number,
        viewsByDay: days.rows.map((r) => ({ day: r.day, views: r.views as number })),
        // A new creator's reel: how far its fair start got, and its report (lib/fair-start.ts).
        fairStart: p.format === 'reel' ? await fairStartOf(ctx.db, p.id) : null,
      },
    };
  });

  /**
   * Tips you sent or got, paid ones only, newest first. A tip sent during a live is a gift
   * (it showed in that live's chat).
   */
  app.get('/v1/me/tips', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { direction } = parse(z.object({ direction: z.enum(['sent', 'received']).default('received') }), req.query);
    const other = direction === 'sent' ? 't.to_id' : 't.from_id';
    const own = direction === 'sent' ? 't.from_id' : 't.to_id';
    const { rows } = await ctx.db.query(
      `SELECT t.id, t.message, t.post_id, t.live_id, t.created_at, o.total_cents, o.currency,
              pr.user_id AS o_id, pr.username AS o_username, pr.display_name AS o_display_name, pr.avatar_url AS o_avatar_url, pr.mode AS o_mode
       FROM tips t JOIN orders o ON o.id = t.order_id JOIN profiles pr ON pr.user_id = ${other}
       WHERE ${own} = $1 AND o.status = 'paid'
       ORDER BY t.created_at DESC LIMIT 100`,
      [u.id],
    );
    return {
      direction,
      items: rows.map((r) => ({
        id: r.id as string,
        amountCents: r.total_cents as number,
        currency: String(r.currency).trim(),
        message: r.message as string,
        postId: (r.post_id as string | null) ?? null,
        gift: !!r.live_id,
        createdAt: r.created_at,
        person: publicUserFrom(r, 'o_'),
      })),
    };
  });
}
