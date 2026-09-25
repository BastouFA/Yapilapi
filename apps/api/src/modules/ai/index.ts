import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AGENTS,
  AGENT_IDS,
  TOOL_SPECS,
  detectLanguage,
  languageName,
  normalizeLanguage,
} from '@yapilapi/ai';
import {
  AppError,
  clampLimit,
  decodeCursor,
  encodeCursor,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { hasConsent, registerExportSection } from '../privacy/index.js';
import {
  ConfirmBody,
  confirmArtifact,
  discardArtifact,
  editArtifact,
  getArtifact,
  listArtifacts,
} from './artifacts.js';
import { runDirectTool } from './direct.js';
import { NotImplementedFeature, PermissionDenied, denialToError } from './errors.js';
import { ChatBody, DEV_NOTICE, handleChat, type ChatResult } from './gateway.js';
import { createMemory, deleteAllMemories, deleteMemory, listMemories } from './memory.js';
import { PermissionEngine } from './permissions.js';
import { getAiRuntime } from './runtime.js';
import { TRANSLATION_TARGETS, translate } from './translation.js';
import { reserveTranslation, usageSummary } from './usage.js';

export { getAiRuntime } from './runtime.js';
export { PermissionEngine } from './permissions.js';
export { handleChat } from './gateway.js';
export { executeTool } from './tools/index.js';
export { translate as translateContent } from './translation.js';
export { confirmArtifact, discardArtifact, editArtifact } from './artifacts.js';
export { createMemory, deleteMemory, deleteAllMemories, listMemories } from './memory.js';

const idParams = z.object({ id: z.uuid() });
const AI_RATE = { limit: 40, windowSec: 60, by: 'user' as const };
const DRAFT_RATE = { limit: 30, windowSec: 60, by: 'user' as const };

/** Buffer-then-stream: the answer is fully safety-screened BEFORE any text is emitted, then sent as SSE chunks. */
function sendSse(reply: FastifyReply, r: ChatResult): void {
  reply.hijack();
  const headers: Record<string, string | number | string[] | undefined> = {
    ...(reply.getHeaders() as Record<string, string | number | string[] | undefined>),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
  reply.raw.writeHead(200, headers);
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('meta', {
    conversationId: r.conversationId,
    agent: r.agent,
    provider: r.provider,
    model: r.model,
    notice: r.notice,
  });
  for (const t of r.toolCalls) send('tool', t);
  const text = r.message.content;
  for (let i = 0; i < text.length; i += 48) send('delta', { text: text.slice(i, i + 48) });
  send('done', r);
  reply.raw.end();
}

export const aiModule: ApiModule = {
  name: 'ai',
  register(app, ctx: AppContext) {
    const perms = new PermissionEngine(ctx);
    const principalOf = (a: { userId: string; ageBand: 'teen' | 'adult' }) => ({
      userId: a.userId,
      ageBand: a.ageBand,
    });
    const runtime = () => getAiRuntime(ctx);
    const requireAi = () => {
      if (!ctx.config.AI_ENABLED) throw new AppError('feature_disabled', 'AI is not available');
    };

    // ---- privacy integration: export + deletion (conversations/memories/drafts/tool audit are already covered by the core sections and hook)
    registerExportSection({
      key: 'ai_platform',
      description: 'AI usage, memory usage details and the sources behind AI drafts',
      collect: async (_c, db, u) => ({
        usage: (
          await db.query(
            'SELECT day, task, requests, tokens_in, tokens_out FROM ai_usage WHERE user_id = $1 ORDER BY day DESC, task LIMIT 2000',
            [u],
          )
        ).rows,
        memories: (
          await db.query(
            'SELECT id, content, source_type, source_ref, use_count, last_used_at, created_at FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC',
            [u],
          )
        ).rows,
        artifactSources: (
          await db.query(
            'SELECT id, kind, status, tool, provider, sources, edited, result_ref, created_at FROM ai_artifacts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2000',
            [u],
          )
        ).rows,
      }),
    });
    registerDeletionHook(async (_c, tx, userId) => {
      await tx.query('DELETE FROM ai_usage WHERE user_id = $1', [userId]);
    });

    // ------------------------------------------------------------------ status & agents
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/status',
      summary:
        'AI platform status: providers (never secrets), feature flags, your consents and budget',
      tags: ['ai'],
      auth: 'user',
      handler: async ({ auth }) => {
        const rt = runtime();
        const chain = rt.router.chain('chat');
        return {
          enabled: ctx.config.AI_ENABLED,
          defaultProvider: chain[0] ?? null,
          notice: chain[0] === 'dev' ? DEV_NOTICE : null,
          providers: rt.registry.list().map((p) => ({
            name: p.name,
            model: p.model,
            isDev: p.isDev,
            circuit: rt.router.breakerState(p.name),
          })),
          routes: Object.fromEntries(
            (['chat', 'summarise', 'translate', 'classify', 'embed'] as const).map((t) => [
              t,
              rt.router.chain(t),
            ]),
          ),
          features: {
            translation: await ctx.flags.isEnabled('AI_TRANSLATION', auth.userId),
            memory: await ctx.flags.isEnabled('MEMORY', auth.userId),
            speech: rt.speech.provider !== null,
          },
          consents: {
            aiProcessing: await hasConsent(ctx, auth.userId, 'ai_processing'),
            aiMemory: await hasConsent(ctx, auth.userId, 'ai_memory'),
          },
          usage: await usageSummary(ctx, auth.userId),
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/agents',
      summary: 'The available AI agents: scope, tools and what each may do',
      tags: ['ai'],
      auth: 'user',
      handler: async ({ auth }) => ({
        items: AGENT_IDS.map((id) => {
          const a = AGENTS[id];
          return {
            id: a.id,
            name: a.name,
            description: a.description,
            scope: a.scope,
            requiresScopeId: a.requiresScopeId,
            groundedOnly: a.safety.groundedOnly,
            availableToYou: auth.ageBand === 'adult' || a.safety.teenAllowed,
            tools: a.tools.map((t) => ({
              name: t,
              effect: TOOL_SPECS[t].effect,
              description: TOOL_SPECS[t].description,
              needsConsent: TOOL_SPECS[t].consent,
              readsPrivateMessages: TOOL_SPECS[t].privateComms,
              availableToYou: auth.ageBand === 'adult' || TOOL_SPECS[t].teenAllowed,
            })),
          };
        }),
      }),
    });

    // ------------------------------------------------------------------ chat & conversations
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/chat',
      summary:
        'Chat with an AI agent (creates or continues a conversation). stream:true answers as server-sent events after safety screening',
      tags: ['ai'],
      auth: 'user',
      body: ChatBody,
      rateLimit: AI_RATE,
      handler: async ({ auth, req, reply, body }) => {
        const r = await handleChat(ctx, auth, body, req);
        if (body.stream) {
          sendSse(reply, r);
          return undefined;
        }
        void reply.code(200);
        return r;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/conversations',
      summary: 'Your AI conversations, newest first',
      tags: ['ai'],
      auth: 'user',
      query: z.object({
        cursor: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
        if (
          query.cursor &&
          (!cur ||
            typeof cur.t !== 'string' ||
            !z.uuid().safeParse(cur.id).success ||
            Number.isNaN(Date.parse(cur.t)))
        )
          throw invalid('Invalid cursor');
        const { rows } = await ctx.db.query<{
          id: string;
          scope: string;
          scope_id: string | null;
          agent: string;
          title: string | null;
          created_at: Date;
          updated_at: Date;
          ts: string;
        }>(
          `SELECT id, scope, scope_id, agent, title, created_at, updated_at, updated_at::text AS ts FROM ai_conversations
            WHERE user_id = $1 AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
            ORDER BY updated_at DESC, id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            id: r.id,
            agent: r.agent,
            scope: r.scope,
            scopeId: r.scope_id,
            title: r.title,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
          })),
          nextCursor:
            rows.length > limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/conversations/:id/messages',
      summary: 'Messages of one of your AI conversations (with sources and safety records)',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const c = await ctx.db.query(
          'SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2',
          [params.id, auth.userId],
        );
        if (!c.rowCount) throw notFound('Conversation');
        const { rows } = await ctx.db.query<{
          id: string;
          role: string;
          content: string;
          provider: string | null;
          model: string | null;
          sources: unknown;
          safety: Record<string, unknown>;
          tool_calls: unknown;
          created_at: Date;
        }>(
          `SELECT id, role, content, provider, model, sources, safety, tool_calls, created_at FROM ai_messages WHERE conversation_id = $1 AND role IN ('user','assistant') ORDER BY created_at, id LIMIT 500`,
          [params.id],
        );
        return {
          items: rows.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            provider: m.provider,
            model: m.model,
            notice: m.provider === 'dev' ? DEV_NOTICE : null,
            sources: m.sources,
            toolCalls: m.tool_calls,
            safety: {
              refused: m.safety.refused ?? false,
              category: m.safety.category ?? null,
              output: m.safety.output ?? 'ok',
              injectionDetected: m.safety.injectionDetected ?? false,
            },
            memorySuggestions: m.safety.memorySuggestions ?? [],
            createdAt: m.created_at.toISOString(),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/ai/conversations/:id',
      summary: 'Delete an AI conversation and every stored message in it (hard delete)',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        const r = await ctx.db.query(
          'DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2',
          [params.id, auth.userId],
        );
        if (!r.rowCount) throw notFound('Conversation');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'ai.conversation.deleted',
            targetType: 'ai_conversation',
            targetId: params.id,
          },
          req,
        );
        return undefined;
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/ai/conversations',
      summary: 'Delete ALL your AI conversations',
      tags: ['ai'],
      auth: 'user',
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req }) => {
        const r = await ctx.db.query('DELETE FROM ai_conversations WHERE user_id = $1', [
          auth.userId,
        ]);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'ai.conversations.deleted_all',
            metadata: { count: r.rowCount ?? 0 },
          },
          req,
        );
        return { deleted: r.rowCount ?? 0 };
      },
    });

    // ------------------------------------------------------------------ community & business assistants
    const askBody = z.object({
      question: z.string().trim().min(2).max(1000),
      conversationId: z.uuid().optional(),
    });
    const askResponse = (r: ChatResult) => ({
      conversationId: r.conversationId,
      answer: r.message.content,
      documented: r.documented ?? false,
      sources: r.sources,
      provider: r.provider,
      model: r.model,
      notice: r.notice,
      safety: r.safety,
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/community/:id/ask',
      summary:
        "Ask a community's assistant (members only). Answers only from its rules, resources and recorded decisions; says when nothing is documented",
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      body: askBody,
      rateLimit: AI_RATE,
      handler: async ({ auth, req, params, body }) =>
        askResponse(
          await handleChat(
            ctx,
            auth,
            {
              message: body.question,
              agent: 'community',
              scopeId: params.id,
              ...(body.conversationId ? { conversationId: body.conversationId } : {}),
            },
            req,
          ),
        ),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/business/:id/ask',
      summary:
        "Ask a business's assistant (any signed-in user; only if the owner enabled it). Answers only from owner-approved knowledge",
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      body: askBody,
      rateLimit: AI_RATE,
      handler: async ({ auth, req, params, body }) =>
        askResponse(
          await handleChat(
            ctx,
            auth,
            {
              message: body.question,
              agent: 'business',
              scopeId: params.id,
              ...(body.conversationId ? { conversationId: body.conversationId } : {}),
            },
            req,
          ),
        ),
    });

    // ------------------------------------------------------------------ creator foundation: drafts only
    const creatorRoute = <S extends z.ZodType>(
      url: string,
      summary: string,
      body: S,
      tool: 'suggest_titles' | 'draft_description' | 'draft_caption' | 'thumbnail_concepts',
    ) =>
      route(app, ctx, {
        method: 'POST',
        url,
        summary,
        tags: ['ai'],
        auth: 'user',
        body,
        rateLimit: DRAFT_RATE,
        handler: async ({ auth, req, reply, body: b }) => {
          void reply.code(201);
          return runDirectTool(ctx, auth, req, 'creator', tool, b as Record<string, unknown>);
        },
      });
    const tone = z.enum(['friendly', 'professional', 'playful', 'concise', 'inspiring']).optional();
    creatorRoute(
      '/v1/ai/creator/titles',
      'Suggest titles (creates a draft; publishes nothing)',
      z.object({
        topic: z.string().trim().min(3).max(500),
        count: z.number().int().min(1).max(8).optional(),
      }),
      'suggest_titles',
    );
    creatorRoute(
      '/v1/ai/creator/descriptions',
      'Draft a description from notes (creates a draft; publishes nothing)',
      z.object({ notes: z.string().trim().min(3).max(1500), tone }),
      'draft_description',
    );
    creatorRoute(
      '/v1/ai/creator/captions',
      'Draft caption options (creates a draft; publishes nothing)',
      z.object({
        description: z.string().trim().min(3).max(500),
        tone,
        count: z.number().int().min(1).max(5).optional(),
      }),
      'draft_caption',
    );
    creatorRoute(
      '/v1/ai/creator/thumbnail-concepts',
      'Thumbnail concepts as TEXT prompts (no image is generated; creates a draft)',
      z.object({
        topic: z.string().trim().min(3).max(500),
        count: z.number().int().min(1).max(5).optional(),
      }),
      'thumbnail_concepts',
    );
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/creator/translate',
      summary:
        'Translate your own text for your content (flag AI_TRANSLATION; creates a translation draft, original kept)',
      tags: ['ai'],
      auth: 'user',
      body: z.object({
        text: z.string().trim().min(1).max(4000),
        targetLanguage: z.string().trim().min(2).max(12),
        sourceLanguage: z.string().trim().min(2).max(12).optional(),
      }),
      rateLimit: DRAFT_RATE,
      handler: async ({ auth, req, reply, body }) => {
        void reply.code(201);
        return runDirectTool(ctx, auth, req, 'creator', 'translate', body, {
          asTranslationArtifact: true,
        });
      },
    });

    // ------------------------------------------------------------------ artifacts (drafts) and the human's decision
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/artifacts',
      summary: 'Your AI drafts',
      tags: ['ai'],
      auth: 'user',
      query: z.object({
        status: z.enum(['draft', 'confirmed', 'discarded']).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      handler: async ({ auth, query }) => ({
        items: await listArtifacts(ctx, auth.userId, {
          status: query.status,
          limit: clampLimit(query.limit),
        }),
      }),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/artifacts/:id',
      summary: 'One AI draft',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => getArtifact(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/ai/artifacts/:id',
      summary: 'Edit an AI draft before confirming (the draft is then marked edited)',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      body: z.record(z.string(), z.unknown()),
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, params, body }) =>
        editArtifact(ctx, auth.userId, params.id, body, req),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/artifacts/:id/confirm',
      summary:
        'Confirm a draft: performs it through the normal service (post, comment/message, plan, unpublished event) after re-checking your permissions',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      body: ConfirmBody,
      rateLimit: { limit: 30, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, params, body }) =>
        confirmArtifact(ctx, principalOf(auth), params.id, body, req),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/artifacts/:id/discard',
      summary: 'Discard a draft',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await discardArtifact(ctx, auth.userId, params.id, req);
        return undefined;
      },
    });

    // ------------------------------------------------------------------ memory (transparent, consented, deletable)
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/memories',
      summary: 'Everything the AI remembers about you: content, source, when it was last used',
      tags: ['ai'],
      auth: 'user',
      handler: async ({ auth }) => ({
        items: await listMemories(ctx, auth.userId),
        enabled: await ctx.flags.isEnabled('MEMORY', auth.userId),
        consented: await hasConsent(ctx, auth.userId, 'ai_memory'),
        howItWorks:
          'Memories are only created from facts you state or suggestions you approve. They are used only in your own chats and are listed in the sources of each reply that used them. You can delete any or all at any time.',
      }),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/memories',
      summary:
        'Save a memory (needs the AI memory consent; from a fact you state or a suggestion you approve)',
      tags: ['ai'],
      auth: 'user',
      body: z.object({
        content: z.string().trim().min(1).max(500),
        source: z.enum(['user_stated', 'user_approved_suggestion']).default('user_stated'),
        sourceRef: z.string().trim().max(100).optional(),
      }),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        const m = await createMemory(ctx, perms, principalOf(auth), body, req);
        void reply.code(201);
        return m;
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/ai/memories/:id',
      summary: 'Delete one memory',
      tags: ['ai'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await deleteMemory(ctx, auth.userId, params.id, req);
        return undefined;
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/ai/memories',
      summary: 'Delete ALL memories',
      tags: ['ai'],
      auth: 'user',
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req }) => ({
        deleted: await deleteAllMemories(ctx, auth.userId, req),
      }),
    });

    // ------------------------------------------------------------------ translation & language
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/translate',
      summary:
        'Translate a post, comment, message (your conversations only), caption text, community or event. Always returns the original too (flag AI_TRANSLATION)',
      tags: ['ai'],
      auth: 'user',
      body: z.object({
        targetType: z.enum(TRANSLATION_TARGETS),
        targetId: z.uuid().optional(),
        text: z.string().trim().min(1).max(8000).optional(),
        targetLanguage: z.string().trim().min(2).max(12),
        sourceLanguage: z.string().trim().min(2).max(12).optional(),
      }),
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        requireAi();
        await ctx.flags.require('AI_TRANSLATION', auth.userId);
        try {
          const r = await translate(ctx, runtime(), perms, principalOf(auth), body);
          if (!r.translation.cached && !r.translation.unchanged)
            await audit(
              ctx,
              {
                actorId: auth.userId,
                action: 'ai.translate',
                targetType: body.targetType,
                targetId: body.targetId,
                metadata: { language: r.translation.language, provider: r.translation.provider },
              },
              req,
            );
          return { ...r, notice: r.translation.provider === 'dev' ? DEV_NOTICE : null };
        } catch (e) {
          if (e instanceof PermissionDenied) throw denialToError(e);
          throw e;
        }
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/language/detect',
      summary: 'Detect the language of a text (local heuristic, no model call)',
      tags: ['ai'],
      auth: 'user',
      body: z.object({ text: z.string().trim().min(1).max(4000) }),
      rateLimit: { limit: 120, windowSec: 60, by: 'user' },
      handler: async ({ body }) => {
        const d = detectLanguage(body.text);
        return { ...d, languageName: d.language === 'und' ? null : languageName(d.language) };
      },
    });

    // ------------------------------------------------------------------ speech (needs an external provider: 501 until one is registered)
    const speechBody = z.object({
      mediaId: z.uuid(),
      language: z.string().trim().min(2).max(12).optional(),
    });
    const speechAccess = async (
      auth: { userId: string; ageBand: 'teen' | 'adult' },
      mediaId: string,
    ) => {
      const provider = runtime().speech.provider;
      if (!provider)
        throw new NotImplementedFeature(
          'Voice transcription and translation need a speech provider, and none is configured on this server.',
        );
      try {
        await perms.requireConsent(principalOf(auth), 'ai_processing');
      } catch (e) {
        if (e instanceof PermissionDenied) throw denialToError(e);
        throw e;
      }
      const m = await ctx.db.query(
        `SELECT 1 FROM media WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND kind IN ('audio','video')`,
        [mediaId, auth.userId],
      );
      if (!m.rowCount) throw notFound('Media');
      return provider;
    };
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/speech/transcribe',
      summary:
        'Transcribe your own audio/video. 501 feature_disabled unless a speech provider is configured (never returns fake transcripts)',
      tags: ['ai'],
      auth: 'user',
      body: speechBody,
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, body }) => {
        const provider = await speechAccess(auth, body.mediaId);
        return provider.transcribe({
          mediaId: body.mediaId,
          userId: auth.userId,
          ...(body.language ? { language: normalizeLanguage(body.language) ?? body.language } : {}),
        });
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ai/speech/translate',
      summary:
        'Transcribe and translate your own audio/video (original transcript included). 501 feature_disabled without a speech provider',
      tags: ['ai'],
      auth: 'user',
      body: speechBody.extend({ targetLanguage: z.string().trim().min(2).max(12) }),
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, body }) => {
        await ctx.flags.require('AI_TRANSLATION', auth.userId).catch((e) => {
          if (runtime().speech.provider) throw e;
        });
        const provider = await speechAccess(auth, body.mediaId);
        await reserveTranslation(ctx, auth.userId);
        const target = normalizeLanguage(body.targetLanguage);
        if (!target) throw invalid('targetLanguage must be a language code');
        return provider.translate({
          mediaId: body.mediaId,
          userId: auth.userId,
          targetLanguage: target,
          ...(body.language ? { language: body.language } : {}),
        });
      },
    });

    // ------------------------------------------------------------------ transparency
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/usage',
      summary: 'Your AI usage and remaining daily allowance',
      tags: ['ai'],
      auth: 'user',
      handler: async ({ auth }) => usageSummary(ctx, auth.userId),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ai/tool-calls',
      summary:
        'Your AI tool-call audit: what the AI did or was denied on your behalf (inputs redacted)',
      tags: ['ai'],
      auth: 'user',
      query: z.object({
        outcome: z.enum(['allowed', 'denied', 'error']).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      handler: async ({ auth, query }) => {
        const { rows } = await ctx.db.query(
          `SELECT id, conversation_id, tool, agent, input, outcome, denial_reason, duration_ms, sources, created_at FROM ai_tool_calls
            WHERE user_id = $1 AND ($2::text IS NULL OR outcome = $2) ORDER BY created_at DESC, id LIMIT $3`,
          [auth.userId, query.outcome ?? null, clampLimit(query.limit)],
        );
        return {
          items: rows.map((r) => ({
            id: r.id,
            conversationId: r.conversation_id,
            tool: r.tool,
            agent: r.agent,
            input: r.input,
            outcome: r.outcome,
            denialReason: r.denial_reason,
            durationMs: r.duration_ms,
            sources: r.sources,
            at: (r.created_at as Date).toISOString(),
          })),
        };
      },
    });
  },
};
