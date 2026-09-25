import { describe, expect, it } from 'vitest';
import {
  AllProvidersFailedError,
  CircuitBreaker,
  ModelRouter,
  ProviderRegistry,
} from './router.js';
import { DevProvider } from './providers/dev.js';
import {
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderErrorKind,
} from './types.js';

const req: ChatRequest = { task: 'chat', messages: [{ role: 'user', content: 'hello' }] };

class Scripted implements ModelProvider {
  readonly isDev = false;
  readonly model = 'scripted-1';
  calls = 0;
  mode: 'ok' | ProviderErrorKind | 'hang' = 'ok';
  constructor(readonly name: string) {}
  supports() {
    return true;
  }
  async chat(_r: ChatRequest, o?: { signal?: AbortSignal }): Promise<ChatResponse> {
    this.calls++;
    if (this.mode === 'hang') return new Promise(() => undefined);
    if (this.mode !== 'ok')
      throw new ProviderError(this.mode, `${this.name} ${this.mode}`, this.name, 500);
    void o;
    return {
      content: `from ${this.name}`,
      toolCalls: [],
      provider: this.name,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
    };
  }
}

function setup(now = { t: 0 }) {
  const reg = new ProviderRegistry();
  const a = new Scripted('a');
  const b = new Scripted('b');
  reg.register(a).register(b).register(new DevProvider());
  const router = new ModelRouter(reg, {
    routes: {},
    defaultChain: ['a', 'b', 'dev'],
    timeoutMs: 50,
    breaker: { failureThreshold: 2, openMs: 1000 },
    now: () => now.t,
  });
  return { reg, a, b, router, now };
}

describe('circuit breaker', () => {
  it('opens after N failures, allows one half-open trial after openMs, closes on success', () => {
    const now = { t: 0 };
    const br = new CircuitBreaker({ failureThreshold: 2, openMs: 100 }, () => now.t);
    expect(br.tryAcquire()).toBe(true);
    br.onFailure();
    expect(br.state).toBe('closed');
    br.onFailure();
    expect(br.state).toBe('open');
    expect(br.tryAcquire()).toBe(false);
    now.t = 150;
    expect(br.state).toBe('half_open');
    expect(br.tryAcquire()).toBe(true);
    expect(br.tryAcquire()).toBe(false); // only one trial in flight
    br.onFailure();
    expect(br.state).toBe('open');
    now.t = 400;
    expect(br.tryAcquire()).toBe(true);
    br.onSuccess();
    expect(br.state).toBe('closed');
  });
});

describe('model router', () => {
  it('uses the first healthy provider', async () => {
    const { router, b } = setup();
    const r = await router.chat(req);
    expect(r.provider).toBe('a');
    expect(r.result.content).toBe('from a');
    expect(b.calls).toBe(0);
  });

  it('falls back on provider errors and records every attempt', async () => {
    const { router, a } = setup();
    a.mode = 'unavailable';
    const r = await router.chat(req);
    expect(r.provider).toBe('b');
    expect(r.attempts.map((x) => `${x.provider}:${x.outcome}`)).toEqual(['a:error', 'b:ok']);
  });

  it('falls back on timeouts', async () => {
    const { router, a } = setup();
    a.mode = 'hang';
    const r = await router.chat(req);
    expect(r.provider).toBe('b');
    expect(r.attempts[0]).toMatchObject({ provider: 'a', outcome: 'error', errorKind: 'timeout' });
  });

  it('opens the breaker after repeated failures and skips the provider without calling it', async () => {
    const { router, a, now } = setup();
    a.mode = 'network';
    await router.chat(req);
    await router.chat(req);
    expect(router.breakerState('a')).toBe('open');
    const callsBefore = a.calls;
    const r = await router.chat(req);
    expect(a.calls).toBe(callsBefore);
    expect(r.attempts[0]).toMatchObject({ provider: 'a', outcome: 'skipped_open' });
    // recovery: after openMs one trial goes through and closes the circuit
    a.mode = 'ok';
    now.t += 2000;
    const t = await router.chat(req);
    expect(t.provider).toBe('a');
    expect(router.breakerState('a')).toBe('closed');
  });

  it('does not retry (or trip the breaker) on invalid requests', async () => {
    const { router, a, b } = setup();
    a.mode = 'invalid_request';
    await expect(router.chat(req)).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(b.calls).toBe(0);
    expect(router.breakerState('a')).toBe('closed');
  });

  it('fails with every attempt listed when nothing can serve the task', async () => {
    const { router, a, b, reg } = setup();
    reg.unregister('dev');
    a.mode = 'rate_limited';
    b.mode = 'auth';
    const err = await router.chat(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).attempts).toHaveLength(2);
  });

  it('routes per task and never invents providers', async () => {
    const { router } = setup();
    router.setRoute('translate', ['dev']);
    expect(router.chain('translate')).toEqual(['dev']);
    expect(router.chain('chat')).toEqual(['a', 'b', 'dev']);
    router.setRoute('classify', ['ghost']);
    await expect(
      router.chat({ task: 'classify', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('surfaces the provider message when only "unsupported" failures occurred (dev cannot translate)', async () => {
    const reg = new ProviderRegistry().register(new DevProvider());
    const router = new ModelRouter(reg, {
      routes: {},
      defaultChain: ['dev'],
      timeoutMs: 100,
      breaker: { failureThreshold: 2, openMs: 1000 },
    });
    await expect(
      router.chat({
        task: 'translate',
        messages: [{ role: 'user', content: 'x' }],
        input: { text: 'A long unknown sentence about parking.', targetLanguage: 'fr' },
      }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('routes embeddings to a provider that has them', async () => {
    const { router, a } = setup();
    void a;
    const r = await router.embed(['hello world']);
    expect(r.provider).toBe('dev');
    expect(r.result.vectors[0]).toHaveLength(64);
  });
});
