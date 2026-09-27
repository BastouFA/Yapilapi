import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  COMMENT_EDIT_MINUTES,
  commentPolicySchema,
  commentSchema,
  commentsQuerySchema,
  editCommentSchema,
  extractHashtags,
  hiddenWordsSchema,
  pageQuerySchema,
  pinCommentSchema,
  type CommentPage,
  type CommentPolicy,
  type PublicUser,
} from '@yapilapi/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import {
  applyHiddenWords,
  closedMessage,
  COMMENT_FROM,
  commentAllowedSql,
  commentVisibleSql,
  hiddenWordsOf,
  loadComments,
  normalizeWords,
  reachesOthers,
  screenComment,
  syncCommentCounts,
  topScoreSql,
  type CommentScreening,
} from '../lib/comments.ts';
import { notifyMentions } from '../lib/mentions.ts';
import { langOf } from '../lib/translation.ts';
import { notify, track } from '../lib/services.ts';
import { flagContent, recordSignals } from '../lib/spam.ts';
import { plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

interface PostInfo {
  author_id: string;
  comment_policy: CommentPolicy;
  pinned_comment_id: string | null;
  can_comment: boolean;
}

/**
 * Comments: threads with one visible level of nesting, likes, a pinned
 * comment, edits within COMMENT_EDIT_MINUTES, the author's comment controls
 * (who can comment) and hidden words. Every read goes through the post's
 * visibility and the viewer's blocks; counts leave out removed, held and hidden comments.
 */
export default async function commentsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /** The post, if the viewer can see and open it, with what its comment controls allow them. */
  async function openPost(postId: string, viewer: string | null): Promise<PostInfo> {
    const { rows } = await db.query(
      `SELECT p.author_id, p.comment_policy, p.pinned_comment_id, coalesce(${postUnlockedSql('$1')}, false) AS unlocked,
              coalesce(${commentAllowedSql('$1')}, false) AS can_comment
       ${POST_FROM} WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
      [viewer, postId],
    );
    const r = rows[0];
    if (!r) throw notFound('That post');
    if (!r.unlocked) throw new AppError(403, 'subscribers_only', 'This post is for subscribers. Subscribe to see it.');
    return r as PostInfo;
  }

  /** A comment the viewer can see, on a post they can see and open. */
  async function visibleComment(commentId: string, viewer: string | null) {
    const { rows } = await db.query(
      `SELECT cm.id, cm.post_id, cm.parent_id, cm.author_id, cm.body, cm.created_at, cm.hidden_at, cm.moderation_status
       FROM comments cm JOIN posts p ON p.id = cm.post_id WHERE cm.id = $2 AND ${commentVisibleSql('$1')}`,
      [viewer, commentId],
    );
    const c = rows[0];
    if (!c) throw notFound('That comment');
    const post = await openPost(c.post_id, viewer);
    // A reply is only reachable while its thread is.
    if (c.parent_id) {
      const parent = await db.query(`SELECT 1 FROM comments cm JOIN posts p ON p.id = cm.post_id WHERE cm.id = $2 AND ${commentVisibleSql('$1')}`, [
        viewer,
        c.parent_id,
      ]);
      if (!parent.rowCount) throw notFound('That comment');
    }
    return { comment: c, post };
  }

  function assertCanComment(post: PostInfo) {
    if (!post.can_comment) throw new AppError(403, 'comments_closed', closedMessage(post.comment_policy));
  }

  /** Flagged comments go to a moderator with the signals that flagged them. */
  async function recordCommentFlags(c: PoolClient, userId: string, commentId: string, s: CommentScreening) {
    if (s.risk !== 'normal' || s.spam.flags.length)
      await c.query(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('comment',$1,$2,'automated',$3,$4) ON CONFLICT DO NOTHING`,
        [
          commentId,
          userId,
          s.risk !== 'normal' ? s.risk : 'review',
          { signals: [...s.signals, ...s.spam.flags.map((f) => f.kind)], ...(s.spam.flags.length ? { spam: s.spam.flags } : {}) },
        ],
      );
    await flagContent(c, ctx.realtime, userId, { type: 'comment', id: commentId }, s.spam.flags);
    if (s.spam.restricted) await recordSignals(c, userId, [{ kind: 'held_while_limited', weight: 0 }], { type: 'comment', id: commentId });
  }

  // ── Reading ───────────────────────────────────────────────────────────

  /**
   * Top-level comments, Top (default) or Newest. The pinned comment comes
   * first on the first page. Replies are loaded per thread (GET /v1/comments/:id/replies).
   */
  app.get('/v1/posts/:id/comments', async (req): Promise<CommentPage> => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(commentsQuerySchema, req.query);
    const post = await openPost(id, viewer);
    const base = `${COMMENT_FROM} WHERE cm.post_id = $2 AND cm.parent_id IS NULL AND ${commentVisibleSql('$1')}
                  AND cm.id IS DISTINCT FROM p.pinned_comment_id`;
    let ids: string[];
    let nextCursor: string | null;
    if (q.sort === 'newest') {
      const c = decodeCursor<KeyCursor>(q.cursor);
      const { rows } = await db.query(
        `SELECT cm.id, cm.created_at::text AS created_at ${base} ${c ? 'AND (cm.created_at, cm.id) < ($4::timestamptz, $5::uuid)' : ''}
         ORDER BY cm.created_at DESC, cm.id DESC LIMIT $3`,
        c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
      );
      ids = rows.slice(0, q.limit).map((r) => r.id);
      nextCursor = rows.length > q.limit ? keyCursorOf(rows[q.limit - 1]) : null;
    } else {
      const c = decodeCursor<{ asOf: string; o: number }>(q.cursor) ?? {
        asOf: (await db.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0]!.t,
        o: 0,
      };
      if (typeof c.o !== 'number' || c.o < 0 || Number.isNaN(Date.parse(c.asOf))) throw badRequest('Invalid cursor.');
      const { rows } = await db.query(
        `SELECT cm.id ${base} AND cm.created_at <= $3::timestamptz
         ORDER BY ${topScoreSql('$3')} DESC, cm.created_at DESC, cm.id DESC LIMIT $4 OFFSET $5`,
        [viewer, id, c.asOf, q.limit + 1, c.o],
      );
      ids = rows.slice(0, q.limit).map((r) => r.id);
      nextCursor = rows.length > q.limit ? encodeCursor({ asOf: c.asOf, o: c.o + q.limit }) : null;
    }
    if (!q.cursor && post.pinned_comment_id) {
      const pinned = await db.query(`SELECT cm.id ${COMMENT_FROM} WHERE cm.id = $2 AND cm.parent_id IS NULL AND ${commentVisibleSql('$1')}`, [
        viewer,
        post.pinned_comment_id,
      ]);
      if (pinned.rowCount) ids = [post.pinned_comment_id, ...ids];
    }
    const isPostAuthor = !!viewer && viewer === post.author_id;
    const hiddenCount = isPostAuthor
      ? Number((await db.query(`SELECT count(*) AS n FROM comments WHERE post_id = $1 AND hidden_at IS NOT NULL AND deleted_at IS NULL`, [id])).rows[0].n)
      : undefined;
    return {
      items: await loadComments(db, ids, viewer),
      nextCursor,
      commentPolicy: post.comment_policy,
      canComment: post.can_comment,
      isPostAuthor,
      ...(hiddenCount === undefined ? {} : { hiddenCount }),
    };
  });

  /** The replies in a thread, oldest first. */
  app.get('/v1/comments/:id/replies', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    const { comment } = await visibleComment(id, viewer);
    if (comment.parent_id) throw badRequest('Replies are listed on the top-level comment of a thread.');
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT cm.id, cm.created_at::text AS created_at ${COMMENT_FROM} WHERE cm.parent_id = $2 AND ${commentVisibleSql('$1')}
         ${c ? 'AND (cm.created_at, cm.id) > ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY cm.created_at, cm.id LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await loadComments(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  // ── Writing ───────────────────────────────────────────────────────────

  /**
   * Comment, or reply with `parentId`. A reply to a reply joins the top-level
   * thread and still tells the person it answered. The post's comment
   * controls, blocks, safety and spam checks and the author's hidden words apply.
   */
  app.post('/v1/posts/:id/comments', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(commentSchema, req.body);
    const post = await openPost(id, u.id);
    assertCanComment(post);
    let parentId: string | null = null;
    let replyTo: { id: string; author_id: string } | null = null;
    if (input.parentId) {
      const target = await db.query(
        `SELECT cm.id, cm.parent_id, cm.author_id FROM comments cm JOIN posts p ON p.id = cm.post_id
         WHERE cm.id = $2 AND cm.post_id = $3 AND ${commentVisibleSql('$1')}`,
        [u.id, input.parentId, id],
      );
      const t = target.rows[0];
      if (!t) throw notFound('The comment you replied to');
      parentId = t.parent_id ?? t.id;
      replyTo = { id: t.id, author_id: t.author_id };
      if (t.parent_id) {
        const root = await db.query(`SELECT 1 FROM comments cm JOIN posts p ON p.id = cm.post_id WHERE cm.id = $2 AND ${commentVisibleSql('$1')}`, [
          u.id,
          t.parent_id,
        ]);
        if (!root.rowCount) throw notFound('The comment you replied to');
      }
    }
    const screening = await screenComment(db, ctx.config, { userId: u.id, postId: id, postAuthorId: post.author_id, body: input.body });
    const commentId = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO comments (post_id, author_id, parent_id, reply_to_id, body, moderation_status, topics, hidden_at, lang)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8 THEN now() END, $9) RETURNING id`,
        // #tags in a comment count on the tag's page; its language drives "See translation".
        [id, u.id, parentId, replyTo?.id ?? null, input.body, screening.status, extractHashtags(input.body), screening.hidden, langOf(input.body)],
      );
      await syncCommentCounts(c, id);
      await recordCommentFlags(c, u.id, rows[0].id, screening);
      return rows[0].id as string;
    });
    // Hidden, held and limited comments reach no one else, so they notify no one.
    if (reachesOthers(screening)) {
      if (replyTo && replyTo.author_id !== u.id)
        await notify(db, ctx.realtime, {
          userId: replyTo.author_id,
          category: 'friends',
          type: 'comment_reply',
          actorId: u.id,
          entityType: 'post',
          entityId: id,
          data: { commentId, replyToId: replyTo.id },
          group: `reply:${replyTo.id}`,
        });
      if (replyTo?.author_id !== post.author_id)
        await notify(db, ctx.realtime, {
          userId: post.author_id,
          category: 'creators',
          type: 'post_comment',
          actorId: u.id,
          entityType: 'post',
          entityId: id,
          data: { commentId },
        });
      if (screening.status === 'normal')
        await notifyMentions(db, ctx.realtime, {
          text: input.body,
          actorId: u.id,
          postId: id,
          commentId,
          skip: [post.author_id, ...(replyTo ? [replyTo.author_id] : [])],
        });
    }
    track(db, u.id, 'comment_created', parentId ? { reply: true } : {});
    reply.code(201);
    const [comment] = await loadComments(db, [commentId], u.id);
    return { comment: comment! };
  });

  /**
   * Edit your comment within COMMENT_EDIT_MINUTES. It goes through the same
   * checks as a new comment; people mentioned for the first time are told,
   * people mentioned before aren't told again.
   */
  app.patch('/v1/comments/:id', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { body } = parse(editCommentSchema, req.body);
    const { rows } = await db.query(
      `SELECT cm.id, cm.post_id, cm.author_id, cm.body, cm.moderation_status, cm.hidden_at,
              cm.created_at > now() - make_interval(mins => $2) AS editable
       FROM comments cm WHERE cm.id = $1 AND cm.deleted_at IS NULL`,
      [id, COMMENT_EDIT_MINUTES],
    );
    const cm = rows[0];
    if (!cm) throw notFound('That comment');
    if (cm.author_id !== u.id) throw forbidden('Only the person who wrote a comment can edit it.');
    if (!cm.editable) throw new AppError(403, 'edit_window_closed', `Comments can be edited for ${COMMENT_EDIT_MINUTES} minutes after posting.`);
    const post = await openPost(cm.post_id, u.id);
    assertCanComment(post);
    if (body !== cm.body) {
      const screening = await screenComment(db, ctx.config, { userId: u.id, postId: cm.post_id, postAuthorId: post.author_id, body });
      // An edit never lifts a hold: the stricter of the old and new status stays until a moderator looks.
      const rank = { normal: 0, review: 1, restricted: 2 } as const;
      const current = cm.moderation_status as keyof typeof rank;
      const status = (rank[current] ?? 2) >= rank[screening.status] ? current : screening.status;
      const previously = [
        ...(await db.query<{ body: string }>(`SELECT body FROM comment_edits WHERE comment_id = $1`, [id])).rows.map((r) => r.body),
        cm.body as string,
      ];
      await tx(db, async (c) => {
        await c.query(`INSERT INTO comment_edits (comment_id, body) VALUES ($1,$2)`, [id, cm.body]);
        await c.query(
          // A new text drops its cached translations (trigger in 0035) and gets its language again.
          `UPDATE comments SET body = $2, topics = $3, moderation_status = $4, edited_at = now(), lang = $6,
                  hidden_at = CASE WHEN $5 THEN coalesce(hidden_at, now()) END,
                  unhidden_at = CASE WHEN $5 THEN NULL ELSE unhidden_at END
           WHERE id = $1`,
          [id, body, extractHashtags(body), status, screening.hidden, langOf(body)],
        );
        if (screening.hidden) await c.query(`UPDATE posts SET pinned_comment_id = NULL WHERE pinned_comment_id = $1`, [id]);
        await syncCommentCounts(c, cm.post_id);
        await recordCommentFlags(c, u.id, id, screening);
      });
      if (reachesOthers({ ...screening, status }) && status === 'normal')
        await notifyMentions(db, ctx.realtime, { text: body, actorId: u.id, postId: cm.post_id, commentId: id, previously });
    }
    const [comment] = await loadComments(db, [id], u.id);
    return { comment: comment! };
  });

  /** The writer or the post's author removes a comment; removing a top-level comment removes its thread. */
  app.delete('/v1/comments/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const postId = await tx(db, async (c) => {
      const r = await c.query(
        `UPDATE comments cm SET deleted_at = now() FROM posts p
         WHERE cm.id = $1 AND p.id = cm.post_id AND cm.deleted_at IS NULL AND (cm.author_id = $2 OR p.author_id = $2) RETURNING cm.post_id, cm.parent_id`,
        [id, u.id],
      );
      if (!r.rowCount) throw notFound('Comment');
      if (!r.rows[0].parent_id) await c.query(`UPDATE comments SET deleted_at = now() WHERE parent_id = $1 AND deleted_at IS NULL`, [id]);
      await c.query(`UPDATE posts SET pinned_comment_id = NULL WHERE pinned_comment_id = $1`, [id]);
      await syncCommentCounts(c, r.rows[0].post_id);
      return r.rows[0].post_id as string;
    });
    const count = (await db.query(`SELECT comment_count FROM posts WHERE id = $1`, [postId])).rows[0]?.comment_count ?? 0;
    return { ok: true, comments: count };
  });

  // ── Likes ─────────────────────────────────────────────────────────────

  app.put('/v1/comments/:id/like', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { comment } = await visibleComment(id, u.id);
    if (comment.hidden_at || !['normal', 'review'].includes(comment.moderation_status)) throw notFound('That comment');
    const inserted = await tx(db, async (c) => {
      const r = await c.query(`INSERT INTO comment_likes (comment_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
      if (r.rowCount) await c.query(`UPDATE comments SET like_count = like_count + 1 WHERE id = $1`, [id]);
      return !!r.rowCount;
    });
    if (inserted && comment.author_id !== u.id)
      await notify(db, ctx.realtime, {
        userId: comment.author_id,
        category: 'creators',
        type: 'comment_like',
        actorId: u.id,
        entityType: 'post',
        entityId: comment.post_id,
        data: { commentId: id },
        group: `like:${id}`,
      });
    const likes = (await db.query(`SELECT like_count FROM comments WHERE id = $1`, [id])).rows[0].like_count;
    return { liked: true, likes };
  });

  app.delete('/v1/comments/:id/like', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2`, [id, u.id]);
      if (r.rowCount) await c.query(`UPDATE comments SET like_count = greatest(like_count - 1, 0) WHERE id = $1`, [id]);
    });
    const likes = (await db.query(`SELECT like_count FROM comments WHERE id = $1`, [id])).rows[0]?.like_count ?? 0;
    return { liked: false, likes };
  });

  /** Who liked a comment, newest first: only its writer can see the list. */
  app.get('/v1/comments/:id/likes', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    const own = await db.query(`SELECT author_id FROM comments WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!own.rows[0]) throw notFound('That comment');
    if (own.rows[0].author_id !== u.id) throw forbidden('Only the person who wrote a comment can see who liked it.');
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT cl.user_id AS id, cl.created_at::text AS created_at, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name,
              pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}
       FROM comment_likes cl JOIN profiles pr ON pr.user_id = cl.user_id JOIN users us ON us.id = cl.user_id
       WHERE cl.comment_id = $2 AND us.status = 'active' AND ${notBlockedSql('cl.user_id', '$1')}
         ${c ? 'AND (cl.created_at, cl.user_id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY cl.created_at DESC, cl.user_id DESC LIMIT $3`,
      c ? [u.id, id, q.limit + 1, c.t, c.id] : [u.id, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items: PublicUser[] = page.map((r) => publicUserFrom(r, 'a_'));
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  // ── The post author's tools ───────────────────────────────────────────

  async function ownPost(postId: string, userId: string) {
    const { rows } = await db.query(`SELECT author_id FROM posts WHERE id = $1 AND deleted_at IS NULL`, [postId]);
    if (!rows[0]) throw notFound('That post');
    if (rows[0].author_id !== userId) throw forbidden('Only the post’s author can do that.');
  }

  /** Pin one top-level comment to the top of your post (replacing any other). */
  app.put('/v1/posts/:id/pinned-comment', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { commentId } = parse(pinCommentSchema, req.body);
    await ownPost(id, u.id);
    const { rows } = await db.query(
      `SELECT cm.parent_id FROM comments cm JOIN posts p ON p.id = cm.post_id
       WHERE cm.id = $2 AND cm.post_id = $3 AND cm.hidden_at IS NULL AND cm.moderation_status IN ('normal', 'review') AND ${commentVisibleSql('$1')}`,
      [u.id, commentId, id],
    );
    if (!rows[0]) throw notFound('That comment');
    if (rows[0].parent_id) throw badRequest('Only a top-level comment can be pinned. You can pin the comment that started the thread.');
    await db.query(`UPDATE posts SET pinned_comment_id = $2 WHERE id = $1`, [id, commentId]);
    return { pinnedCommentId: commentId };
  });

  app.delete('/v1/posts/:id/pinned-comment', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownPost(id, u.id);
    await db.query(`UPDATE posts SET pinned_comment_id = NULL WHERE id = $1`, [id]);
    return { pinnedCommentId: null };
  });

  /** Who can comment on your post: everyone, people you follow, your followers, or no one. */
  app.put('/v1/posts/:id/comment-settings', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { policy } = parse(commentPolicySchema, req.body);
    await ownPost(id, u.id);
    await db.query(`UPDATE posts SET comment_policy = $2 WHERE id = $1`, [id, policy]);
    return { commentPolicy: policy };
  });

  /** Your post's comments hidden by your hidden words, newest first, to review. */
  app.get('/v1/posts/:id/comments/hidden', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await ownPost(id, u.id);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT cm.id, cm.created_at::text AS created_at FROM comments cm WHERE cm.post_id = $2 AND cm.hidden_at IS NOT NULL AND cm.deleted_at IS NULL
         AND ${notBlockedSql('cm.author_id', '$1')} ${c ? 'AND (cm.created_at, cm.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY cm.created_at DESC, cm.id DESC LIMIT $3`,
      c ? [u.id, id, q.limit + 1, c.t, c.id] : [u.id, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await loadComments(
        db,
        page.map((r) => r.id),
        u.id,
        { hidden: true },
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  /** Let a hidden comment on your post through: everyone sees it again and your hidden words leave it alone. */
  app.post('/v1/comments/:id/unhide', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { rows } = await db.query(
      `SELECT cm.post_id, p.author_id FROM comments cm JOIN posts p ON p.id = cm.post_id WHERE cm.id = $1 AND cm.deleted_at IS NULL AND cm.hidden_at IS NOT NULL`,
      [id],
    );
    if (!rows[0]) throw notFound('That hidden comment');
    if (rows[0].author_id !== u.id) throw forbidden('Only the post’s author can review hidden comments.');
    await tx(db, async (c) => {
      await c.query(`UPDATE comments SET hidden_at = NULL, unhidden_at = now() WHERE id = $1`, [id]);
      await syncCommentCounts(c, rows[0].post_id);
    });
    const [comment] = await loadComments(db, [id], u.id);
    return { comment: comment! };
  });

  // ── Hidden words ──────────────────────────────────────────────────────

  app.get('/v1/me/hidden-words', { preHandler: requireAuth }, async (req) => ({ words: await hiddenWordsOf(db, me(req).id) }));

  /** Replace your hidden words. Comments already on your posts are checked again. */
  app.put('/v1/me/hidden-words', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { words } = parse(hiddenWordsSchema, req.body);
    const clean = [...new Set(words.map(normalizeWords).filter(Boolean))];
    await tx(db, async (c) => {
      await c.query(`DELETE FROM hidden_words WHERE user_id = $1 AND NOT (word = ANY($2::text[]))`, [u.id, clean]);
      for (const w of clean) await c.query(`INSERT INTO hidden_words (user_id, word) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, w]);
      await applyHiddenWords(c, u.id);
    });
    return { words: await hiddenWordsOf(db, u.id) };
  });
}
