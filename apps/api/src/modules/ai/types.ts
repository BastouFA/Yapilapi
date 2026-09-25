import type { FastifyRequest } from 'fastify';
import type { AgentConfig, AgentScope, SourceRef, ToolName } from '@yapilapi/ai';
import type { AppContext } from '../../lib/context.js';
import type { PermissionEngine, Principal } from './permissions.js';
import type { AiRuntime } from './runtime.js';

export interface InjectionState {
  detected: boolean;
  removed: number;
  rules: Set<string>;
}

export interface ToolOutcomeSummary {
  tool: string;
  outcome: 'allowed' | 'denied' | 'error';
  reason?: string;
  artifactId?: string;
}

/** Everything that accumulates while ONE request is processed (the "turn"). */
export interface TurnState {
  sources: SourceRef[];
  injection: InjectionState;
  artifacts: Array<{ id: string; kind: string; status: string }>;
  toolOutcomes: ToolOutcomeSummary[];
  /** Strings that may legitimately appear verbatim in the answer (user's own message, approved knowledge). */
  allowLiterals: string[];
  knownUrls: string[];
  /** A source in this turn came from a private communication (never fed back into later history). */
  privateSource: boolean;
  providers: Set<string>;
  models: Set<string>;
  tokens: { input: number; output: number };
  documented?: boolean;
}

export const newTurn = (): TurnState => ({
  sources: [],
  injection: { detected: false, removed: 0, rules: new Set() },
  artifacts: [],
  toolOutcomes: [],
  allowLiterals: [],
  knownUrls: [],
  privateSource: false,
  providers: new Set(),
  models: new Set(),
  tokens: { input: 0, output: 0 },
});

export interface ToolContext {
  ctx: AppContext;
  runtime: AiRuntime;
  principal: Principal;
  permissions: PermissionEngine;
  agent: AgentConfig;
  scope: AgentScope;
  scopeId: string | null;
  conversationId: string | null;
  attached: ReadonlySet<string>;
  turn: TurnState;
  req?: FastifyRequest | undefined;
}

export interface ToolResult {
  /** Returned to the model (and shown to the user by the dev provider): must be safe text in `display`. */
  result: Record<string, unknown> & { display: string };
  sources: SourceRef[];
  artifact?: { id: string; kind: string } | undefined;
}

export type ToolHandler = (tc: ToolContext, input: never) => Promise<ToolResult>;

export type { ToolName };
