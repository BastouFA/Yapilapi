/**
 * Provider-agnostic AI types. Nothing here knows about HTTP, the database or YAPILAPI's authorization rules:
 * this package is portable logic (routing, safety heuristics, tool contracts, agent configs). The API module
 * (apps/api/src/modules/ai) wires it to Postgres, permissions and the visibility rules.
 */

export const TASKS = ['chat', 'summarise', 'translate', 'classify', 'embed'] as const;
export type TaskKind = (typeof TASKS)[number];

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments as produced by the model. UNTRUSTED: the tool system validates them with zod. */
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant messages that asked for tools */
  toolCalls?: ToolCall[];
  /** tool messages: which call this answers */
  toolCallId?: string;
  toolName?: string;
  /** Tool results that carry other people's content: live adapters wrap them as inert <untrusted_data>. */
  untrusted?: boolean;
}

/** JSON-schema description of a tool as sent to a model. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  task: TaskKind;
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  /** Ask for a JSON document (structured output). `schemaName` lets the dev provider pick a deterministic extractor. */
  responseFormat?: { type: 'json'; schemaName: string };
  maxTokens?: number;
  temperature?: number;
  /** Non-sensitive hints for deterministic providers (ids only, never user content). */
  hints?: {
    attachedConversationIds?: string[];
    /** What the user is looking at (an id only, never content). Tools still authorise it. */
    focus?: { type: 'post' | 'comment' | 'event' | 'conversation'; id: string };
    language?: string;
    targetLanguage?: string;
  };
  /** Structured, user-authored inputs for drafting/translation tasks (also embedded in the prompt for real models). */
  input?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Which provider produced this. ALWAYS set; 'dev' can never be mistaken for a real model. */
  provider: string;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface EmbedResponse {
  vectors: number[][];
  usage: Usage;
  provider: string;
  model: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface StreamChunk {
  delta: string;
}

export interface ModelProvider {
  readonly name: string;
  /** True only for the deterministic offline responder. */
  readonly isDev: boolean;
  /** Default model id reported in responses. */
  readonly model: string;
  supports(task: TaskKind): boolean;
  chat(req: ChatRequest, opts?: CallOptions): Promise<ChatResponse>;
  /** Optional native streaming. The gateway never streams unscreened text, so this is informational. */
  chatStream?(req: ChatRequest, opts?: CallOptions): AsyncIterable<StreamChunk>;
  embed?(texts: string[], opts?: CallOptions): Promise<EmbedResponse>;
}

export type ProviderErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_request'
  | 'unsupported'
  | 'malformed_response';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  /** Should the router try the next provider (and count the failure against the circuit breaker)? */
  get retryable(): boolean {
    return this.kind !== 'invalid_request';
  }
  /** Does the failure say something about the provider's health (breaker input)? */
  get countsAgainstBreaker(): boolean {
    return this.kind !== 'invalid_request' && this.kind !== 'unsupported';
  }
}

/** Provenance of anything that entered a context or an answer. */
export interface SourceRef {
  type:
    | 'memory'
    | 'post'
    | 'comment'
    | 'message'
    | 'conversation'
    | 'event'
    | 'search_result'
    | 'profile'
    | 'community_rule'
    | 'community_resource'
    | 'community_decision'
    | 'business_knowledge'
    | 'artifact'
    | 'translation';
  id: string;
  label?: string;
}
