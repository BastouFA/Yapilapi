import Anthropic from '@anthropic-ai/sdk';

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  refused?: boolean;
}

/** A model provider. The gateway never talks to a vendor SDK directly. */
export interface AiProvider {
  name: string;
  model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Claude via the official Anthropic SDK. */
export function anthropicProvider(apiKey: string, model: string): AiProvider {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  return {
    name: 'anthropic',
    model,
    async complete({ system, prompt, maxTokens = 2000 }) {
      // Server-side refusal fallback (routes a declined request to another model in the same call).
      const params = {
        model,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system,
        messages: [{ role: 'user', content: prompt }],
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
