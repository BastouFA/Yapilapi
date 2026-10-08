import type { FastifyInstance } from 'fastify';
import {
  aiAssistSchema,
  aiSettingsSchema,
  altTextSuggestSchema,
  captionIdeasSchema,
  conversationSmartRepliesSchema,
  translateBatchSchema,
  translateSchema,
  translationSettingsSchema,
  understoodLanguages,
  type AiSettings,
  type CatchUpOffer,
  type TranslationBatch,
  type TranslationSettings,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, featureDisabled, notFound, parse } from '../lib/errors.ts';
import { translationSettings, translationsLastHour } from '../lib/translation.ts';
import type { AppContext } from '../lib/context.ts';
import { getFlags, isEnabled } from '../lib/services.ts';
import { AGENT_KINDS } from '../lib/ai/agents.ts';
import { smartRepliesEverywhereSql, smartRepliesState } from '../lib/ai/assists.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export default async function aiModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.post('/v1/ai/assist', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const input = parse(aiAssistSchema, req.body);
    if (input.task === 'translate' && !(await isEnabled(db, 'AI_TRANSLATION'))) throw featureDisabled('Translation');
    return ctx.ai.run({ userId: u.id, ...input });
  });

  /**
   * "See translation": a post, comment, story text or chat message, machine-translated
   * into `target`. Only for items the person can see right now (messages: members of
   * the chat); anything else is "not found". Translations are cached per item, target
   * and version of the text, logged in the AI audit log, and limited per person per hour.
   */
  app.post('/v1/translate', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const input = parse(translateSchema, req.body);
    if (!(await isEnabled(db, 'AI_TRANSLATION'))) throw new AppError(503, 'translation_off', 'Translation is turned off right now.');
    if ((await translationsLastHour(db, u.id)) >= ctx.config.TRANSLATE_PER_HOUR)
      throw new AppError(429, 'translation_limit', 'You’ve translated a lot in the last hour. Try again later.');
    return { translation: await ctx.ai.translateItem({ userId: u.id, kind: input.kind, id: input.id, target: input.target }) };
  });

  /**
   * Automatic translation of what's on the reader's screen (up to TRANSLATION_BATCH_MAX items),
   * into `target`, their app's language. Items they can't see right now (audience, blocks,
   * private accounts, chats they're not in) are left out exactly as "See translation" refuses
   * them, without saying which; so are items in a language they understand. Cached translations
   * come back at once; new ones within AUTO_TRANSLATE_PER_HOUR for the person and
   * AUTO_TRANSLATE_DAILY_LIMIT for everyone, and only from a real model. `auto: false` means
   * automatic translation is off or paused for now and the apps keep "See translation".
   */
  app.post(
    '/v1/translations',
    { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req): Promise<TranslationBatch> => {
      const u = me(req);
      const input = parse(translateBatchSchema, req.body);
      const flags = await getFlags(db);
      const settings = await translationSettings(db, u.id);
      if (!flags.AI_TRANSLATION || !flags.AUTO_TRANSLATE || !settings.auto) return { items: [], pending: [], auto: false };
      return ctx.ai.translateMany({
        userId: u.id,
        target: input.target,
        items: input.items,
        understood: understoodLanguages(input.target, settings.languages),
        perHour: ctx.config.AUTO_TRANSLATE_PER_HOUR,
        dailyLimit: ctx.config.AUTO_TRANSLATE_DAILY_LIMIT,
      });
    },
  );

  /** "Languages I understand" (the app's language always counts) and "Translate automatically". Also in /v1/auth/me. */
  app.get('/v1/me/translation', { preHandler: requireAuth }, async (req): Promise<TranslationSettings> => translationSettings(db, me(req).id));

  app.put('/v1/me/translation', { preHandler: requireAuth }, async (req): Promise<TranslationSettings> => {
    const input = parse(translationSettingsSchema, req.body);
    const languages = [...new Set(input.languages)];
    await db.query(
      `INSERT INTO user_preferences (user_id, languages, auto_translate) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET languages = EXCLUDED.languages, auto_translate = EXCLUDED.auto_translate, updated_at = now()`,
      [me(req).id, languages, input.auto],
    );
    return { languages, auto: input.auto };
  });

  /**
   * AI memory is explicit: the user adds, sees and deletes every item.
   * Nothing is ingested from private conversations automatically.
   */
  app.get('/v1/ai/memories', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT id, content, source, created_at FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC`, [me(req).id]);
    return { items: rows };
  });

  app.post('/v1/ai/memories', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { content } = parse(z.object({ content: z.string().trim().min(1).max(1000) }), req.body);
    const consent = await db.query(`SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'ai_processing'`, [u.id]);
    if (!consent.rows[0]?.granted)
      throw new AppError(403, 'consent_required', 'Turn on AI processing in the Privacy center to let the assistant remember things.');
    const { rows } = await db.query(`INSERT INTO ai_memories (user_id, content, source) VALUES ($1,$2,'user') RETURNING id, content, source, created_at`, [
      u.id,
      content,
    ]);
    reply.code(201);
    return { memory: rows[0] };
  });

  app.delete('/v1/ai/memories/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await db.query(`DELETE FROM ai_memories WHERE id = $1 AND user_id = $2`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Memory');
    return { ok: true };
  });

  app.delete('/v1/ai/memories', { preHandler: requireAuth }, async (req) => {
    const r = await db.query(`DELETE FROM ai_memories WHERE user_id = $1`, [me(req).id]);
    return { deleted: r.rowCount };
  });

  app.get('/v1/ai/status', async () => ({ provider: ctx.ai.providerName }));

  app.post('/v1/ai/agents/:kind', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(AGENT_KINDS) }), req.params);
    const input = parse(z.object({ prompt: z.string().trim().min(2).max(1000), businessId: z.string().uuid().optional() }), req.body);
    return ctx.ai.agent(me(req).id, kind, input.prompt, { businessId: input.businessId });
  });

  // ── AI helpers ────────────────────────────────────────────────────────
  const idParam = z.object({ id: z.string().uuid() });

  async function aiSettings(userId: string): Promise<AiSettings> {
    const { rows } = await db.query<{ smart: boolean; catch_up: boolean; transcribe_voice: boolean }>(
      `SELECT ${smartRepliesEverywhereSql('$1')} AS smart, coalesce((SELECT catch_up FROM user_preferences WHERE user_id = $1), true) AS catch_up,
              coalesce((SELECT transcribe_voice FROM user_preferences WHERE user_id = $1), true) AS transcribe_voice`,
      [userId],
    );
    return { smartReplies: !!rows[0]?.smart, catchUp: rows[0]?.catch_up ?? true, transcribeVoice: rows[0]?.transcribe_voice ?? true };
  }

  /**
   * Settings > Privacy > AI helpers: suggested replies in chats (off by default under 18), the
   * Catch me up card, and "Transcribe my voice messages".
   */
  app.get('/v1/me/ai-settings', { preHandler: requireAuth }, async (req): Promise<AiSettings> => aiSettings(me(req).id));

  app.put('/v1/me/ai-settings', { preHandler: requireAuth }, async (req): Promise<AiSettings> => {
    const u = me(req);
    const input = parse(aiSettingsSchema, req.body);
    await db.query(
      `INSERT INTO user_preferences (user_id, smart_replies, catch_up, transcribe_voice) VALUES ($1, $2, coalesce($3, true), coalesce($4, true))
       ON CONFLICT (user_id) DO UPDATE SET smart_replies = coalesce($2, user_preferences.smart_replies),
         catch_up = coalesce($3, user_preferences.catch_up), transcribe_voice = coalesce($4, user_preferences.transcribe_voice), updated_at = now()`,
      [u.id, input.smartReplies ?? null, input.catchUp ?? null, input.transcribeVoice ?? null],
    );
    // Turning the card off forgets the visits it was based on.
    if (input.catchUp === false) await db.query(`DELETE FROM pulse_visits WHERE user_id = $1`, [u.id]);
    // Turning transcripts off deletes the ones made of your voice messages (with their translations and spoken clips).
    if (input.transcribeVoice === false)
      await db.query(`DELETE FROM message_transcripts t USING messages m WHERE m.id = t.message_id AND m.sender_id = $1`, [u.id]);
    return aiSettings(u.id);
  });

  /**
   * Opening Pulse. Remembers the visit (only while Catch me up is on) and says whether to
   * offer the catch-up: after 12 hours or more away, with posts from your people since.
   */
  app.post('/v1/pulse/visit', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<CatchUpOffer> => {
    const u = me(req);
    if (!(await isEnabled(db, 'AI_CATCH_UP')) || !(await aiSettings(u.id)).catchUp) return { offer: false };
    return ctx.ai.assists.visit(u.id);
  });

  /** "Catch me up": the summary for this visit window (made once, then cached). Nothing but posts you can see goes in. */
  app.post('/v1/ai/catch-up', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!(await isEnabled(db, 'AI_CATCH_UP'))) throw featureDisabled('Catch me up');
    return { catchUp: await ctx.ai.assists.catchUp(me(req).id) };
  });

  app.post('/v1/ai/catch-up/dismiss', { preHandler: requireAuth }, async (req) => {
    await ctx.ai.assists.dismissCatchUp(me(req).id);
    return { ok: true };
  });

  /** Up to three suggested replies to the last message you received here. Tapping one only puts it in the message box. */
  app.post('/v1/conversations/:id/smart-replies', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const flag = await isEnabled(db, 'AI_SMART_REPLIES');
    if (!flag) throw featureDisabled('Suggested replies');
    return ctx.ai.assists.smartReplies(me(req).id, id, flag);
  });

  /** Suggested replies in one chat: on, off, or back to the default (null). */
  app.put('/v1/conversations/:id/smart-replies', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { enabled } = parse(conversationSmartRepliesSchema, req.body);
    const { rows } = await db.query<{ kind: string; everywhere: boolean }>(
      `UPDATE conversation_members cm SET smart_replies = $3 FROM conversations c
       WHERE c.id = cm.conversation_id AND cm.conversation_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL
       RETURNING c.kind, ${smartRepliesEverywhereSql('$2')} AS everywhere`,
      [id, u.id, enabled],
    );
    if (!rows[0]) throw notFound('Conversation');
    return { smartReplies: smartRepliesState(rows[0].kind, enabled, rows[0].everywhere, await isEnabled(db, 'AI_SMART_REPLIES')) };
  });

  /** "Suggest a description" for one of your photos. The suggestion is only shown; you edit it and save it with the post. */
  app.post('/v1/ai/alt-text', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    if (!(await isEnabled(db, 'AI_ALT_TEXT'))) throw featureDisabled('Photo descriptions');
    const { mediaId } = parse(altTextSuggestSchema, req.body);
    return { suggestion: await ctx.ai.assists.altText(me(req).id, mediaId) };
  });

  /** "Suggest a caption": three caption ideas and hashtags already used on YAPILAPI. */
  app.post('/v1/ai/captions', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    if (!(await isEnabled(db, 'AI_CAPTIONS'))) throw featureDisabled('Caption ideas');
    const input = parse(captionIdeasSchema, req.body);
    return { ideas: await ctx.ai.assists.captionIdeas(me(req).id, input) };
  });
}
