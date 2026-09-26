import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { collabInviteSchema, MAX_PHOTO_TAGS, pageQuerySchema, photoTagSchema, tagSettingsSchema, usernameSchema, type PhotoTag } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { hydratePosts } from '../lib/posts.ts';
import { assertCanInvite, assertCanTag, notifyCollabInvites, notifyPhotoTags } from '../lib/collabs.ts';
import { notify } from '../lib/services.ts';
import { plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;
const VISIBLE = postVisibleSql('$1');

/**
 * Collab posts and reels, and people tagged in photos.
 *
 * Collabs: the original author invites up to 3 co-authors (people they follow
 * who follow them back), when posting or later. Each invitee accepts or
 * declines; a co-author can leave at any time. Only the original author can
 * change or delete the post, invite people or take someone off it.
 *
 * Photo tags: the original author tags people at a spot on a photo. The person
 * tagged is told (when they can see the post) and can remove the tag. Everyone
 * chooses who may tag them: everyone, only people they follow, or no one.
 */
export default async function collabsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /** The post, when the viewer can see it and it isn't deleted. */
  async function visiblePost(postId: string, viewer: string) {
    const { rows } = await db.query(`SELECT p.id, p.author_id, p.visibility, p.community_id, p.moderation_status ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`, [
      viewer,
      postId,
    ]);
    if (!rows[0]) throw notFound('That post');
    return rows[0] as { id: string; author_id: string; visibility: string; community_id: string | null; moderation_status: string };
  }

  async function ownPost(postId: string, userId: string) {
    const post = await visiblePost(postId, userId);
    if (post.author_id !== userId) throw new AppError(403, 'forbidden', 'Only the person who shared this post can change it.');
    return post;
  }

  async function hydrated(postId: string, viewer: string) {
    const [post] = await hydratePosts(db, [postId], viewer);
    return post!;
  }

  // ── Collabs ───────────────────────────────────────────────────────────
  app.post('/v1/posts/:id/collaborators', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(collabInviteSchema, req.body);
    const ids = [...new Set(userIds)];
    const post = await ownPost(id, u.id);
    await tx(db, async (c) => {
      // One invite at a time per post, so two requests can't go past the limit together.
      await c.query(`SELECT 1 FROM posts WHERE id = $1 FOR UPDATE`, [id]);
      await assertCanInvite(c, u.id, ids, { id, visibility: post.visibility, communityId: post.community_id });
      await c.query(
        `INSERT INTO post_collaborators (post_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3
         ON CONFLICT (post_id, user_id) DO UPDATE SET status = 'pending', invited_by = EXCLUDED.invited_by, created_at = now(), responded_at = NULL
         WHERE post_collaborators.status = 'removed'`,
        [id, ids, u.id],
      );
    });
    if (post.moderation_status === 'normal') await notifyCollabInvites(db, ctx.realtime, { postId: id, actorId: u.id, userIds: ids });
    return { post: await hydrated(id, u.id) };
  });

  /** The original author cancels an invite or takes a co-author off the post. */
  app.delete('/v1/posts/:id/collaborators/:userId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    await ownPost(id, u.id);
    const r = await db.query(
      `UPDATE post_collaborators SET status = 'removed', responded_at = now() WHERE post_id = $1 AND user_id = $2 AND status IN ('pending', 'accepted')`,
      [id, userId],
    );
    if (!r.rowCount) throw notFound('That co-author');
    return { post: await hydrated(id, u.id) };
  });

  /** Accept an invite: the post shows as yours too, on your profile and to your followers. */
  app.post('/v1/posts/:id/collab/accept', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const post = await visiblePost(id, u.id);
    const r = await db.query(
      `UPDATE post_collaborators SET status = 'accepted', responded_at = now() WHERE post_id = $1 AND user_id = $2 AND status = 'pending'`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('That invite');
    await notify(db, ctx.realtime, { userId: post.author_id, category: 'creators', type: 'collab_accepted', actorId: u.id, entityType: 'post', entityId: id });
    return { post: await hydrated(id, u.id) };
  });

  app.post('/v1/posts/:id/collab/decline', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE post_collaborators SET status = 'declined', responded_at = now() WHERE post_id = $1 AND user_id = $2 AND status = 'pending'`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('That invite');
    return { ok: true };
  });

  /** Leave a post you co-author: it comes off your profile and your followers' feeds. The original author keeps it. */
  app.delete('/v1/posts/:id/collab', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE post_collaborators SET status = CASE WHEN status = 'pending' THEN 'declined' ELSE 'left' END, responded_at = now()
       WHERE post_id = $1 AND user_id = $2 AND status IN ('pending', 'accepted')`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('That post');
    return { ok: true };
  });

  /** Invites to co-author that you haven't answered, on posts you can still see. */
  app.get('/v1/me/collab-invites', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT p.id ${POST_FROM} JOIN post_collaborators pc ON pc.post_id = p.id AND pc.user_id = $1 AND pc.status = 'pending'
       WHERE ${VISIBLE} ORDER BY pc.created_at DESC LIMIT 50`,
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

  // ── Photo tags ────────────────────────────────────────────────────────
  app.post('/v1/posts/:id/tags', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(photoTagSchema, req.body);
    const post = await ownPost(id, u.id);
    const media = await db.query(`SELECT m.kind FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = $1 AND pm.media_id = $2`, [
      id,
      input.mediaId,
    ]);
    if (!media.rows[0]) throw notFound('That photo');
    if (media.rows[0].kind !== 'image') throw badRequest('You can tag people in photos.');
    const { tag, added } = await tx(db, async (c) => {
      await c.query(`SELECT 1 FROM posts WHERE id = $1 FOR UPDATE`, [id]);
      await assertCanTag(c, u.id, [input.userId]);
      const n = (
        await c.query(`SELECT count(*)::int AS n FROM photo_tags WHERE post_id = $1 AND media_id = $2 AND user_id <> $3`, [id, input.mediaId, input.userId])
      ).rows[0].n as number;
      if (n >= MAX_PHOTO_TAGS) throw badRequest(`A photo can have up to ${MAX_PHOTO_TAGS} people tagged.`);
      const { rows } = await c.query(
        `INSERT INTO photo_tags (post_id, media_id, user_id, tagged_by, x, y) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (post_id, media_id, user_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y
         RETURNING id, x, y, (xmax = 0) AS added`,
        [id, input.mediaId, input.userId, u.id, input.x, input.y],
      );
      return { tag: rows[0], added: rows[0].added as boolean };
    });
    if (added && post.moderation_status === 'normal') await notifyPhotoTags(db, ctx.realtime, { postId: id, actorId: u.id, userIds: [input.userId] });
    const user = (
      await db.query(
        `SELECT pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}
         FROM profiles pr WHERE pr.user_id = $1`,
        [input.userId],
      )
    ).rows[0];
    reply.code(added ? 201 : 200);
    return { tag: { id: tag.id, user: publicUserFrom(user, 'a_'), x: Number(tag.x), y: Number(tag.y) } satisfies PhotoTag };
  });

  /** The original author, or the person tagged, removes a tag. */
  app.delete('/v1/posts/:id/tags/:tagId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, tagId } = parse(z.object({ id: z.string().uuid(), tagId: z.string().uuid() }), req.params);
    const r = await db.query(
      `DELETE FROM photo_tags t USING posts p WHERE t.id = $2 AND t.post_id = $1 AND p.id = t.post_id AND (t.user_id = $3 OR p.author_id = $3)`,
      [id, tagId, u.id],
    );
    if (!r.rowCount) throw notFound('That tag');
    return { ok: true };
  });

  /**
   * Posts someone is tagged in, newest tag first: only posts you can see and
   * open. A private account's tagged posts are for the people who can see
   * that profile (the account and its followers); others get `hidden`.
   */
  app.get('/v1/users/:username/tagged', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const q = parse(pageQuerySchema, req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const viewer = req.user?.id ?? null;
    const owner = (
      await db.query(
        `SELECT pr.user_id, pr.is_private,
                (pr.user_id = $2 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = pr.user_id)) AS sees
         FROM profiles pr JOIN users u ON u.id = pr.user_id
         WHERE lower(pr.username) = lower($1) AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$2')}`,
        [username, viewer],
      )
    ).rows[0];
    if (!owner) throw notFound('That profile');
    if (owner.is_private && !owner.sees) return { items: [], nextCursor: null, hidden: true };
    const params: unknown[] = [viewer, owner.user_id, q.limit + 1];
    if (c) params.push(c.t, c.id);
    const { rows } = await db.query(
      `WITH tg AS (SELECT t.post_id, max(t.created_at) AS created_at FROM photo_tags t WHERE t.user_id = $2 GROUP BY t.post_id)
       SELECT p.id, tg.created_at ${POST_FROM} JOIN tg ON tg.post_id = p.id
       WHERE ${VISIBLE} AND ${postUnlockedSql('$1')}
         ${c ? 'AND (tg.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY tg.created_at DESC, p.id DESC LIMIT $3`,
      params,
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  app.get('/v1/me/tagging', { preHandler: requireAuth }, async (req) => {
    const r = await db.query(`SELECT tag_permission FROM profiles WHERE user_id = $1`, [me(req).id]);
    return { allowFrom: r.rows[0]?.tag_permission ?? 'everyone' };
  });

  /** Who may tag you in photos. Tags already on posts stay; you can remove any of them. */
  app.put('/v1/me/tagging', { preHandler: requireAuth }, async (req) => {
    const { allowFrom } = parse(tagSettingsSchema, req.body);
    await db.query(`UPDATE profiles SET tag_permission = $2 WHERE user_id = $1`, [me(req).id, allowFrom]);
    return { allowFrom };
  });
}
