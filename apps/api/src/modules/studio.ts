import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { captionFailure, mediaEditFailure } from '../lib/failures.ts';
import { enqueue } from '../lib/jobs.ts';
import { assertRecapUse } from '../lib/recap-sharing.ts';
import { saveCaptionTrack, videoDurationMs } from '../lib/studio.ts';
import { mediaVisibleSql } from '../lib/visibility.ts';
import { decodeCueText, MAX_CUE_TEXT, MAX_CUES, MAX_VTT_BYTES, parseVtt, sanitizeCueText, serializeVtt, VttError } from '../lib/webvtt.ts';
import { cachedTranslation, storeTranslation, takeTranslationBudget, translationsLastHour } from '../lib/translation.ts';
import { isEnabled } from '../lib/services.ts';
import { baseLanguage, captionTranslationQuerySchema } from '@yapilapi/shared';
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

/** `errorCode` of a failed trim, clip or caption track, and its English (`error`) for older apps; both null otherwise. */
const editError = <C extends string>(f: { code: C; english: string } | null) => ({ error: f?.english ?? null, errorCode: f?.code ?? null });

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

  /** Your video, or with `captioned` also your recording (captions are its transcript). */
  async function ownVideo(id: string, userId: string, { captioned = false } = {}) {
    const { rows } = await db.query(
      // A recording has nothing to process (no MP4 or HLS copies): it is ready as uploaded.
      `SELECT id, kind, storage_key, duration_ms, (kind = 'audio' OR variants ? 'mp4') AS processed FROM media
       WHERE id = $1 AND owner_id = $2 AND kind = ANY($3::text[]) AND NOT private`,
      [id, userId, captioned ? ['video', 'audio'] : ['video']],
    );
    if (!rows[0]) throw notFound('That video');
    return rows[0] as { id: string; kind: 'video' | 'audio'; storage_key: string | null; duration_ms: number | null; processed: boolean };
  }

  async function visibleVideo(id: string, viewer: string | null) {
    const { rows } = await db.query(`SELECT m.id, m.owner_id FROM media m WHERE m.id = $2 AND m.kind IN ('video', 'audio') AND ${mediaVisibleSql('$1')}`, [
      viewer,
      id,
    ]);
    if (!rows[0]) throw notFound('That video');
    return { id: rows[0].id as string, isOwner: rows[0].owner_id === viewer };
  }

  // ── Your videos ───────────────────────────────────────────────────────
  app.get('/v1/me/videos', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.id, m.url, m.variants, m.poster_url, m.hls_url, m.duration_ms, m.alt_text, m.created_at, (m.variants ? 'mp4') AS processed, m.status,
              (SELECT e.source_media_id FROM media_edits e WHERE e.result_media_id = m.id LIMIT 1) AS edit_of
       FROM media m WHERE m.owner_id = $1 AND m.kind = 'video' AND NOT m.private AND m.deleted_at IS NULL
         -- Not view-once videos (never stored publicly), nor echoes of someone else's reel (they can't be edited).
         AND NOT EXISTS (SELECT 1 FROM echoes e WHERE e.result_media_id = m.id AND e.original_author_id IS DISTINCT FROM m.owner_id)
       ORDER BY m.created_at DESC LIMIT 100`,
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
        // Processing gave up on it: it will never be ready to edit.
        failed: r.status === 'failed',
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
      // A failed cut says why; a cut whose new video failed processing after it has no reason of its own.
      ...editError(r.status === 'failed' ? mediaEditFailure(r.error ?? 'process_failed') : null),
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
    // A trim of a recap could be posted; it's allowed only when the recap itself could be.
    await assertRecapUse(db, u.id, [id], 'post');
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
    ...editError(isOwner && r.status === 'failed' ? captionFailure(r.error) : null),
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

  /**
   * A caption track in the reader's language, which players offer as "French (translated)".
   * Made the first time anyone asks, then kept for everyone until the track gets a new file.
   * Only for people who can see the video; a new translation counts once against the
   * person's hourly translation limit and, per 50 lines, against the day's budget. Cues as
   * JSON (the phone draws them), or WebVTT with format=vtt (for a <track> on the web).
   */
  app.get(
    '/v1/media/:id/captions/:lang/translation',
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = me(req);
      const { id, lang } = parse(langParam, req.params);
      const q = parse(captionTranslationQuerySchema, req.query);
      await visibleVideo(id, u.id);
      const { rows } = await db.query(`SELECT id, lang, storage_key FROM caption_tracks WHERE media_id = $1 AND lang = $2 AND status = 'ready'`, [id, lang]);
      const track = rows[0];
      if (!track?.storage_key) throw notFound('Those captions');
      const source = baseLanguage(track.lang);
      if (source === q.target) throw new AppError(400, 'same_language', 'This is already in that language.');
      if (!(await isEnabled(db, 'AI_TRANSLATION'))) throw new AppError(503, 'translation_off', 'Translation is turned off right now.');
      const original = (await ctx.storage.read(track.storage_key)).toString('utf8');
      const item = { kind: 'caption' as const, id: track.id as string, text: original };
      let vtt = (await cachedTranslation(db, item, q.target, { standIn: !ctx.ai.machineTranslation }))?.body;
      if (!vtt) {
        if ((await translationsLastHour(db, u.id)) >= ctx.config.TRANSLATE_PER_HOUR)
          throw new AppError(429, 'translation_limit', 'You’ve translated a lot in the last hour. Try again later.');
        const cues = parseVtt(original);
        if (ctx.ai.machineTranslation && !(await takeTranslationBudget(db, Math.max(1, Math.ceil(cues.length / 50)), ctx.config.AUTO_TRANSLATE_DAILY_LIMIT)))
          throw new AppError(503, 'translation_unavailable', 'Translation isn’t available right now. Try again later.');
        // The words only: cue tags (italics, speakers) don't survive a translation.
        const lines = cues.map((c) => decodeCueText(c.text.replace(/<[^>]*>/g, '')));
        const out = await ctx.ai.translateLines({ userId: u.id, scope: `caption:${track.id}`, lines, source, target: q.target });
        vtt = serializeVtt(cues.map((c, i) => ({ start: c.start, end: c.end, settings: c.settings, text: out.lines[i] ?? lines[i]! })));
        await storeTranslation(db, { ...item, target: q.target, sourceLanguage: source, body: vtt, provider: out.provider, model: out.model });
      }
      if (q.format === 'vtt') {
        reply.type('text/vtt; charset=utf-8').header('cache-control', 'private, max-age=3600');
        return vtt;
      }
      return {
        sourceLanguage: source,
        targetLanguage: q.target,
        machine: true,
        cues: parseVtt(vtt).map((c) => ({ start: c.start, end: c.end, text: decodeCueText(c.text) })),
      };
    },
  );

  async function trackRow(mediaId: string, lang: string) {
    return (await db.query(`SELECT * FROM caption_tracks WHERE media_id = $1 AND lang = $2`, [mediaId, lang])).rows[0];
  }

  // Create or replace captions from the Studio editor.
  app.put('/v1/media/:id/captions/:lang', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id, lang } = parse(langParam, req.params);
    const input = parse(cuesSchema, req.body);
    const video = await ownVideo(id, u.id, { captioned: true });
    const cues = input.cues.map((c, i) => {
      const text = sanitizeCueText(c.text);
      if (!text) throw fieldError(`cues.${i}.text`, 'Add the words for this caption, or remove it.');
      if (c.end <= c.start) throw fieldError(`cues.${i}.end`, 'A caption must end after it starts.');
      if (video.duration_ms && c.start * 1000 >= video.duration_ms) {
        if (video.kind === 'audio') throw fieldError(`cues.${i}.start`, 'This line starts after the recording ends.');
        throw fieldError(`cues.${i}.start`, 'This caption starts after the video ends.');
      }
      return { start: c.start, end: c.end, text };
    });
    await saveCaptionTrack(ctx, { mediaId: id, lang, label: input.label, source: 'manual', cues, userId: u.id });
    return { track: trackDto(await trackRow(id, lang), true) };
  });

  // Upload a .vtt file (multipart: file, label).
  app.put('/v1/media/:id/captions/:lang/file', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id, lang } = parse(langParam, req.params);
    await ownVideo(id, u.id, { captioned: true });
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
    await ownVideo(id, me(req).id, { captioned: true });
    const r = await db.query(`DELETE FROM caption_tracks WHERE media_id = $1 AND lang = $2`, [id, lang]);
    if (!r.rowCount) throw notFound('Those captions');
    return { ok: true };
  });

  // Automatic captions. Only available when a speech-to-text provider is configured.
  app.post('/v1/media/:id/captions/transcribe', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ lang: langParam.shape.lang, label: labelSchema }), req.body);
    const video = await ownVideo(id, u.id, { captioned: true });
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
