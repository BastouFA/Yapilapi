import {
  TOOL_SPECS,
  isToolName,
  redactForAudit,
  toolDescriptor,
  type AgentConfig,
  type ToolCall,
  type ToolDescriptor,
  type ToolName,
} from '@yapilapi/ai';
import { AppError } from '@yapilapi/shared';
import type { ToolContext, ToolHandler, ToolOutcomeSummary, ToolResult } from '../types.js';
import { PermissionDenied, type DenialReason } from '../errors.js';
import {
  createEventDraft,
  draftCaption,
  draftDescription,
  draftPost,
  draftReply,
  suggestTitles,
  thumbnailConcepts,
} from './drafts.js';
import { businessAssistantAnswer, communityFaqAnswer, translateTool } from './knowledge.js';
import { planFromConversation, summarizeConversation } from './private.js';
import { findEvents, getEventDetails, searchContent, summarizeThread } from './read.js';

/** Handlers for the typed tool registry (contracts live in @yapilapi/ai TOOL_SPECS). No handler mutates anything except creating a DRAFT. */
export const HANDLERS: Record<ToolName, ToolHandler> = {
  search_content: searchContent as ToolHandler,
  get_event_details: getEventDetails as ToolHandler,
  find_events: findEvents as ToolHandler,
  summarize_thread: summarizeThread as ToolHandler,
  summarize_conversation: summarizeConversation as ToolHandler,
  draft_post: draftPost as ToolHandler,
  draft_reply: draftReply as ToolHandler,
  draft_caption: draftCaption as ToolHandler,
  draft_description: draftDescription as ToolHandler,
  suggest_titles: suggestTitles as ToolHandler,
  thumbnail_concepts: thumbnailConcepts as ToolHandler,
  plan_from_conversation: planFromConversation as ToolHandler,
  create_event_draft: createEventDraft as ToolHandler,
  community_faq_answer: communityFaqAnswer as ToolHandler,
  business_assistant_answer: businessAssistantAnswer as ToolHandler,
  translate: translateTool as ToolHandler,
};

export const describeTools = (agent: AgentConfig): ToolDescriptor[] =>
  agent.tools.map((n) => toolDescriptor(n));

export interface ToolExecution {
  call: ToolCall;
  ok: boolean;
  outcome: ToolOutcomeSummary;
  /** JSON string given back to the model. */
  content: string;
  result?: ToolResult;
}

const MAX_TOOL_CONTENT = 8000;

async function audit(
  tc: ToolContext,
  tool: string,
  input: unknown,
  outcome: 'allowed' | 'denied' | 'error',
  reason: string | null,
  ms: number,
  sources: unknown[],
): Promise<void> {
  await tc.ctx.db.query(
    `INSERT INTO ai_tool_calls (user_id, conversation_id, tool, input, outcome, denial_reason, agent, duration_ms, sources, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      tc.principal.userId,
      tc.conversationId,
      tool.slice(0, 80),
      JSON.stringify(redactForAudit(input)),
      outcome,
      reason,
      tc.agent.id,
      Math.round(ms),
      JSON.stringify(sources.slice(0, 50)),
      tc.req?.id ?? null,
    ],
  );
}

/**
 * TOOL SYSTEM executor. For every call, in order:
 *  1. the tool must exist and be one this agent may use (deny by default)
 *  2. arguments are validated with the tool's zod schema (model arguments are untrusted input)
 *  3. the Permission Engine checks scope, grants, teen rules and required consent BEFORE the handler runs
 *  4. the handler runs (its data access goes through the Permission Engine again, as the user)
 *  5. the call is audited in ai_tool_calls with redacted input, outcome and any denial reason
 * The model never gets a raw exception: it gets `{ok:false, error}` and the user's answer says what happened.
 */
export async function executeTool(tc: ToolContext, call: ToolCall): Promise<ToolExecution> {
  const started = Date.now();
  const finish = async (
    ok: boolean,
    outcome: ToolOutcomeSummary,
    payload: Record<string, unknown>,
    result?: ToolResult,
    input: unknown = call.arguments,
  ): Promise<ToolExecution> => {
    await audit(
      tc,
      call.name,
      input,
      outcome.outcome,
      outcome.reason ?? null,
      Date.now() - started,
      result?.sources ?? [],
    );
    tc.turn.toolOutcomes.push(outcome);
    if (result) tc.turn.sources.push(...result.sources);
    let content = JSON.stringify({ tool: call.name, ...payload });
    if (content.length > MAX_TOOL_CONTENT)
      content = JSON.stringify({
        tool: call.name,
        ok,
        result: {
          display: String(
            (payload.result as { display?: string } | undefined)?.display ?? '',
          ).slice(0, 2000),
          truncated: true,
        },
      });
    return { call, ok, outcome, content, ...(result ? { result } : {}) };
  };
  const denied = (reason: DenialReason, message: string) =>
    finish(
      false,
      { tool: call.name, outcome: 'denied', reason },
      { ok: false, error: { code: 'denied', reason, message } },
    );

  if (!isToolName(call.name)) return denied('tool_not_allowed', 'Unknown tool');
  const spec = TOOL_SPECS[call.name];
  try {
    tc.permissions.checkTool(tc.principal, spec, tc.agent, tc.scope);
    const parsed = spec.input.safeParse(call.arguments);
    if (!parsed.success) {
      return finish(
        false,
        { tool: call.name, outcome: 'error', reason: 'invalid_input' },
        {
          ok: false,
          error: {
            code: 'invalid_input',
            message: parsed.error.issues
              .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
              .join('; ')
              .slice(0, 300),
          },
        },
      );
    }
    if (spec.consent) await tc.permissions.requireConsent(tc.principal, spec.consent);
    const result = await HANDLERS[call.name](tc, parsed.data as never);
    const outcome: ToolOutcomeSummary = {
      tool: call.name,
      outcome: 'allowed',
      ...(result.artifact ? { artifactId: result.artifact.id } : {}),
    };
    return await finish(true, outcome, { ok: true, result: result.result }, result, parsed.data);
  } catch (err) {
    if (err instanceof PermissionDenied) return denied(err.reason, err.message);
    if (err instanceof AppError) {
      if (err.code === 'feature_disabled') return denied('feature_disabled', err.message);
      // Quota, provider outage and validation errors must reach the caller as real HTTP errors, not be swallowed into a chat answer.
      if (err.code === 'rate_limited' || err.status >= 500) throw err;
      return finish(
        false,
        { tool: call.name, outcome: 'error', reason: err.code },
        { ok: false, error: { code: err.code, message: err.message } },
      );
    }
    tc.ctx.log.error({ err, tool: call.name }, 'AI tool failed');
    return finish(
      false,
      { tool: call.name, outcome: 'error', reason: 'internal' },
      { ok: false, error: { code: 'internal', message: 'The tool failed' } },
    );
  }
}
