import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '@yapilapi/database';
import {
  transcriptSpeechSchema,
  VOICE_CLIPS_PER_HOUR,
  VOICE_MAX_UPLOAD_BYTES,
  VOICE_MIN_MS,
  VOICE_SLACK_MS,
  voiceLimitMs,
  voiceUploadQuerySchema,
} from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { AppError, badRequest, featureDisabled, notFound, parse } from '../lib/errors.ts';
import { isEnabled, track } from '../lib/services.ts';
import { speak } from '../lib/speech.ts';
import { cachedTranslation, loadTranslatable, translationsLastHour } from '../lib/translation.ts';
import { loadVoice, prepareVoice, transcribeVoice, VOICE_TRANSCRIBE_JOB } from '../lib/voice.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Yaps, voice replies and voice intros (docs/product/yaps.md, lib/voice.ts). A recording is
 * uploaded here first; posting it as a Yap (POST /v1/posts with format 'yap'), answering with it
 * (POST /v1/posts/:id/comments with voiceId) or making it your intro (PATCH /v1/me/profile with
 * voiceIntroId) attaches it and starts its transcript.
 */
export default async function voiceModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  // The transcript job reads the provider when it runs, so it follows the configuration (and tests' stand-ins).
  ctx.jobs[VOICE_TRANSCRIBE_JOB] = ({ mediaId }: { mediaId: string }) => transcribeVoice({ ...ctx, transcription: ctx.transcription, log: app.log }, mediaId);

  /**
   * Upload a recording: `purpose` says what for (a Yap or a voice reply can be up to a minute, an
   * intro up to 15 seconds). It is measured from its sound, never from what the app says.
   */
  app.post('/v1/voice', { preHandler: requireAuth, config: { rateLimit: { max: VOICE_CLIPS_PER_HOUR, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    if (!(await isEnabled(db, 'YAPS'))) throw featureDisabled('Yaps');
    const { purpose } = parse(voiceUploadQuerySchema, req.query);
    // Counted here as well as by the rate limiter, which is per instance and off in tests.
    const recent = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM voice_clips WHERE owner_id = $1 AND created_at > now() - interval '1 hour'`, [
      u.id,
    ]);
    if ((recent.rows[0]?.n ?? 0) >= VOICE_CLIPS_PER_HOUR) throw new AppError(429, 'slow_down', 'You’ve recorded a lot in the last hour. Try again later.');
    const file = await req.file({ limits: { fileSize: VOICE_MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('Attach a file.');
    const tooLarge = () => new AppError(413, 'too_large', 'Recordings can be up to 8 MB.');
    const raw = await file.toBuffer().catch((e: { code?: string }) => {
      throw e.code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : e;
    });
    if (file.file.truncated) throw tooLarge();
    const clip = await prepareVoice(raw, file.mimetype);
    if (clip.durationMs < VOICE_MIN_MS) throw badRequest('This recording is too short.');
    if (clip.durationMs > voiceLimitMs(purpose) + VOICE_SLACK_MS)
      throw badRequest(purpose === 'intro' ? 'A voice intro can be up to 15 seconds.' : 'Yaps and voice replies can be up to a minute.');
    const stored = await ctx.storage.put(clip.buf, 'm4a', 'audio/mp4');
    const mediaId = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, size_bytes, duration_ms) VALUES ($1,'audio',$2,'audio/mp4','ready',$3,$4,$5) RETURNING id`,
        [u.id, stored.url, stored.key, clip.buf.length, clip.durationMs],
      );
      await c.query(`INSERT INTO voice_clips (media_id, owner_id, purpose, duration_ms, peaks) VALUES ($1,$2,$3,$4,$5)`, [
        rows[0]!.id,
        u.id,
        purpose,
        clip.durationMs,
        clip.peaks,
      ]);
      return rows[0]!.id;
    });
    track(db, u.id, 'voice_recorded', { purpose, seconds: Math.round(clip.durationMs / 1000) });
    reply.code(201);
    return { voice: (await loadVoice(db, mediaId, u.id))! };
  });

  /** One clip you can hear, with its transcript once it's there (the apps ask again while it's being made). */
  app.get('/v1/voice/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const voice = await loadVoice(db, id, req.user?.id ?? null);
    if (!voice) throw notFound('That recording');
    return { voice };
  });

  /**
   * "Listen in English": the translation of a clip's transcript, read out by a plain synthetic voice
   * (lib/speech.ts), made the first time someone asks and then shared. Only for people who can hear
   * the clip, only into another language than the one spoken, within the speech limits; the same
   * switches as for voice messages (VOICE_TRANSLATION, AI_TRANSLATION).
   */
  app.post('/v1/voice/:id/speech', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { target } = parse(transcriptSpeechSchema, req.body);
    if (!ctx.speech || !ctx.ai.machineTranslation || !(await isEnabled(db, 'VOICE_TRANSLATION')))
      throw new AppError(503, 'speech_unavailable', 'Listening isn’t available right now. Try again later.');
    if (!(await isEnabled(db, 'AI_TRANSLATION'))) throw new AppError(503, 'translation_off', 'Translation is turned off right now.');
    const item = await loadTranslatable(db, u.id, 'voice', id);
    if (item.lang === target) throw new AppError(400, 'same_language', 'This is already in that language.');
    let text = (await cachedTranslation(db, item, target))?.body;
    if (!text) {
      if ((await translationsLastHour(db, u.id)) >= ctx.config.TRANSLATE_PER_HOUR)
        throw new AppError(429, 'translation_limit', 'You’ve translated a lot in the last hour. Try again later.');
      text = (await ctx.ai.translateItem({ userId: u.id, kind: 'voice', id, target })).text;
    }
    const clip = await speak(
      { db, storage: ctx.storage, speech: ctx.speech, config: ctx.config },
      { text, lang: target, userId: u.id, source: { kind: 'voice', id } },
    );
    return { url: clip.url, language: target };
  });

  // ── Admin ─────────────────────────────────────────────────────────────

  /** For the admin console: how many Yaps, this week's, voice replies, voice intros, and where transcripts stand. */
  app.get('/v1/admin/yaps', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM posts WHERE format = 'yap' AND deleted_at IS NULL AND status = 'published')::int AS yaps,
              (SELECT count(*) FROM posts WHERE format = 'yap' AND deleted_at IS NULL AND status = 'published' AND created_at > now() - interval '7 days')::int AS this_week,
              (SELECT count(*) FROM comments WHERE voice_media_id IS NOT NULL AND deleted_at IS NULL)::int AS voice_replies,
              (SELECT count(*) FROM profiles WHERE voice_intro_media_id IS NOT NULL)::int AS intros,
              (SELECT coalesce(jsonb_object_agg(transcript_status, n), '{}') FROM (SELECT transcript_status, count(*)::int AS n FROM voice_clips GROUP BY 1) x) AS transcripts`,
    );
    const r = rows[0];
    return {
      yaps: r.yaps as number,
      thisWeek: r.this_week as number,
      voiceReplies: r.voice_replies as number,
      intros: r.intros as number,
      transcripts: { pending: 0, ready: 0, unavailable: 0, failed: 0, ...(r.transcripts as Record<string, number>) },
    };
  });
}
