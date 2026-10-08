import type { FastifyInstance } from 'fastify';
import { transcriptSpeechSchema } from '@yapilapi/shared';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { AppError, parse } from '../lib/errors.ts';
import { isEnabled } from '../lib/services.ts';
import { speak } from '../lib/speech.ts';
import { cachedTranslation, loadTranslatable, translationsLastHour } from '../lib/translation.ts';
import { voiceJobHandlers } from '../lib/voice-transcripts.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Voice messages everyone understands (docs/product/speech-engine.md): the job that transcribes
 * voice notes and Yaps, and "Listen in French", a transcript's translation read out by a plain
 * synthetic voice. The transcript itself comes with the message (Message.transcript) and is
 * translated through POST /v1/translations and /v1/translate (kind 'transcript').
 */
export function registerVoiceMessages(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  // Read at run time, so the provider can change (tests swap it).
  Object.assign(
    ctx.jobs,
    voiceJobHandlers(() => ({ db, storage: ctx.storage, transcription: ctx.transcription, realtime: ctx.realtime, log: app.log })),
  );

  /**
   * The translation of a voice message's words into `target`, read out: the address of a spoken
   * clip, made the first time someone asks and then shared by everyone who listens. Only for
   * members who can see the message (the same check as its translation), only for a language
   * other than the one spoken, and within the speech limits (lib/speech.ts).
   */
  app.post('/v1/messages/:id/transcript/speech', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { target } = parse(transcriptSpeechSchema, req.body);
    const unavailable = () => new AppError(503, 'speech_unavailable', 'Listening isn’t available right now. Try again later.');
    if (!ctx.speech || !ctx.transcription || !ctx.ai.machineTranslation) throw unavailable();
    if (!(await isEnabled(db, 'AI_TRANSLATION'))) throw new AppError(503, 'translation_off', 'Translation is turned off right now.');
    // Who may see it (and VOICE_TRANSCRIPTS and VOICE_TRANSLATION): anyone else gets "not found".
    const item = await loadTranslatable(db, u.id, 'transcript', id);
    if (item.lang === target) throw new AppError(400, 'same_language', 'This is already in that language.');
    let text = (await cachedTranslation(db, item, target))?.body;
    if (!text) {
      if ((await translationsLastHour(db, u.id)) >= ctx.config.TRANSLATE_PER_HOUR)
        throw new AppError(429, 'translation_limit', 'You’ve translated a lot in the last hour. Try again later.');
      text = (await ctx.ai.translateItem({ userId: u.id, kind: 'transcript', id, target })).text;
    }
    const clip = await speak(
      { db, storage: ctx.storage, speech: ctx.speech, config: ctx.config },
      { text, lang: target, userId: u.id, source: { kind: 'transcript', id } },
    );
    return { url: clip.url, language: target };
  });
}
