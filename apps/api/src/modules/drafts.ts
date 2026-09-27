import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { createPostSchema, schedulePostSchema, type DraftDetail } from '@yapilapi/shared';
import { z } from 'zod';
import { notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { hydratePosts } from '../lib/posts.ts';
import { track } from '../lib/services.ts';
import { requireVerified } from '../lib/verification.ts';
import { publishDraft, schedulePost, scheduleTime, writePost } from '../lib/publishing.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Your drafts and scheduled posts. Only their author ever gets them: every
 * route here matches the post on its author, and every other listing of posts
 * leaves them out (postVisibleSql). A draft can be opened to continue, saved
 * again, scheduled, published now or deleted; a scheduled post can be moved to
 * another time, published now or cancelled (it goes back to the drafts).
 */
export default async function draftsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /** The draft's state, when it's yours and not published or deleted. */
  async function ownDraft(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT id, status, visibility, community_id, circle_id FROM posts WHERE id = $1 AND author_id = $2 AND status <> 'published' AND deleted_at IS NULL`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('That draft');
    return rows[0] as { id: string; status: 'draft' | 'scheduled'; visibility: string; community_id: string | null; circle_id: string | null };
  }

  async function hydrated(id: string, userId: string) {
    const [post] = await hydratePosts(db, [id], userId);
    return post!;
  }

  /** Scheduled posts first (soonest first), then drafts (last saved first). */
  app.get('/v1/me/drafts', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT id FROM posts WHERE author_id = $1 AND status <> 'published' AND deleted_at IS NULL
       ORDER BY status = 'scheduled' DESC, scheduled_at, updated_at DESC, id LIMIT 200`,
      [u.id],
    );
    return {
      items: await hydratePosts(
        db,
        rows.map((r) => r.id),
        u.id,
      ),
    };
  });

  /** Open a draft to continue: the post, plus the circle or people it's for. */
  app.get('/v1/drafts/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const d = await ownDraft(id, u.id);
    const audience = await db.query<{ user_id: string }>(`SELECT user_id FROM post_audience WHERE post_id = $1 ORDER BY user_id`, [id]);
    return { post: await hydrated(id, u.id), circleId: d.circle_id, audience: audience.rows.map((r) => r.user_id) } satisfies DraftDetail;
  });

  /**
   * Save a draft (or a scheduled post) again with what the composer has now. It
   * stays a draft, or scheduled at the same time, unless `scheduledAt` moves it.
   */
  app.put('/v1/drafts/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(createPostSchema, req.body);
    const at = input.scheduledAt ? scheduleTime(input.scheduledAt) : null;
    if (at && (input.visibility === 'public' || input.communityId)) await requireVerified(db, ctx.config, u.id, 'post');
    await tx(db, async (c) => {
      await writePost(c, u.id, input, { id, state: 'draft' });
      if (at) await schedulePost(c, id, u.id, at);
    });
    return { post: await hydrated(id, u.id) };
  });

  /** Publish a draft or scheduled post now, through the same checks as a new post. */
  app.post('/v1/drafts/:id/publish', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { notice } = await publishDraft(ctx, id, u.id);
    return { post: await hydrated(id, u.id), moderation: notice };
  });

  /** Schedule a draft, or move a scheduled post to another time. */
  app.put('/v1/drafts/:id/schedule', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const at = scheduleTime(parse(schedulePostSchema, req.body).scheduledAt);
    const d = await ownDraft(id, u.id);
    if (d.visibility === 'public' || d.community_id) await requireVerified(db, ctx.config, u.id, 'post');
    await tx(db, (c) => schedulePost(c, id, u.id, at));
    track(db, u.id, 'post_scheduled', { visibility: d.visibility });
    return { post: await hydrated(id, u.id) };
  });

  /** Cancel a scheduled post: it goes back to your drafts. */
  app.delete('/v1/drafts/:id/schedule', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = now() WHERE id = $1 AND author_id = $2 AND status = 'scheduled' AND deleted_at IS NULL`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('That scheduled post');
    return { post: await hydrated(id, u.id) };
  });

  /** Delete a draft or scheduled post. Published posts are deleted with DELETE /v1/posts/:id. */
  app.delete('/v1/drafts/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE posts SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND status <> 'published' AND deleted_at IS NULL`, [
      id,
      u.id,
    ]);
    if (!r.rowCount) throw notFound('That draft');
    return { ok: true };
  });
}
