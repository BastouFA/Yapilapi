import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { enqueue } from '../lib/jobs.ts';
import { saveCaptionTrack, videoDurationMs } from '../lib/studio.ts';
import { mediaVisibleSql } from '../lib/visibility.ts';
import { decodeCueText, MAX_CUE_TEXT, MAX_CUES, MAX_VTT_BYTES, parseVtt, sanitizeCueText, VttError } from '../lib/webvtt.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export const MAX_CLIPS = 20;
const MIN_SEGMENT_MS = 1000;
const MAX_SEGMENT_MS = 10 * 60 * 1000;

const idParam = z.object({ id: z.string().uuid() });
const langParam = z.object({
  id: z.string().uuid(),
  lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as en, fr or pt-BR.'),
});
const labelSchema = z.string().trim().min(1, 'Add a label, such as English.').max(60);

const editSchema = z.object({
  kind: z.enum(['trim', 'clip']),
  segments: z
    .array(z.object({ start: z.number().finite().min(0), end: z.number().finite().positive() }))
    .min(1, 'Add at least one part of the video.')
    .max(MAX_CLIPS, `You can make up to ${MAX_CLIPS} clips at once.`),
});

const cuesSchema = z.object({
  label: labelSchema,
  cues: z.array(z.object({ start: z.number().finite().min(0), end: z.number().finite().positive(), text: z.string().max(MAX_CUE_TEXT) })).max(MAX_CUES),
});

export const EDIT_STATUS = `CASE WHEN e.status = 'processing' AND j.status = 'done' THEN 'ready'
                          WHEN e.status = 'processing' AND j.status = 'failed' THEN 'failed'
                          ELSE e.status END`;

function fieldError(field: string, message: string) {
  return new AppError(400, 'validation_failed', 'Check the highlighted fields.', { fields: { [field]: message } });
}

/**
 * Creator Studio editing: trimmed copies and clips of your videos, and caption
 * tracks (WebVTT) that play as subtitles wherever the video plays.
 *
 * Editing is owner-only. Caption tracks are readable by anyone who can see the
 * video: its owner, or anyone who can see a post it's attached to.
 */
