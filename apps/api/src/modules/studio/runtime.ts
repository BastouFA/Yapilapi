import type { FastifyRequest } from 'fastify';
import type { SpeechProvider } from '@yapilapi/ai';
import { StatusError } from '../../lib/status-error.js';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { runBinary } from '../media/processor.js';

/** What the local ffmpeg can do. Detected once per process, from the binary itself (never assumed). */
export interface Capabilities {
  available: boolean;
  libx264: boolean;
  aac: boolean;
  subtitles: boolean;
}

export interface TitleSuggestion {
  titles: string[];
  provider: string;
  draftId: string | null;
}
export interface DescriptionSuggestion {
  text: string;
  provider: string;
  draftId: string | null;
}

/**
 * Where AI-written suggestions (titles, descriptions) come from. The default implementation is the AI platform module, loaded with a
 * GUARDED dynamic import: when that module is absent, disabled (AI_ENABLED=false) or refuses, the studio answers 501 for those suggestion
 * kinds and keeps everything else (ffmpeg heuristics, manual editing) working. Providers only ever return text: applying it is a separate,
 * explicit user action, and nothing here can publish.
 */
export interface AssistProvider {
  readonly name: string;
  suggestTitles(a: {
    ctx: AppContext;
    auth: AuthContext;
    req?: FastifyRequest | undefined;
    topic: string;
    count: number;
  }): Promise<TitleSuggestion>;
  draftDescription(a: {
    ctx: AppContext;
    auth: AuthContext;
    req?: FastifyRequest | undefined;
    notes: string;
  }): Promise<DescriptionSuggestion>;
}

export interface StudioRuntime {
  /** `undefined` = resolve from the AI platform's speech seam on first use; `null` = explicitly none. */
  speech: SpeechProvider | null | undefined;
  assist: AssistProvider | null | undefined;
  capabilities: Capabilities | undefined;
}

const runtimes = new WeakMap<AppContext, StudioRuntime>();

export function getStudioRuntime(ctx: AppContext): StudioRuntime {
  let r = runtimes.get(ctx);
  if (!r) {
    r = { speech: undefined, assist: undefined, capabilities: undefined };
    runtimes.set(ctx, r);
  }
  return r;
}
/** Replace parts of the runtime (deployments with a real speech/AI provider; tests). */
export function overrideStudioRuntime(
  ctx: AppContext,
  patch: Partial<StudioRuntime>,
): StudioRuntime {
  const r = { ...getStudioRuntime(ctx), ...patch };
  runtimes.set(ctx, r);
  return r;
}

export async function capabilities(ctx: AppContext): Promise<Capabilities> {
  const rt = getStudioRuntime(ctx);
  if (rt.capabilities) return rt.capabilities;
  const ver = await runBinary(ctx.config.MEDIA_FFMPEG_PATH, ['-version'], 10_000);
  const probe = await runBinary(ctx.config.MEDIA_FFPROBE_PATH, ['-version'], 10_000);
  let caps: Capabilities = { available: false, libx264: false, aac: false, subtitles: false };
  if (ver.code === 0 && probe.code === 0) {
    const enc = await runBinary(
      ctx.config.MEDIA_FFMPEG_PATH,
      ['-hide_banner', '-encoders'],
      10_000,
    );
    const fil = await runBinary(ctx.config.MEDIA_FFMPEG_PATH, ['-hide_banner', '-filters'], 10_000);
    const e = enc.stdout.toString('utf8');
    const f = fil.stdout.toString('utf8');
    caps = {
      available: true,
      libx264: /\slibx264\s/.test(e),
      aac: /\saac\s/.test(e),
      subtitles: /\ssubtitles\s/.test(f),
    };
  }
  rt.capabilities = caps;
  return caps;
}

export const processingUnavailable = (what: string) =>
  new StatusError(
    503,
    'unavailable',
    `${what} is not available on this server: the video tools (ffmpeg) are missing or incomplete.`,
    { reason: 'processing_unavailable' },
  );

// ------------------------------------------------------------------ speech
export async function resolveSpeech(ctx: AppContext): Promise<SpeechProvider | null> {
  const rt = getStudioRuntime(ctx);
  if (rt.speech !== undefined) return rt.speech;
  try {
    const m = (await import('../ai/runtime.js')) as {
      getAiRuntime?: (c: AppContext) => { speech: { provider: SpeechProvider | null } };
    };
    return m.getAiRuntime?.(ctx).speech.provider ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ assist (AI module, guarded dynamic import)
type DirectFn = (
  ctx: AppContext,
  auth: AuthContext,
  req: FastifyRequest | undefined,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{
  artifact: { id: string; provider: string | null; payload: Record<string, unknown> } | null;
  result: Record<string, unknown>;
}>;

async function loadDirect(ctx: AppContext): Promise<DirectFn | null> {
  if (!ctx.config.AI_ENABLED) return null;
  try {
    const m = (await import('../ai/direct.js')) as { runDirectTool?: DirectFn };
    return typeof m.runDirectTool === 'function' ? m.runDirectTool : null;
  } catch {
    return null;
  }
}

export const aiModuleAssist: AssistProvider = {
  name: 'ai_module',
  async suggestTitles({ ctx, auth, req, topic, count }) {
    const run = await loadDirect(ctx);
    if (!run)
      throw new StatusError(
        501,
        'feature_disabled',
        'AI suggestions are not available on this server.',
        { reason: 'assist_unavailable' },
      );
    const r = await run(ctx, auth, req, 'creator', 'suggest_titles', { topic, count });
    const titles = (r.artifact?.payload.titles as string[] | undefined) ?? [];
    return { titles, provider: r.artifact?.provider ?? 'unknown', draftId: r.artifact?.id ?? null };
  },
  async draftDescription({ ctx, auth, req, notes }) {
    const run = await loadDirect(ctx);
    if (!run)
      throw new StatusError(
        501,
        'feature_disabled',
        'AI suggestions are not available on this server.',
        { reason: 'assist_unavailable' },
      );
    const r = await run(ctx, auth, req, 'creator', 'draft_description', { notes });
    return {
      text: (r.artifact?.payload.text as string | undefined) ?? '',
      provider: r.artifact?.provider ?? 'unknown',
      draftId: r.artifact?.id ?? null,
    };
  },
};

export function resolveAssist(ctx: AppContext): AssistProvider {
  const rt = getStudioRuntime(ctx);
  return rt.assist === undefined
    ? aiModuleAssist
    : (rt.assist ?? {
        name: 'none',
        suggestTitles: () =>
          Promise.reject(
            new StatusError(
              501,
              'feature_disabled',
              'AI suggestions are not available on this server.',
              { reason: 'assist_unavailable' },
            ),
          ),
        draftDescription: () =>
          Promise.reject(
            new StatusError(
              501,
              'feature_disabled',
              'AI suggestions are not available on this server.',
              { reason: 'assist_unavailable' },
            ),
          ),
      });
}
