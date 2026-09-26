import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { mediaEditSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { enqueue } from '../lib/jobs.ts';
import { isPlus, PLUS_REEL_MAX_MS, REEL_MAX_MS } from '../lib/plus.ts';
import { videoDurationMs } from '../lib/studio.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

function fieldError(field: string, message: string) {
  return new AppError(400, 'validation_failed', 'Check the highlighted fields.', { fields: { [field]: message } });
}

/** A media item's status, with editor renders still running (or failed) taking precedence. */
const STATUS_SQL = `CASE WHEN r.status IN ('queued', 'rendering') THEN 'processing' WHEN r.status = 'failed' THEN 'failed' ELSE m.status END`;

/**
 * The photo and video editor, before posting:
 *   POST /v1/media/:id/edit → a new media item made from one of your uploads with a look,
 *                             adjustments, crop, turn, flips, text and (videos) trim, mute and cover
 *   GET  /v1/media/:id      → one of your media items, to wait for an edit to finish
 * The original upload is never changed. Rendering runs as a 'media.editor' job.
 */
export default async function editorModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.post('/v1/media/:id/edit', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(mediaEditSchema, req.body);
    const { rows } = await db.query(
      `SELECT m.id, m.kind, m.mime, m.url, m.alt_text, m.storage_key, m.duration_ms FROM media m WHERE m.id = $1 AND m.owner_id = $2`,
      [id, u.id],
    );
    const src = rows[0];
    // Someone else's upload looks the same as one that doesn't exist.
    if (!src) throw notFound('That photo or video');
    if (src.kind !== 'image' && src.kind !== 'video') throw badRequest('Only photos and videos can be edited.');
    if (!src.storage_key) throw badRequest('This file was not uploaded here, so it cannot be edited.');
    if (src.mime === 'image/gif') throw new AppError(415, 'unsupported_media', 'Animated GIFs cannot be edited.');

    if (src.kind === 'image') {
      if (input.trim) throw fieldError('trim', 'Only videos can be trimmed.');
      if (input.coverMs !== undefined) throw fieldError('coverMs', 'Only videos have a cover.');
      if (input.muted) throw fieldError('muted', 'Only videos have sound.');
    } else {
      const durationMs = await videoDurationMs(ctx, { id, storage_key: src.storage_key, duration_ms: src.duration_ms });
      if (!durationMs) throw badRequest("We couldn't read this video's length.");
      const start = input.trim?.startMs ?? 0;
      // Allow a few milliseconds past the end: players round the length.
      if (input.trim && input.trim.endMs > durationMs + 100) throw fieldError('trim.endMs', `The video is ${(durationMs / 1000).toFixed(1)} seconds long.`);
      if (start >= durationMs) throw fieldError('trim.startMs', 'The start is past the end of the video.');
      const end = Math.min(input.trim?.endMs ?? durationMs, durationMs);
      if (end - start < 1000) throw fieldError('trim.endMs', 'Keep at least 1 second.');
      // The same limit as reels: 3 minutes, or 10 with Plus.
      if (end - start > REEL_MAX_MS) {
        const plus = await isPlus(db, u.id);
        if (!plus || end - start > PLUS_REEL_MAX_MS)
          throw fieldError(
            'trim',
            plus
              ? 'Edited videos can be up to 10 minutes. Trim it first.'
              : 'Edited videos can be up to 3 minutes, or 10 minutes with YAPILAPI Plus. Trim it first.',
          );
      }
      if (input.coverMs !== undefined && (input.coverMs < start || input.coverMs > end)) throw fieldError('coverMs', 'Pick a cover from the part you keep.');
      if (input.trim) input.trim.endMs = end;
    }

    const media = await tx(db, async (c) => {
      // The new item shows the original until it's ready; clients wait for status 'ready'.
      const m = await c.query(
        `INSERT INTO media (owner_id, kind, url, mime, alt_text, status) VALUES ($1,$2,$3,$4,$5,'processing') RETURNING id, kind, url, alt_text`,
        [u.id, src.kind, src.url, src.mime, src.alt_text],
      );
      const r = await c.query(
        `INSERT INTO media_editor_renders (source_media_id, result_media_id, owner_id, kind, params) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [id, m.rows[0].id, u.id, src.kind, input],
      );
      await enqueue(c, 'media.editor', { renderId: r.rows[0].id });
      return m.rows[0];
    });
    reply.code(202);
    return { media: { id: media.id, kind: media.kind, url: media.url, altText: media.alt_text, status: 'processing' as const, editOf: id } };
  });

  app.get('/v1/media/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { rows } = await db.query(
      `SELECT m.id, m.kind, m.url, m.mime, m.alt_text, m.variants, m.poster_url, m.hls_url, m.blurhash, m.width, m.height, m.duration_ms,
              ${STATUS_SQL} AS status, r.error AS edit_error, r.source_media_id AS edit_of
       FROM media m LEFT JOIN media_editor_renders r ON r.result_media_id = m.id
       WHERE m.id = $1 AND m.owner_id = $2`,
      [id, me(req).id],
    );
    const m = rows[0];
    if (!m) throw notFound('That photo or video');
    return {
      media: {
        id: m.id,
        kind: m.kind,
        url: m.url,
        mime: m.mime,
        altText: m.alt_text,
        status: m.status as 'uploading' | 'processing' | 'ready' | 'failed',
        variants: m.variants,
        posterUrl: m.poster_url,
        hlsUrl: m.hls_url,
        blurhash: m.blurhash,
        width: m.width,
        height: m.height,
        durationMs: m.duration_ms,
        editOf: m.edit_of,
        error: m.status === 'failed' ? (m.edit_error ?? "We couldn't process this file.") : null,
      },
    };
  });
}