export default async function studioModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function ownVideo(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT id, storage_key, duration_ms, (variants ? 'mp4') AS processed FROM media WHERE id = $1 AND owner_id = $2 AND kind = 'video'`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('That video');
    return rows[0] as { id: string; storage_key: string | null; duration_ms: number | null; processed: boolean };
  }

  async function visibleVideo(id: string, viewer: string | null) {
    const { rows } = await db.query(`SELECT m.id, m.owner_id FROM media m WHERE m.id = $2 AND m.kind = 'video' AND ${mediaVisibleSql('$1')}`, [viewer, id]);
    if (!rows[0]) throw notFound('That video');
    return { id: rows[0].id as string, isOwner: rows[0].owner_id === viewer };
  }

  // ── Your videos ───────────────────────────────────────────────────────
  app.get('/v1/me/videos', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.id, m.url, m.variants, m.poster_url, m.hls_url, m.duration_ms, m.alt_text, m.created_at, (m.variants ? 'mp4') AS processed,
              (SELECT e.source_media_id FROM media_edits e WHERE e.result_media_id = m.id LIMIT 1) AS edit_of
       FROM media m WHERE m.owner_id = $1 AND m.kind = 'video' ORDER BY m.created_at DESC LIMIT 100`,
      [me(req).id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        url: r.url,
        variants: r.variants,
        posterUrl: r.poster_url,
        hlsUrl: r.hls_url,
        durationMs: r.duration_ms,
        altText: r.alt_text,
        processed: r.processed,
        editOf: r.edit_of,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  // ── Trims and clips ───────────────────────────────────────────────────
  async function listEdits(mediaId: string, ids?: string[]) {
    const { rows } = await db.query(
      `SELECT e.id, e.kind, e.start_ms, e.end_ms, e.error, e.created_at, ${EDIT_STATUS} AS status, j.last_error AS process_error,
              rm.id AS r_id, rm.url AS r_url, rm.variants AS r_variants, rm.poster_url AS r_poster, rm.hls_url AS r_hls, rm.duration_ms AS r_duration
       FROM media_edits e
       LEFT JOIN jobs j ON j.id = e.process_job_id
       LEFT JOIN media rm ON rm.id = e.result_media_id
       WHERE e.source_media_id = $1 AND ($2::uuid[] IS NULL OR e.id = ANY($2))
       ORDER BY e.created_at DESC, e.start_ms LIMIT 200`,
      [mediaId, ids ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      start: r.start_ms / 1000,
      end: r.end_ms / 1000,
      status: r.status,
      error: r.status === 'failed' ? (r.error ?? "We couldn't process the new video.") : null,
      createdAt: r.created_at.toISOString(),
      result: r.r_id
        ? { id: r.r_id, url: r.r_url, variants: r.r_variants, posterUrl: r.r_poster, hlsUrl: r.r_hls, durationMs: r.r_duration, ready: r.status === 'ready' }
        : null,
    }));
  }

  app.post('/v1/media/:id/edits', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(editSchema, req.body);
    const video = await ownVideo(id, u.id);
    if (!video.processed || !video.storage_key) throw conflict('This video is still processing. Try again when it is ready.');
    if (input.kind === 'trim' && input.segments.length !== 1) throw fieldError('segments', 'A trim keeps one part of the video. Use clips for several parts.');
    const durationMs = await videoDurationMs(ctx, { id, storage_key: video.storage_key, duration_ms: video.duration_ms });
    if (!durationMs) throw badRequest("We couldn't read this video's length.");
    const segments = input.segments.map((s, i) => {
      const start = Math.round(s.start * 1000);
      const end = Math.round(s.end * 1000);
      const field = `segments.${i}`;
      if (end <= start) throw fieldError(field, 'The end must come after the start.');
      if (end - start < MIN_SEGMENT_MS) throw fieldError(field, 'Each part must be at least 1 second long.');
      if (end - start > MAX_SEGMENT_MS) throw fieldError(field, 'Each part can be up to 10 minutes long.');
      if (end > durationMs) throw fieldError(field, `The video is ${(durationMs / 1000).toFixed(1)} seconds long.`);
      return { start, end };
    });
    const ids = await tx(db, async (c) => {
      const out: string[] = [];
      for (const s of segments) {
        const { rows } = await c.query(`INSERT INTO media_edits (source_media_id, owner_id, kind, start_ms, end_ms) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
          id,
          u.id,
          input.kind,
          s.start,
          s.end,
        ]);
        await enqueue(c, 'media.edit', { editId: rows[0].id });
        out.push(rows[0].id);
      }
      return out;
    });
    reply.code(201);
    return { items: await listEdits(id, ids) };
  });

  app.get('/v1/media/:id/edits', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownVideo(id, me(req).id);
    return { items: await listEdits(id) };
  });

  // ── Captions ──────────────────────────────────────────────────────────
  const trackDto = (r: Record<string, any>, isOwner: boolean) => ({
    id: r.id,
    lang: r.lang,
    label: r.label,
    source: r.source,
    status: r.status,
    url: r.url,
    cueCount: r.cue_count,
    error: isOwner ? r.error : null,
    updatedAt: r.updated_at.toISOString(),
  });

  app.get('/v1/media/:id/captions', async (req) => {
    const { id } = parse(idParam, req.params);
    const v = await visibleVideo(id, req.user?.id ?? null);
    const { rows } = await db.query(`SELECT * FROM caption_tracks WHERE media_id = $1 AND (status = 'ready' OR $2) ORDER BY lang`, [id, v.isOwner]);
    return { items: rows.map((r) => trackDto(r, v.isOwner)), autoCaptions: v.isOwner ? !!ctx.transcription : undefined };
  });

  app.get('/v1/media/:id/captions/:lang', async (req) => {
    const { id, lang } = parse(langParam, req.params);
    const v = await visibleVideo(id, req.user?.id ?? null);
    const { rows } = await db.query(`SELECT * FROM caption_tracks WHERE media_id = $1 AND lang = $2 AND (status = 'ready' OR $3)`, [id, lang, v.isOwner]);
    if (!rows[0]) throw notFound('Those captions');
    const cues = rows[0].storage_key && rows[0].status === 'ready' ? parseVtt(await ctx.storage.read(rows[0].storage_key)) : [];
    return {
      track: trackDto(rows[0], v.isOwner),
      cues: cues.map((c) => ({ start: c.start, end: c.end, text: decodeCueText(c.text) })),
    };
  });

  async function trackRow(mediaId: string, lang: string) {
    return (await db.query(`SELECT * FROM caption_tracks WHERE media_id = $1 AND lang = $2`, [mediaId, lang])).rows[0];
  }

  // Create or replace captions from the Studio editor.
  app.put('/v1/media/:id/captions/:lang', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id, lang } = parse(langParam, req.params);
    const input = parse(cuesSchema, req.body);
    const video = await ownVideo(id, u.id);
    const cues = input.cues.map((c, i) => {
      const text = sanitizeCueText(c.text);
      if (!text) throw fieldError(`cues.${i}.text`, 'Add the words for this caption, or remove it.');
      if (c.end <= c.start) throw fieldError(`cues.${i}.end`, 'A caption must end after it starts.');
      if (video.duration_ms && c.start * 1000 >= video.duration_ms) throw fieldError(`cues.${i}.start`, 'This caption starts after the video ends.');
      return { start: c.start, end: c.end, text };
    });
    await saveCaptionTrack(ctx, { mediaId: id, lang, label: input.label, source: 'manual', cues, userId: u.id });
    return { track: trackDto(await trackRow(id, lang), true) };
  });

  // Upload a .vtt file (multipart: file, label).
  app.put('/v1/media/:id/captions/:lang/file', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id, lang } = parse(langParam, req.params);
    await ownVideo(id, u.id);
    if (!req.isMultipart()) throw badRequest('Attach a .vtt file.');
    const file = await req.file({ limits: { fileSize: MAX_VTT_BYTES, files: 1 } });
    if (!file) throw badRequest('Attach a .vtt file.');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'too_large', 'Caption files can be up to 512 KB.');
    const label = parse(z.object({ label: labelSchema }), { label: (file.fields.label as { value?: string } | undefined)?.value ?? lang }).label;
    let cues;
    try {
      cues = parseVtt(buf);
    } catch (e) {
      if (!(e instanceof VttError)) throw e;
      throw new AppError(400, 'invalid_vtt', e.line ? `Line ${e.line}: ${e.message}` : e.message);
    }
    if (!cues.length) throw new AppError(400, 'invalid_vtt', 'This file has no captions in it.');
    await saveCaptionTrack(ctx, { mediaId: id, lang, label, source: 'upload', cues, userId: u.id });
    return { track: trackDto(await trackRow(id, lang), true) };
  });

  app.delete('/v1/media/:id/captions/:lang', { preHandler: requireAuth }, async (req) => {
    const { id, lang } = parse(langParam, req.params);
    await ownVideo(id, me(req).id);
    const r = await db.query(`DELETE FROM caption_tracks WHERE media_id = $1 AND lang = $2`, [id, lang]);
    if (!r.rowCount) throw notFound('Those captions');
    return { ok: true };
  });

  // Automatic captions. Only available when a speech-to-text provider is configured.
  app.post('/v1/media/:id/captions/transcribe', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ lang: langParam.shape.lang, label: labelSchema }), req.body);
    const video = await ownVideo(id, u.id);
    if (!ctx.transcription)
      throw new AppError(
        501,
        'not_configured',
        'Automatic captions are not available on this server. You can write captions in the editor or upload a .vtt file.',
      );
    if (!video.processed) throw conflict('This video is still processing. Try again when it is ready.');
    const existing = await trackRow(id, input.lang);
    if (existing && existing.status !== 'failed')
      throw conflict(
        existing.status === 'processing'
          ? 'Captions in this language are already being made.'
          : 'There are already captions in this language. Delete them first.',
      );
    const { rows } = await db.query(
      `INSERT INTO caption_tracks (media_id, lang, label, source, status, created_by) VALUES ($1,$2,$3,'auto','processing',$4)
       ON CONFLICT (media_id, lang) DO UPDATE SET label = EXCLUDED.label, source = 'auto', status = 'processing', error = NULL, created_by = EXCLUDED.created_by
       RETURNING *`,
      [id, input.lang, input.label, u.id],
    );
    await enqueue(db, 'captions.transcribe', { trackId: rows[0].id });
    reply.code(202);
    return { track: trackDto(rows[0], true) };
  });
}
