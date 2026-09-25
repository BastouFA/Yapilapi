import type { FastifyRequest } from 'fastify';
import { getAgent, type ToolName } from '@yapilapi/ai';
import { AppError } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { getArtifact, type ArtifactView } from './artifacts.js';
import { createArtifact } from './artifacts-store.js';
import { PermissionDenied, denialToError } from './errors.js';
import { PermissionEngine } from './permissions.js';
import { getAiRuntime } from './runtime.js';
import { executeTool } from './tools/index.js';
import { newTurn, type ToolContext } from './types.js';

export interface DirectResult {
  display: string;
  artifact: ArtifactView | null;
  result: Record<string, unknown>;
}

/**
 * Run ONE tool for a creator/foundation endpoint. It goes through exactly the same executor as chat (validation, permission engine, consent,
 * audit in ai_tool_calls), so these endpoints cannot do anything chat could not, and they only ever PRODUCE drafts.
 */
export async function runDirectTool(
  ctx: AppContext,
  auth: AuthContext,
  req: FastifyRequest | undefined,
  agentId: string,
  tool: ToolName,
  args: Record<string, unknown>,
  opts: { asTranslationArtifact?: boolean } = {},
): Promise<DirectResult> {
  if (!ctx.config.AI_ENABLED) throw new AppError('feature_disabled', 'AI is not available');
  const agent = getAgent(agentId)!;
  const tc: ToolContext = {
    ctx,
    runtime: getAiRuntime(ctx),
    principal: { userId: auth.userId, ageBand: auth.ageBand },
    permissions: new PermissionEngine(ctx),
    agent,
    scope: agent.scope,
    scopeId: null,
    conversationId: null,
    attached: new Set(),
    turn: newTurn(),
    req,
  };
  const ex = await executeTool(tc, { id: `direct_${tool}`, name: tool, arguments: args });
  if (!ex.ok) {
    if (ex.outcome.outcome === 'denied')
      throw denialToError(
        new PermissionDenied(
          (ex.outcome.reason ?? 'not_visible') as never,
          (JSON.parse(ex.content) as { error?: { message?: string } }).error?.message,
        ),
      );
    throw new AppError(
      'validation_failed',
      (JSON.parse(ex.content) as { error?: { message?: string } }).error?.message ??
        'The request could not be completed',
    );
  }
  const result = ex.result!.result;
  let artifactId = ex.result!.artifact?.id;
  if (!artifactId && opts.asTranslationArtifact) {
    const a = await createArtifact(tc, {
      kind: 'translation',
      tool,
      payload: {
        text: result.translation,
        original: result.original,
        language: result.language,
        provider: result.provider,
      },
      sources: [],
    });
    artifactId = a.id;
  }
  return {
    display: String(result.display),
    artifact: artifactId ? await getArtifact(ctx, auth.userId, artifactId) : null,
    result,
  };
}
