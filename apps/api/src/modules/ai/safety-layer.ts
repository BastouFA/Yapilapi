import {
  SUPPORT_MESSAGE,
  neutralizeInjection,
  screenOutput,
  screenRequest,
  type OutputScreenResult,
  type RequestVerdict,
  type SourceRef,
} from '@yapilapi/ai';
import type { AppContext } from '../../lib/context.js';
import { supportResources } from '../safety/index.js';
import type { AiRuntime } from './runtime.js';
import type { ToolContext, TurnState } from './types.js';

/**
 * SAFETY LAYER (the last stage before a response, and the first before a model).
 *  input : screenRequest  (self-harm route, disallowed categories, teen rules, prompt extraction)
 *  data  : neutralize     (prompt-injection heuristics on retrieved content; text is treated as untrusted data)
 *  output: screenOutput   (secrets/PII redaction, system-prompt leak block, exfiltration links, moderation classifier)
 */
export function screenUserRequest(
  runtime: AiRuntime,
  text: string,
  ageBand: 'teen' | 'adult',
): RequestVerdict {
  const v = screenRequest(text, { ageBand });
  if (v.action === 'support') runtime.metrics.safety.inc({ kind: 'self_harm_route' });
  else if (v.action === 'refuse') runtime.metrics.safety.inc({ kind: `refused_${v.category}` });
  else if (v.userInjectionAttempt) runtime.metrics.safety.inc({ kind: 'user_injection_attempt' });
  return v;
}

/** Clean retrieved text for use as context and record whether the source looked hostile (surfaced to the user as a safety note). */
export function sanitizeRetrieved(
  tc: { runtime: AiRuntime; turn: TurnState },
  text: string,
): string {
  const n = neutralizeInjection(text);
  if (n.removed > 0 || n.findings.length) {
    tc.turn.injection.detected = true;
    tc.turn.injection.removed += n.removed;
    for (const f of n.findings) tc.turn.injection.rules.add(f.rule);
    tc.runtime.metrics.safety.inc({ kind: 'injection_detected' });
  }
  return n.text;
}

export function outputScreenOptions(
  ctx: AppContext,
  runtime: AiRuntime,
  turn: TurnState,
  extra: { systemPrompt?: string; userText?: string } = {},
) {
  const hosts = [ctx.config.WEB_PUBLIC_URL, ctx.config.API_PUBLIC_URL, ctx.config.ADMIN_PUBLIC_URL]
    .map((u) => {
      try {
        return new URL(u).host.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return {
    canary: runtime.canary,
    ...(extra.systemPrompt ? { systemPrompt: extra.systemPrompt } : {}),
    allowLiterals: [...turn.allowLiterals, ...(extra.userText ? [extra.userText] : [])],
    allowedHosts: hosts,
    knownUrls: turn.knownUrls,
    injectionSuspected: turn.injection.detected,
  };
}

export function screenAnswer(
  tc: Pick<ToolContext, 'ctx' | 'runtime' | 'turn'>,
  text: string,
  extra: { systemPrompt?: string; userText?: string } = {},
): OutputScreenResult {
  const r = screenOutput(text, outputScreenOptions(tc.ctx, tc.runtime, tc.turn, extra));
  if (r.verdict !== 'ok') tc.runtime.metrics.safety.inc({ kind: `output_${r.verdict}` });
  return r;
}

export interface SupportPayload {
  message: string;
  resources: ReturnType<typeof supportResources>;
}

export function supportPayload(region?: string | null): SupportPayload {
  return { message: SUPPORT_MESSAGE, resources: supportResources(region) };
}

export const dedupeSources = (s: SourceRef[]): SourceRef[] => {
  const seen = new Set<string>();
  return s.filter((x) => {
    const k = `${x.type}:${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
