import type { ChatRequest, ChatResponse } from '@yapilapi/ai';
import { callModel } from './usage.js';
import type { ToolContext } from './types.js';

/** A model call made on behalf of a tool or the gateway: budgeted, routed, metered, and recorded in the turn. */
export async function modelCall(
  tc: Pick<ToolContext, 'ctx' | 'runtime' | 'principal' | 'turn'>,
  req: ChatRequest,
  opts: { countRequest?: boolean } = {},
): Promise<ChatResponse> {
  const { response } = await callModel(tc.ctx, tc.runtime, tc.principal.userId, req, opts);
  tc.turn.providers.add(response.provider);
  tc.turn.models.add(response.model);
  tc.turn.tokens.input += response.usage.inputTokens;
  tc.turn.tokens.output += response.usage.outputTokens;
  return response;
}

/** Extract a JSON object from a model reply (tolerates code fences and leading prose); null when there is none. */
export function parseJsonReply(content: string): unknown {
  const t = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(t);
  } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
