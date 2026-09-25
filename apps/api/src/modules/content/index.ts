import { z } from 'zod';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
  visibilitySchema,
} from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { resolveUser } from '../../lib/users.js';
import { screenText } from '../../lib/moderation-hook.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { hasCommunityPermission } from '../../lib/community-access.js';
import { loadVisiblePost, postVisibleSql } from '../../lib/visibility.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import type { ApiModule } from '../types.js';
import { createPost, deletePostAsAuthor } from './service.js';
import type { DbRow } from '../../lib/db-row.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const REACTIONS = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'] as const;

const createPostBody = z.object({
  body: z.string().max(10_000).default(''),
  visibility: visibilitySchema.optional(),
  circleId: z.uuid().optional(),
  audience: z.array(z.uuid()).max(100).optional(),
  communityId: z.uuid().optional(),
  topics: z.array(z.string().min(1).max(50)).max(10).optional(),
  mediaIds: z.array(z.uuid()).max(10).optional(),
  poll: z
    .object({
      question: z.string().trim().min(1).max(300),
      options: z.array(z.string().trim().min(1).max(200)).min(2).max(6),
      multiple: z.boolean().default(false),
      closesInHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .optional(),
    })
    .optional(),
  linkUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  placeId: z.uuid().optional(),
  language: z.string().min(2).max(10).optional(),
  license: z.enum(['all_rights_reserved', 'cc_by', 'cc_by_nc', 'cc0']).optional(),
  aiAssistance: z.object({ tools: z.array(z.string().max(40)).min(1).max(5) }).optional(),
});

const editPostBody = z.object({ body: z.string().max(10_000) });
const commentBody = z.object({
  body: z.string().trim().min(1).max(4000),
  parentId: z.uuid().optional(),
});

type Cursor = { t: string; id: string };

