import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { postCoverSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { hydratePosts } from '../lib/posts.ts';
import { track } from '../lib/services.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { storedKeys } from '../lib/chat.ts';
import { fitPhoto, frameAt, storeCover, videoAspect } from '../lib/video-cover-render.ts';
import { putCover, removeCoverFiles, restoreDefault, type DefaultPoster } from '../lib/video-covers.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;
const VISIBLE = postVisibleSql('$1');

const coverSensitive = () => new AppError(422, 'media_sensitive', 'This photo may be sensitive, so it can’t be a cover. Choose another one.');
const photoProcessing = () => new AppError(409, 'media_processing', 'Your photo is still being prepared. Try again in a moment.');
const videoProcessing = () => new AppError(409, 'media_processing', 'Your video is still being prepared. Try again in a moment.');

/**
 * Covers of posts and reels, chosen by the person who shared them, when posting or any time after.
 *
 * A video's cover (a reel, or a video in a post) is a moment of it, one of your own photos
 * fitted to the video's shape, or the default poster (lib/video-covers.ts). A post with
 * several photos or videos has the one that comes first as its cover: choosing another moves
 * it to the front, the others keeping their order.
 *
 * Changing a cover isn't an edit of the post's text: it doesn't show "Edited", isn't in the
 * post's history and doesn't count towards the daily limit on text edits (descriptions of
 * photos don't either). Nobody is told.
 */
export default async function postCoversModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.put('/v1/posts/:id/cover', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(postCoverSchema, req.body);
    const post = (await db.query(`SELECT p.author_id, p.format, p.moderation_status ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`, [u.id, id])).rows[0];
    if (!post) throw notFound('That post');
    if (post.author_id !== u.id) throw forbidden('Only the person who shared this post can change its cover.');
    if (post.moderation_status === 'removed') throw forbidden("This post was removed, so it can't be changed.");

    if (input.coverMediaId) {
      // Which photo or video comes first.
      await tx(db, async (c) => {
        const { rows } = await c.query<{ media_id: string; moderation: string }>(
          `SELECT pm.media_id, m.moderation FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = $1 ORDER BY pm.position, pm.media_id FOR UPDATE OF pm`,
          [id],
        );
        const chosen = rows.find((r) => r.media_id === input.coverMediaId);
        if (!chosen) throw notFound('That photo');
        if (rows.length < 2) throw badRequest('Only a post with more than one photo or video has a cover to choose.');
        if (chosen.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
        if (chosen.moderation === 'sensitive') throw coverSensitive();
        const order = [chosen.media_id, ...rows.map((r) => r.media_id).filter((m) => m !== chosen.media_id)];
        await c.query(
          `UPDATE post_media pm SET position = o.n - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS o(media_id, n) WHERE pm.post_id = $1 AND pm.media_id = o.media_id`,
          [id, order],
        );
        await c.query(`UPDATE posts SET updated_at = now() WHERE id = $1`, [id]);
      });
      track(db, u.id, 'post_cover_changed', { kind: 'order' });
      const [updated] = await hydratePosts(db, [id], u.id);
      return { post: updated };
    }

    const m = (
      await db.query(
        `SELECT m.id, m.kind, m.status, m.storage_key, m.duration_ms, m.width, m.height, m.poster_url, m.default_poster
         FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = $1 AND pm.media_id = $2`,
        [id, input.mediaId],
      )
    ).rows[0];
    if (!m) throw notFound('That video');
    if (m.kind !== 'video') throw badRequest('Choose a video of this post.');

    if (input.reset) {
      const old = await tx(db, (c) => restoreDefault(c, m.id));
      await removeCoverFiles(ctx.storage, old);
      if (old.length) track(db, u.id, 'post_cover_changed', { kind: 'default' });
      const [updated] = await hydratePosts(db, [id], u.id);
      return { post: updated };
    }

    if (m.status !== 'ready' || !m.poster_url) throw videoProcessing();
    if (!m.storage_key) throw badRequest('This video was not uploaded here, so its cover can’t be changed.');
    let jpg: Buffer;
    if (input.atMs !== undefined) {
      if (m.duration_ms && input.atMs > m.duration_ms)
        throw new AppError(400, 'validation_failed', 'Check the highlighted fields.', { fields: { atMs: 'Choose a moment in the video.' } });
      jpg = await frameAt(ctx.storage, m.storage_key, input.atMs, m.duration_ms).catch((err) => {
        req.log.warn({ err }, 'cover frame failed');
        throw new AppError(422, 'edit_failed', 'We couldn’t take a cover from this moment. Try another one.');
      });
    } else {
      const img = (
        await db.query(`SELECT kind, status, moderation, storage_key FROM media WHERE id = $1 AND owner_id = $2 AND NOT private AND deleted_at IS NULL`, [
          input.imageMediaId,
          u.id,
        ])
      ).rows[0];
      if (!img) throw notFound('That photo');
      if (img.kind !== 'image') throw badRequest('Choose a photo for the cover.');
      if (img.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
      if (img.moderation === 'sensitive') throw coverSensitive();
      if (img.status !== 'ready' || !img.storage_key) throw photoProcessing();
      // Fitted to the shape of the video as people see it: its default poster is the right way up.
      const def = (m.default_poster as DefaultPoster | null)?.url ?? m.poster_url;
      const posterKey = storedKeys({ url: def, poster_url: null, hls_url: null, variants: null, storage_key: null })[0];
      const aspect = await videoAspect(ctx.storage, posterKey, m.width, m.height);
      jpg = await fitPhoto(await ctx.storage.read(img.storage_key), aspect, input.crop).catch((err) => {
        req.log.warn({ err }, 'cover photo failed');
        throw new AppError(422, 'edit_failed', 'We couldn’t apply your edits to this photo. Try again, or choose another photo.');
      });
    }

    const stored = await storeCover(ctx.storage, m.storage_key, jpg);
    const result = await tx(db, async (c) => {
      if (input.imageMediaId) {
        // The automated check may have finished while the cover was being made.
        const verdict = (await c.query(`SELECT moderation FROM media WHERE id = $1 FOR SHARE`, [input.imageMediaId])).rows[0]?.moderation as string | undefined;
        if (verdict === 'blocked' || verdict === 'sensitive') return { refused: verdict, old: [] as string[] };
        await c.query(`UPDATE media SET used_at = coalesce(used_at, now()) WHERE id = $1`, [input.imageMediaId]);
      }
      const old = await putCover(c, m.id, stored, { atMs: input.atMs ?? null, imageMediaId: input.imageMediaId ?? null });
      await c.query(`UPDATE posts SET updated_at = now() WHERE id = $1`, [id]);
      return { refused: null, old };
    }).catch(async (err) => {
      await removeCoverFiles(ctx.storage, stored.keys);
      throw err;
    });
    if (result.refused) {
      await removeCoverFiles(ctx.storage, stored.keys);
      throw result.refused === 'blocked' ? new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE) : coverSensitive();
    }
    await removeCoverFiles(ctx.storage, result.old);
    track(db, u.id, 'post_cover_changed', { kind: input.imageMediaId ? 'photo' : 'frame' });
    const [updated] = await hydratePosts(db, [id], u.id);
    return { post: updated };
  });
}
