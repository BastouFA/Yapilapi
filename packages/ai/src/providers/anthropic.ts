import {
  ProviderError,
  type CallOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type TaskKind,
  type ToolCall,
} from '../types.js';
import { wrapUntrusted } from '../safety/injection.js';
import { defaultFetch, postJson, safeJsonObject, type FetchLike } from './http.js';

/**
 * Anthropic Messages API adapter (fetch, no SDK). `toAnthropicRequest` / `fromAnthropicResponse` are pure and unit-tested against
 * hand-authored fixtures shaped like the documented API (providers/fixtures). The live network path is NOT exercised in CI (no keys):
 * see docs/architecture/ai-platform.md "Live providers".
 */
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}
export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  temperature?: number;
}

const JSON_ONLY =
  '\n\nRespond with a single valid JSON object and nothing else (no prose, no code fences).';

export function toAnthropicRequest(req: ChatRequest, model: string): AnthropicRequestBody {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === 'system') system.push(m.content);
    else if (m.role === 'user') pushBlocks('user', [{ type: 'text', text: m.content }]);
    else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? [])
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      if (blocks.length) pushBlocks('assistant', blocks);
    } else
      pushBlocks('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.untrusted
            ? wrapUntrusted({ type: 'tool', id: m.toolName ?? 'result' }, m.content)
            : m.content,
        },
      ]);
  }
  const body: AnthropicRequestBody = {
    model,
    max_tokens: req.maxTokens ?? 1024,
    messages,
    temperature: req.temperature ?? (req.task === 'chat' ? 0.3 : 0),
  };
  const sys = system.join('\n\n') + (req.responseFormat ? JSON_ONLY : '');
  if (sys.trim()) body.system = sys.trim();
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  return body;
}

export function fromAnthropicResponse(json: unknown, fallbackModel: string): ChatResponse {
  const j = json as {
    model?: string;
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!j || !Array.isArray(j.content))
    throw new ProviderError(
      'malformed_response',
      'anthropic response has no content array',
      'anthropic',
    );
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const b of j.content) {
    if (b.type === 'text' && typeof b.text === 'string') content += b.text;
    else if (b.type === 'tool_use' && typeof b.name === 'string') {
      toolCalls.push({
        id: String(b.id ?? ''),
        name: b.name,
        arguments:
          b.input && typeof b.input === 'object'
            ? (b.input as Record<string, unknown>)
            : safeJsonObject(''),
      });
    }
  }
  return {
    content,
    toolCalls,
    provider: 'anthropic',
    model: j.model ?? fallbackModel,
    usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
    finishReason:
      j.stop_reason === 'tool_use'
        ? 'tool_calls'
        : j.stop_reason === 'max_tokens'
          ? 'length'
          : 'stop',
  };
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number;
  fetchFn?: FetchLike;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly isDev = false;
  readonly model: string;
  private readonly base: string;
  constructor(private readonly o: AnthropicOptions) {
    this.model = o.model || ANTHROPIC_DEFAULT_MODEL;
    this.base = (o.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  }
  supports(task: TaskKind): boolean {
    return task !== 'embed';
  }

  async chat(req: ChatRequest, opts: CallOptions = {}): Promise<ChatResponse> {
    if (req.task === 'embed')
      throw new ProviderError('unsupported', 'anthropic has no embeddings endpoint', this.name);
    const json = await postJson(
      `${this.base}/v1/messages`,
      { 'x-api-key': this.o.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      toAnthropicRequest(req, this.model),
      {
        provider: this.name,
        fetchFn: this.o.fetchFn ?? defaultFetch,
        timeoutMs: this.o.timeoutMs ?? 20_000,
        signal: opts.signal,
      },
    );
    return fromAnthropicResponse(json, this.model);
  }
}
