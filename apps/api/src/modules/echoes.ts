import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { ECHO_MAX_MS, ECHO_MIN_MS, echoCreateSchema, echoSettingsSchema, type EchoTheirAudio } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { enqueue } from '../lib/jobs.ts';
import { hydratePosts } from '../lib/posts.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { videoDurationMs } from '../lib/studio.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { ECHO_RENDER_JOB, echoBlock, echoJobHandlers, echoOptions, echoRefused, echoRender, originalFor } from '../lib/echoes.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

function fieldError(field: string, message: string) {
  return new AppError(400, 'validation_failed', 'Check the highlighted fields.', { fields: { [field]: message } });
}

/**
 * Echoes: answer a reel with your own video, the two shown together in a new reel (lib/echoes.ts).
 *   GET  /v1/posts/:id/echo           → whether you can echo this reel, and what would be heard of it
 *   POST /v1/posts/:id/echoes         → make an echo video from one of your videos (layout, "echo after" cut, balance)
 *   GET  /v1/echoes/:id               → your echo video, while it's made and once it's ready to post
 *   GET  /v1/posts/:id/echoes         → echoes of a reel that you can see, newest first
 *   PUT  /v1/posts/:id/echo-settings  → the author: who may echo this reel (new echoes only)
 * Posting goes through POST /v1/posts with `echo` (lib/publishing.ts), like any reel.
 */
