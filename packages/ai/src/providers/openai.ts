import {
  ProviderError,
  type CallOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type EmbedResponse,
  type ModelProvider,
  type TaskKind,
  type ToolCall,
} from '../types.js';
import { wrapUntrusted } from '../safety/injection.js';
import { defaultFetch, postJson, safeJsonObject, type FetchLike } from './http.js';

/**
 * OpenAI Chat Completions adapter (fetch, no SDK). Mapping functions are pure and unit-tested against hand-authored fixtures
 * shaped like the documented API; the live network path is not exercised in CI (no keys).
 */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiRequestBody {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  max_completion_tokens: number;
  temperature?: number;
  response_format?: { type: 'json_object' };
}

export function toOpenAiRequest(req: ChatRequest, model: string): OpenAiRequestBody {
  const messages: OpenAiMessage[] = [];
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === 'system' || m.role === 'user')
      messages.push({ role: m.role, content: m.content });
    else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      });
    } else
      messages.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: m.untrusted
          ? wrapUntrusted({ type: 'tool', id: m.toolName ?? 'result' }, m.content)
          : m.content,
      });
  }
  if (req.responseFormat && !messages.some((m) => m.role === 'system' && /json/i.test(m.content))) {
    messages.unshift({
      role: 'system',
      content: 'Respond with a single valid JSON object and nothing else.',
    });
  }
  const body: OpenAiRequestBody = {
    model,
    messages,
    max_completion_tokens: req.maxTokens ?? 1024,
    temperature: req.temperature ?? (req.task === 'chat' ? 0.3 : 0),
  };
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  if (req.responseFormat) body.response_format = { type: 'json_object' };
  return body;
}

export function fromOpenAiResponse(json: unknown, fallbackModel: string): ChatResponse {
  const j = json as {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = j?.choices?.[0];
  if (!choice?.message)
    throw new ProviderError('malformed_response', 'openai response has no choices', 'openai');
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
    .filter((c) => c.function?.name)
    .map((c) => ({
      id: c.id ?? '',
      name: c.function!.name!,
      arguments: safeJsonObject(c.function!.arguments ?? '{}'),
    }));
  return {
    content: choice.message.content ?? '',
    toolCalls,
    provider: 'openai',
    model: j.model ?? fallbackModel,
    usage: {
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
    },
    finishReason:
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : 'stop',
  };
}

export interface OpenAiOptions {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number;
  fetchFn?: FetchLike;
}

export class OpenAiProvider implements ModelProvider {
  readonly name = 'openai';
  readonly isDev = false;
  readonly model: string;
  private readonly base: string;
  constructor(private readonly o: OpenAiOptions) {
    this.model = o.model || OPENAI_DEFAULT_MODEL;
    this.base = (o.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  }
  supports(_task: TaskKind): boolean {
    return true;
  }

  private opts(signal: AbortSignal | undefined) {
    return {
      provider: this.name,
      fetchFn: this.o.fetchFn ?? defaultFetch,
      timeoutMs: this.o.timeoutMs ?? 20_000,
      signal,
    };
  }

  async chat(req: ChatRequest, opts: CallOptions = {}): Promise<ChatResponse> {
    if (req.task === 'embed') throw new ProviderError('unsupported', 'use embed()', this.name);
    const json = await postJson(
      `${this.base}/v1/chat/completions`,
      { authorization: `Bearer ${this.o.apiKey}` },
      toOpenAiRequest(req, this.model),
      this.opts(opts.signal),
    );
    return fromOpenAiResponse(json, this.model);
  }

  async embed(texts: string[], opts: CallOptions = {}): Promise<EmbedResponse> {
    const json = (await postJson(
      `${this.base}/v1/embeddings`,
      { authorization: `Bearer ${this.o.apiKey}` },
      { model: OPENAI_EMBEDDING_MODEL, input: texts },
      this.opts(opts.signal),
    )) as {
      data?: Array<{ embedding: number[]; index: number }>;
      model?: string;
      usage?: { prompt_tokens?: number };
    };
    if (!Array.isArray(json.data))
      throw new ProviderError(
        'malformed_response',
        'openai embeddings response has no data',
        this.name,
      );
    const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return {
      vectors,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: 0 },
      provider: this.name,
      model: json.model ?? OPENAI_EMBEDDING_MODEL,
    };
  }
}
