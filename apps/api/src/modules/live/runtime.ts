import { StatusError } from '../../lib/status-error.js';
import type { AppContext } from '../../lib/context.js';

/**
 * Providers the LIVE module needs from outside. Nothing here pretends: with no ingest provider a `video` session cannot be started
 * (501 ingest_unavailable) while `interactive` sessions (chat, polls, Q&A, gifts, shopping) work with no provider at all.
 */
export interface IngestStream {
  ref: string;
  ingestUrl: string;
  streamKey: string;
  playbackUrl: string | null;
}
export interface IngestProvider {
  readonly name: string;
  /** False for the `none` provider. */
  readonly available: boolean;
  /** Create the stream for a session. `ref` is an opaque handle stored on the session; `streamKey` is shown to the host ONCE and never stored. */
  createStream(input: { liveId: string; hostId: string }): Promise<IngestStream>;
  endStream(ref: string): Promise<void>;
}

export const noIngest: IngestProvider = {
  name: 'none',
  available: false,
  createStream: async () => {
    throw new StatusError(
      501,
      'feature_disabled',
      'This server has no live video ingest provider configured. Start an interactive session instead.',
      { reason: 'ingest_unavailable' },
    );
  },
  endStream: async () => undefined,
};

/** Optional machine translation for chat/Q&A. No provider means 501, never a made-up translation. */
export interface TranslationProvider {
  readonly name: string;
  translate(text: string, target: string, source?: string): Promise<string>;
}

export interface LiveRuntime {
  ingest: IngestProvider;
  translation: TranslationProvider | null;
}

const runtimes = new WeakMap<AppContext, LiveRuntime>();
export function getLiveRuntime(ctx: AppContext): LiveRuntime {
  let r = runtimes.get(ctx);
  if (!r) {
    r = { ingest: noIngest, translation: null };
    runtimes.set(ctx, r);
  }
  return r;
}
/** Wiring point for real providers (and for tests). */
export function overrideLiveRuntime(ctx: AppContext, patch: Partial<LiveRuntime>): LiveRuntime {
  const r = { ...getLiveRuntime(ctx), ...patch };
  runtimes.set(ctx, r);
  return r;
}