export default async function echoesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const moderated = () => ctx.mediaModerator.name !== 'none';

  // The job that makes echo videos, with the same processing and checks as uploads.
  Object.assign(ctx.jobs, echoJobHandlers({ db, storage: ctx.storage, moderator: ctx.mediaModerator, realtime: ctx.realtime }));

  app.get('/v1/posts/:id/echo', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const o = await originalFor(db, id, u.id);
    if (!o) throw notFound('That reel');
    return echoOptions(o, u.id, moderated());
  });

  app.post('/v1/posts/:id/echoes', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(echoCreateSchema, req.body);
    const o = await originalFor(db, id, u.id);
    // Hidden reels (blocks included) look the same as ones that don't exist.
    if (!o) throw notFound('That reel');
    const reason = echoBlock(o, u.id, moderated());
    if (reason) throw echoRefused(reason);

    // Your video: only your own, not blocked, long enough.
    const src = (
      await db.query(
        `SELECT id, kind, url, storage_key, duration_ms, moderation FROM media WHERE id = $1 AND owner_id = $2 AND NOT private AND deleted_at IS NULL`,
        [input.mediaId, u.id],
      )
    ).rows[0];
    if (!src) throw notFound('That video');
    if (src.kind !== 'video') throw fieldError('mediaId', 'Choose a video.');
    if (!src.storage_key) throw fieldError('mediaId', 'This video was not uploaded here, so it cannot be used.');
    if (src.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
    const yoursMs = await videoDurationMs(ctx, { id: src.id, storage_key: src.storage_key, duration_ms: src.duration_ms });
    if (!yoursMs) throw fieldError('mediaId', "We couldn't read this video's length.");
    if (yoursMs < ECHO_MIN_MS) throw fieldError('mediaId', 'Your video needs to be at least 1 second long.');

    // "Echo after": within their reel (players round lengths, so a little past the end is fine).
    const theirMs = o.duration_ms;
    if (input.cut && theirMs) {
      if (input.cut.startMs >= theirMs) throw fieldError('cut.startMs', 'The start is past the end of their reel.');
      if (input.cut.endMs > theirMs + 100) throw fieldError('cut.endMs', `Their reel is ${(theirMs / 1000).toFixed(1)} seconds long.`);
      input.cut.endMs = Math.min(input.cut.endMs, theirMs);
      if (input.cut.endMs - input.cut.startMs < 1000) throw fieldError('cut.endMs', 'Keep at least 1 second of their reel.');
    }
    const cutMs = input.cut ? input.cut.endMs - input.cut.startMs : 0;
    if (cutMs + yoursMs > ECHO_MAX_MS + 100)
      throw fieldError(
        'mediaId',
        `An echo can be up to ${ECHO_MAX_MS / 60_000} minutes long. Trim your video to ${Math.floor((ECHO_MAX_MS - cutMs) / 1000)} seconds.`,
      );

    // What is heard of their reel. A song whose licence allows it stays, if it may play for you too.
    let theirAudio: EchoTheirAudio = echoOptions(o, u.id, moderated()).theirAudio;
    let song: { trackId: string; part: { startMs: number; durationMs: number } } | null = null;
    if (theirAudio === 'song') {
      const part = o.music ? { startMs: o.music.startMs, durationMs: o.music.durationMs } : null;
      const usable =
        part &&
        (await ctx.music.checkTrack(u.id, o.music_track_id!, part.durationMs).then(
          () => true,
          (e) => {
            if (e instanceof AppError) return false;
            throw e;
          },
        ));
      if (usable && part) song = { trackId: o.music_track_id!, part };
      else theirAudio = 'dropped';
    }
    if (input.muteTheirs && (theirAudio === 'mixed' || theirAudio === 'song')) {
      theirAudio = 'muted';
      song = null;
    }

    const echoId = await tx(db, async (c) => {
      // The new video shows yours until it's made; the echo's status says where it is.
      const m = await c.query(
        `INSERT INTO media (owner_id, kind, url, mime, status, moderation) VALUES ($1,'video',$2,'video/mp4','processing',$3) RETURNING id`,
        [u.id, src.url, src.moderation === 'sensitive' ? 'sensitive' : 'pending'],
      );
      const e = await c.query(
        `INSERT INTO echoes (owner_id, original_post_id, original_author_id, source_media_id, result_media_id, layout, cut_start_ms, cut_end_ms, balance,
                             their_audio, music_track_id, music)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          u.id,
          o.id,
          o.author_id,
          src.id,
          m.rows[0].id,
          input.layout,
          input.cut?.startMs ?? null,
          input.cut?.endMs ?? null,
          input.balance,
          theirAudio,
          song?.trackId ?? null,
          song ? song.part : null,
        ],
      );
      await enqueue(c, ECHO_RENDER_JOB, { echoId: e.rows[0].id });
      return e.rows[0].id as string;
    });
    reply.code(202);
    return { echo: await echoRender(db, echoId, u.id) };
  });

  app.get('/v1/echoes/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const echo = await echoRender(db, id, me(req).id);
    if (!echo) throw notFound('That echo');
    return { echo };
  });

  /** Echoes of a reel that you can see, newest first (each one only while you can see the reel too). */
  app.get('/v1/posts/:id/echoes', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    const viewer = req.user?.id ?? null;
    const seen = await db.query(`SELECT 1 ${POST_FROM} WHERE p.id = $2 AND ${postVisibleSql('$1')}`, [viewer, id]);
    if (!seen.rowCount) throw notFound('That reel');
    const c = decodeCursor<KeyCursor>(q.cursor);
    const params: unknown[] = [viewer, id, q.limit + 1];
    if (c) params.push(c.t, c.id);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${POST_FROM}
       WHERE p.echo_of_post_id = $2 AND p.is_echo AND p.format = 'reel' AND ${postVisibleSql('$1')}
       ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
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

  /** Who may echo your reel. Echoes already posted stay up. */
  app.put('/v1/posts/:id/echo-settings', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { allowEchoes } = parse(echoSettingsSchema, req.body);
    const r = await db.query(`UPDATE posts SET allow_echoes = $3 WHERE id = $1 AND author_id = $2 AND format = 'reel' AND deleted_at IS NULL`, [
      id,
      u.id,
      allowEchoes,
    ]);
    if (!r.rowCount) throw notFound('That reel');
    return { allowEchoes };
  });
}