export const contentModule: ApiModule = {
  name: 'content',
  register(app, ctx) {
    registerDeletionHook(async (_ctx, tx, userId) => {
      await tx.query(
        'UPDATE posts SET deleted_at = now() WHERE author_id = $1 AND deleted_at IS NULL',
        [userId],
      );
      await tx.query(
        'UPDATE comments SET deleted_at = now() WHERE author_id = $1 AND deleted_at IS NULL',
        [userId],
      );
      await tx.query('DELETE FROM reactions WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM saves WHERE user_id = $1', [userId]);
    });

    // ------------------------------------------------------------------ posts
    route(app, ctx, {
      method: 'POST',
      url: '/v1/posts',
      summary: 'Create a post',
      tags: ['content'],
      auth: 'user',
      body: createPostBody,
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        const id = await createPost(ctx, { userId: auth.userId, ageBand: auth.ageBand }, body);
        ctx.metrics.events.inc({ name: 'post_created' });
        await audit(
          ctx,
          { actorId: auth.userId, action: 'post.created', targetType: 'post', targetId: id },
          req,
        );
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2`,
          [auth.userId, id],
        );
        void reply.code(201);
        return (await hydratePosts(ctx, auth.userId, rows))[0];
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/posts/:id',
      summary: 'Get a post',
      tags: ['content'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const viewer = auth?.userId ?? null;
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2 AND ${postVisibleSql('$1::uuid')}`,
          [viewer, params.id],
        );
        if (!rows[0]) throw notFound('Post');
        return (await hydratePosts(ctx, viewer, rows))[0];
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/posts/:id',
      summary: 'Edit your post text',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: editPostBody,
      handler: async ({ auth, params, body }) => {
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `UPDATE posts SET body = $3, edited_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL AND moderation_status <> 'removed'`,
            [params.id, auth.userId, body.body.trim()],
          );
          if (!r.rowCount) throw notFound('Post');
          await screenText(ctx, tx, {
            type: 'post',
            id: params.id,
            authorId: auth.userId,
            text: body.body,
          });
        });
        return { updated: true };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/posts/:id',
      summary: 'Delete your post',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await deletePostAsAuthor(ctx, params.id, auth.userId);
        await audit(
          ctx,
          { actorId: auth.userId, action: 'post.deleted', targetType: 'post', targetId: params.id },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username/posts',
      summary: "A user's posts (only those you may see)",
      tags: ['content'],
      auth: 'optional',
      params: z.object({ username: z.string().min(1).max(40) }),
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const target = await resolveUser(ctx, viewer, params.username);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom}
            WHERE p.author_id = $2 AND ${postVisibleSql('$1::uuid')}
              AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
            ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
          [viewer, target.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydratePosts(ctx, viewer, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    // ------------------------------------------------------------------ reactions / saves / shares / views
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/posts/:id/reaction',
      summary: 'React to a post',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(REACTIONS).default('like') }),
      rateLimit: { limit: 300, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) => {
        const post = await loadVisiblePost<{ author_id: string }>(ctx.db, auth.userId, params.id);
        if (!post) throw notFound('Post');
        const inserted = await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query<{ inserted: boolean }>(
            `INSERT INTO reactions (user_id, target_type, target_id, kind) VALUES ($1,'post',$2,$3)
             ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING (xmax = 0) AS inserted`,
            [auth.userId, params.id, body.kind],
          );
          if (r.rows[0]!.inserted)
            await tx.query('UPDATE posts SET like_count = like_count + 1 WHERE id = $1', [
              params.id,
            ]);
          return r.rows[0]!.inserted;
        });
        if (inserted)
          await notify(ctx, {
            userId: post.author_id,
            kind: 'reaction',
            actorId: auth.userId,
            targetType: 'post',
            targetId: params.id,
            data: { reaction: body.kind },
          });
        const c = await ctx.db.query<{ like_count: number }>(
          'SELECT like_count FROM posts WHERE id = $1',
          [params.id],
        );
        return { reaction: body.kind, likes: c.rows[0]!.like_count };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/posts/:id/reaction',
      summary: 'Remove your reaction',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `DELETE FROM reactions WHERE user_id = $1 AND target_type = 'post' AND target_id = $2`,
            [auth.userId, params.id],
          );
          if (r.rowCount)
            await tx.query(
              'UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
              [params.id],
            );
        });
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/posts/:id/save',
      summary: 'Save a post',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: z.object({ collection: z.string().trim().min(1).max(40).default('default') }),
      handler: async ({ auth, params, body }) => {
        if (!(await loadVisiblePost(ctx.db, auth.userId, params.id))) throw notFound('Post');
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `INSERT INTO saves (user_id, target_type, target_id, collection) VALUES ($1,'post',$2,$3) ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET collection = EXCLUDED.collection RETURNING (xmax = 0) AS inserted`,
            [auth.userId, params.id, body.collection],
          );
          if (r.rows[0]!.inserted)
            await tx.query('UPDATE posts SET save_count = save_count + 1 WHERE id = $1', [
              params.id,
            ]);
        });
        return { saved: true };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/posts/:id/save',
      summary: 'Unsave a post',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `DELETE FROM saves WHERE user_id = $1 AND target_type = 'post' AND target_id = $2`,
            [auth.userId, params.id],
          );
          if (r.rowCount)
            await tx.query(
              'UPDATE posts SET save_count = GREATEST(save_count - 1, 0) WHERE id = $1',
              [params.id],
            );
        });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/saved',
      summary: 'Your saved posts',
      tags: ['content'],
      auth: 'user',
      query: pageQuery.extend({ collection: z.string().max(40).optional() }),
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')}, s.created_at AS saved_at FROM saves s JOIN ${postFrom} ON p.id = s.target_id
            WHERE s.user_id = $1 AND s.target_type = 'post' AND ($2::text IS NULL OR s.collection = $2)
              AND ${postVisibleSql('$1::uuid')}
              AND ($3::timestamptz IS NULL OR (s.created_at, p.id) < ($3::timestamptz, $4::uuid))
            ORDER BY s.created_at DESC, p.id DESC LIMIT $5`,
          [auth.userId, query.collection ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydratePosts(ctx, auth.userId, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.saved_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/posts/:id/share',
      summary: 'Record a share of a post',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: z.object({
        channel: z.enum(['repost', 'message', 'external']).default('external'),
        comment: z.string().max(500).optional(),
      }),
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body, reply }) => {
        const post = await loadVisiblePost<{ visibility: string }>(ctx.db, auth.userId, params.id);
        if (!post) throw notFound('Post');
        // Only public posts can leave the platform or be re-shared beyond their audience.
        if (post.visibility !== 'public') throw forbidden('Only public posts can be shared');
        await withTransaction(ctx.db, async (tx) => {
          await tx.query(
            'INSERT INTO shares (user_id, post_id, comment, channel) VALUES ($1,$2,$3,$4)',
            [auth.userId, params.id, body.comment ?? null, body.channel],
          );
          await tx.query('UPDATE posts SET share_count = share_count + 1 WHERE id = $1', [
            params.id,
          ]);
        });
        void reply.code(201);
        return { shared: true };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/posts/:id/view',
      summary: 'Record a view (deduplicated per viewer per hour)',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const hit = await ctx.limiter.hit(`view:${auth.userId}:${params.id}`, 1, 3600);
        if (!hit.allowed) return { counted: false };
        if (!(await loadVisiblePost(ctx.db, auth.userId, params.id))) throw notFound('Post');
        await ctx.db.query('UPDATE posts SET view_count = view_count + 1 WHERE id = $1', [
          params.id,
        ]);
        return { counted: true };
      },
    });

    // ------------------------------------------------------------------ polls
    route(app, ctx, {
      method: 'POST',
      url: '/v1/posts/:id/poll/vote',
      summary: 'Vote in a poll',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: z.object({ optionIds: z.array(z.uuid()).min(1).max(6) }),
      handler: async ({ auth, params, body }) => {
        if (!(await loadVisiblePost(ctx.db, auth.userId, params.id))) throw notFound('Post');
        await withTransaction(ctx.db, async (tx) => {
          const poll = await tx.query<{ multiple: boolean; closes_at: Date | null }>(
            'SELECT multiple, closes_at FROM polls WHERE post_id = $1 FOR SHARE',
            [params.id],
          );
          if (!poll.rows[0]) throw notFound('Poll');
          if (poll.rows[0].closes_at && poll.rows[0].closes_at < new Date())
            throw conflict('This poll has closed');
          const optionIds = [...new Set(body.optionIds)];
          if (!poll.rows[0].multiple && optionIds.length > 1)
            throw invalid('This poll allows one choice');
          const valid = await tx.query(
            'SELECT id FROM poll_options WHERE post_id = $1 AND id = ANY($2::uuid[])',
            [params.id, optionIds],
          );
          if (valid.rowCount !== optionIds.length) throw invalid('Unknown poll option');
          const already = await tx.query(
            'SELECT 1 FROM poll_votes WHERE post_id = $1 AND user_id = $2',
            [params.id, auth.userId],
          );
          if (already.rowCount) throw conflict('You have already voted');
          for (const optionId of optionIds) {
            await tx.query(
              'INSERT INTO poll_votes (option_id, post_id, user_id) VALUES ($1,$2,$3)',
              [optionId, params.id, auth.userId],
            );
            await tx.query('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = $1', [
              optionId,
            ]);
          }
        });
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2`,
          [auth.userId, params.id],
        );
        return (await hydratePosts(ctx, auth.userId, rows))[0]!.poll;
      },
    });

    // ------------------------------------------------------------------ comments
    const commentSelect = `c.id, c.post_id, c.parent_id, c.body, c.like_count, c.reply_count, c.hidden_by_restriction, c.moderation_status, c.edited_at, c.created_at,
      pr.user_id AS author_id, pr.username, pr.display_name, pr.avatar_url,
      (SELECT r.kind FROM reactions r WHERE r.user_id = $1::uuid AND r.target_type = 'comment' AND r.target_id = c.id) AS my_reaction`;
    const commentVisible = `c.deleted_at IS NULL
      AND (c.moderation_status = 'approved' OR c.author_id = $1::uuid)
      AND (c.hidden_by_restriction = false OR c.author_id = $1::uuid OR po.author_id = $1::uuid)
      AND ($1::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1::uuid AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = $1::uuid)))`;
    const toComment = (r: DbRow, viewer: string | null) => ({
      id: r.id,
      postId: r.post_id,
      parentId: r.parent_id,
      body: r.body,
      author: {
        id: r.author_id,
        username: r.username,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
      },
      counts: { likes: r.like_count, replies: r.reply_count },
      viewer: { reaction: r.my_reaction ?? null, isAuthor: viewer === r.author_id },
      pendingApproval: r.hidden_by_restriction,
      moderationStatus: r.moderation_status,
      editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/posts/:id/comments',
      summary: 'Comment on a post (or reply to a comment)',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: commentBody,
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body, reply }) => {
        const post = await loadVisiblePost<{
          author_id: string;
          community_id: string | null;
          visibility: string;
        }>(ctx.db, auth.userId, params.id);
        if (!post) throw notFound('Post');
        if (
          post.community_id &&
          !(await hasCommunityPermission(ctx.db, post.community_id, auth.userId, 'comment'))
        )
          throw forbidden('Join this community to comment');
        let parentId: string | null = null;
        let parentAuthor: string | null = null;
        if (body.parentId) {
          const p = await ctx.db.query<{ id: string; parent_id: string | null; author_id: string }>(
            'SELECT id, parent_id, author_id FROM comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL',
            [body.parentId, params.id],
          );
          if (!p.rows[0]) throw notFound('Comment');
          parentId = p.rows[0].parent_id ?? p.rows[0].id; // one level of nesting; replies to replies attach to the thread root
          parentAuthor = p.rows[0].author_id;
        }
        const restricted = await ctx.db.query(
          'SELECT 1 FROM user_restrictions WHERE restrictor_id = $1 AND restricted_id = $2',
          [post.author_id, auth.userId],
        );
        const id = await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO comments (post_id, author_id, parent_id, body, hidden_by_restriction) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [params.id, auth.userId, parentId, body.body, Boolean(restricted.rowCount)],
          );
          await tx.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [
            params.id,
          ]);
          if (parentId)
            await tx.query('UPDATE comments SET reply_count = reply_count + 1 WHERE id = $1', [
              parentId,
            ]);
          await screenText(ctx, tx, {
            type: 'comment',
            id: r.rows[0]!.id,
            authorId: auth.userId,
            text: body.body,
          });
          return r.rows[0]!.id;
        });
        if (!restricted.rowCount) {
          await notify(ctx, {
            userId: post.author_id,
            kind: 'comment',
            actorId: auth.userId,
            targetType: 'post',
            targetId: params.id,
            data: { commentId: id },
          });
          if (parentAuthor && parentAuthor !== post.author_id)
            await notify(ctx, {
              userId: parentAuthor,
              kind: 'reply',
              actorId: auth.userId,
              targetType: 'post',
              targetId: params.id,
              data: { commentId: id },
            });
        }
        ctx.metrics.events.inc({ name: 'comment_created' });
        const { rows } = await ctx.db.query(
          `SELECT ${commentSelect} FROM comments c JOIN profiles pr ON pr.user_id = c.author_id WHERE c.id = $2`,
          [auth.userId, id],
        );
        void reply.code(201);
        return toComment(rows[0]!, auth.userId);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/posts/:id/comments',
      summary: 'List top-level comments',
      tags: ['content'],
      auth: 'optional',
      params: idParams,
      query: pageQuery.extend({ sort: z.enum(['new', 'old']).default('old') }),
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        if (!(await loadVisiblePost(ctx.db, viewer, params.id))) throw notFound('Post');
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const asc = query.sort === 'old';
        const { rows } = await ctx.db.query(
          `SELECT ${commentSelect} FROM comments c JOIN profiles pr ON pr.user_id = c.author_id JOIN posts po ON po.id = c.post_id
            WHERE c.post_id = $2 AND c.parent_id IS NULL AND ${commentVisible}
              AND ($3::timestamptz IS NULL OR (c.created_at, c.id) ${asc ? '>' : '<'} ($3::timestamptz, $4::uuid))
            ORDER BY c.created_at ${asc ? 'ASC' : 'DESC'}, c.id ${asc ? 'ASC' : 'DESC'} LIMIT $5`,
          [viewer, params.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => toComment(r, viewer)),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/comments/:id/replies',
      summary: 'List replies to a comment',
      tags: ['content'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const parent = await ctx.db.query<{ post_id: string }>(
          'SELECT post_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
          [params.id],
        );
        if (!parent.rows[0] || !(await loadVisiblePost(ctx.db, viewer, parent.rows[0].post_id)))
          throw notFound('Comment');
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${commentSelect} FROM comments c JOIN profiles pr ON pr.user_id = c.author_id JOIN posts po ON po.id = c.post_id
            WHERE c.parent_id = $2 AND ${commentVisible}
              AND ($3::timestamptz IS NULL OR (c.created_at, c.id) > ($3::timestamptz, $4::uuid))
            ORDER BY c.created_at ASC, c.id ASC LIMIT $5`,
          [viewer, params.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => toComment(r, viewer)),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/comments/:id',
      summary: 'Edit your comment',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: z.object({ body: z.string().trim().min(1).max(4000) }),
      handler: async ({ auth, params, body }) => {
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `UPDATE comments SET body = $3, edited_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`,
            [params.id, auth.userId, body.body],
          );
          if (!r.rowCount) throw notFound('Comment');
          await screenText(ctx, tx, {
            type: 'comment',
            id: params.id,
            authorId: auth.userId,
            text: body.body,
          });
        });
        return { updated: true };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/comments/:id',
      summary: 'Delete a comment (yours, or on your post)',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const found = await ctx.db.query<{
          post_id: string;
          parent_id: string | null;
          author_id: string;
          post_author: string;
          community_id: string | null;
        }>(
          `SELECT c.post_id, c.parent_id, c.author_id, po.author_id AS post_author, po.community_id FROM comments c JOIN posts po ON po.id = c.post_id WHERE c.id = $1 AND c.deleted_at IS NULL`,
          [params.id],
        );
        const c = found.rows[0];
        if (!c) throw notFound('Comment');
        const allowed =
          c.author_id === auth.userId ||
          c.post_author === auth.userId ||
          (c.community_id !== null &&
            (await hasCommunityPermission(ctx.db, c.community_id, auth.userId, 'moderate')));
        if (!allowed) throw notFound('Comment'); // do not reveal existence to others
        await withTransaction(ctx.db, async (tx) => {
          await tx.query('UPDATE comments SET deleted_at = now() WHERE id = $1', [params.id]);
          await tx.query(
            'UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1',
            [c.post_id],
          );
          if (c.parent_id)
            await tx.query(
              'UPDATE comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1',
              [c.parent_id],
            );
        });
        if (c.author_id !== auth.userId)
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'comment.removed_by_owner_or_mod',
              targetType: 'comment',
              targetId: params.id,
            },
            req,
          );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/comments/:id/approve',
      summary: 'Approve a comment from a restricted account',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query(
          `UPDATE comments c SET hidden_by_restriction = false FROM posts po WHERE po.id = c.post_id AND po.author_id = $2 AND c.id = $1 AND c.hidden_by_restriction`,
          [params.id, auth.userId],
        );
        if (!r.rowCount) throw notFound('Comment');
        return { approved: true };
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/comments/:id/reaction',
      summary: 'React to a comment',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(REACTIONS).default('like') }),
      handler: async ({ auth, params, body }) => {
        const c = await ctx.db.query<{ post_id: string }>(
          'SELECT post_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
          [params.id],
        );
        if (!c.rows[0] || !(await loadVisiblePost(ctx.db, auth.userId, c.rows[0].post_id)))
          throw notFound('Comment');
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query<{ inserted: boolean }>(
            `INSERT INTO reactions (user_id, target_type, target_id, kind) VALUES ($1,'comment',$2,$3) ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING (xmax = 0) AS inserted`,
            [auth.userId, params.id, body.kind],
          );
          if (r.rows[0]!.inserted)
            await tx.query('UPDATE comments SET like_count = like_count + 1 WHERE id = $1', [
              params.id,
            ]);
        });
        return { reaction: body.kind };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/comments/:id/reaction',
      summary: 'Remove your reaction from a comment',
      tags: ['content'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `DELETE FROM reactions WHERE user_id = $1 AND target_type = 'comment' AND target_id = $2`,
            [auth.userId, params.id],
          );
          if (r.rowCount)
            await tx.query(
              'UPDATE comments SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
              [params.id],
            );
        });
      },
    });
    void AppError;
  },
};
