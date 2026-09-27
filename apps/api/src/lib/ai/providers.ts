import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Photos the model looks at (vision), sent before the prompt. Base64, without a data: prefix. */
  images?: { mime: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string }[];
  /** A JSON schema the reply must follow (structured output). The reply text is then that JSON. */
  schema?: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  refused?: boolean;
}

/** A tool the model may call during an agent run. `run` executes server-side with the requesting person's permissions. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  run(input: Record<string, unknown>): Promise<string>;
}

export interface AgentRequest {
  system: string;
  prompt: string;
  tools: AgentTool[];
  maxSteps: number;
}

/** A model provider. The gateway never talks to a vendor SDK directly. */
export interface AiProvider {
  name: string;
  model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Multi-step tool use. Providers without it can't run agents. */
  agent?(req: AgentRequest): Promise<CompletionResult>;
}

/** Claude via the official Anthropic SDK. */
export function anthropicProvider(apiKey: string, model: string): AiProvider {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  return {
    name: 'anthropic',
    model,
    async complete({ system, prompt, maxTokens = 2000, images, schema }) {
      const content = images?.length
        ? [
            ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mime, data: i.base64 } })),
            { type: 'text' as const, text: prompt },
          ]
        : prompt;
      // Server-side refusal fallback (routes a declined request to another model in the same call).
      const params = {
        model,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: schema ? { effort: 'low', format: { type: 'json_schema', schema } } : { effort: 'low' },
        system,
        messages: [{ role: 'user', content }],
      } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
      const res = await client.beta.messages.create(params);
      if (res.stop_reason === 'refusal') return { text: '', provider: 'anthropic', model: res.model, refused: true };
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { text, provider: 'anthropic', model: res.model };
    },
    async agent({ system, prompt, tools, maxSteps }) {
      // The SDK tool runner owns the loop; each tool validates its own input before touching data.
      const runnable = tools.map((t) =>
        betaTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Parameters<typeof betaTool>[0]['inputSchema'],
          run: async (input) => {
            try {
              return await t.run(input as Record<string, unknown>);
            } catch (e) {
              return `Error: ${(e as Error).message}`;
            }
          },
        }),
      );
      const params = {
        model,
        max_tokens: 16000,
        max_iterations: maxSteps,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system,
        tools: runnable,
        messages: [{ role: 'user', content: prompt }],
      } as unknown as Parameters<typeof client.beta.messages.toolRunner>[0];
      const final = await client.beta.messages.toolRunner(params);
      if (final.stop_reason === 'refusal') return { text: '', provider: 'anthropic', model: final.model, refused: true };
      const text = final.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { text, provider: 'anthropic', model: final.model };
    },
  };
}

/**
 * Deterministic local provider for development and tests: no network, no key.
 * It returns clearly labelled, rule-based output so the whole AI pipeline
 * (permissions, context, safety, logging) can be exercised offline.
 */
export function devProvider(): AiProvider {
  return {
    name: 'dev',
    model: 'dev-rules-1',
    async complete({ prompt }) {
      return { text: prompt, provider: 'dev', model: 'dev-rules-1' };
    },
  };
}
