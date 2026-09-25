import { randomBytes } from 'node:crypto';
import { Counter, Histogram } from 'prom-client';
import {
  AnthropicProvider,
  DevProvider,
  ModelRouter,
  OpenAiProvider,
  ProviderRegistry,
  type Attempt,
  type SpeechProvider,
  type TaskKind,
} from '@yapilapi/ai';
import type { AppContext } from '../../lib/context.js';

/**
 * Per-process AI runtime: the provider registry, the model router and metrics. Tests obtain it with `getAiRuntime(ctx)` and
 * register a controllable provider on `runtime.registry` (the external model is the only thing ever faked).
 */
export interface AiMetrics {
  requests: Counter<'provider' | 'task' | 'outcome'>;
  latency: Histogram<'provider' | 'task'>;
  tokens: Counter<'provider' | 'direction'>;
  cost: Counter<'provider'>;
  safety: Counter<'kind'>;
}

export interface AiRuntime {
  registry: ProviderRegistry;
  router: ModelRouter;
  metrics: AiMetrics;
  /** Random per-process token embedded in system prompts; seeing it in an output means the prompt leaked. */
  canary: string;
  speech: { provider: SpeechProvider | null };
}

const runtimes = new WeakMap<AppContext, AiRuntime>();

function metricsFor(ctx: AppContext): AiMetrics {
  const registers = [ctx.metrics.registry];
  const existing = <T>(name: string) => ctx.metrics.registry.getSingleMetric(name) as T | undefined;
  return {
    requests:
      existing<Counter<'provider' | 'task' | 'outcome'>>('yapilapi_ai_requests_total') ??
      new Counter({
        name: 'yapilapi_ai_requests_total',
        help: 'AI provider calls',
        labelNames: ['provider', 'task', 'outcome'],
        registers,
      }),
    latency:
      existing<Histogram<'provider' | 'task'>>('yapilapi_ai_latency_seconds') ??
      new Histogram({
        name: 'yapilapi_ai_latency_seconds',
        help: 'AI provider call latency',
        labelNames: ['provider', 'task'],
        buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 20],
        registers,
      }),
    tokens:
      existing<Counter<'provider' | 'direction'>>('yapilapi_ai_tokens_total') ??
      new Counter({
        name: 'yapilapi_ai_tokens_total',
        help: 'AI tokens',
        labelNames: ['provider', 'direction'],
        registers,
      }),
    cost:
      existing<Counter<'provider'>>('yapilapi_ai_cost_micros_total') ??
      new Counter({
        name: 'yapilapi_ai_cost_micros_total',
        help: 'Estimated AI cost in millionths of USD',
        labelNames: ['provider'],
        registers,
      }),
    safety:
      existing<Counter<'kind'>>('yapilapi_ai_safety_events_total') ??
      new Counter({
        name: 'yapilapi_ai_safety_events_total',
        help: 'AI safety events',
        labelNames: ['kind'],
        registers,
      }),
  };
}

export function buildRuntime(ctx: AppContext): AiRuntime {
  const c = ctx.config;
  const registry = new ProviderRegistry();
  registry.register(new DevProvider());
  if (c.ANTHROPIC_API_KEY)
    registry.register(
      new AnthropicProvider({
        apiKey: c.ANTHROPIC_API_KEY,
        model: c.ANTHROPIC_MODEL,
        baseUrl: c.ANTHROPIC_BASE_URL,
        timeoutMs: c.AI_REQUEST_TIMEOUT_MS,
      }),
    );
  if (c.OPENAI_API_KEY)
    registry.register(
      new OpenAiProvider({
        apiKey: c.OPENAI_API_KEY,
        model: c.OPENAI_MODEL,
        baseUrl: c.OPENAI_BASE_URL,
        timeoutMs: c.AI_REQUEST_TIMEOUT_MS,
      }),
    );

  // Fallback chain: the configured default first, then any other LIVE provider that has a key. The offline dev responder joins the
  // chain only when it is the default or the deployment is not production: a production outage must surface as 503, never as a
  // silent downgrade to a rule-based demo.
  const live = registry
    .list()
    .filter((p) => !p.isDev)
    .map((p) => p.name);
  const preferred = c.AI_DEFAULT_PROVIDER;
  const chain = [preferred, ...live.filter((n) => n !== preferred)];
  if (preferred !== 'dev' && !c.isProduction) chain.push('dev');
  const defaultChain = chain.filter((n) => registry.has(n));
  if (defaultChain.length === 0) defaultChain.push('dev'); // AI_DEFAULT_PROVIDER names a provider without a key: fall back to dev, labelled as such

  const metrics = metricsFor(ctx);
  const router = new ModelRouter(registry, {
    routes: {},
    defaultChain,
    timeoutMs: c.AI_REQUEST_TIMEOUT_MS,
    breaker: { failureThreshold: 3, openMs: 30_000 },
  });
  router.onAttempt = (a: Attempt & { task: TaskKind }) => {
    metrics.requests.inc({ provider: a.provider, task: a.task, outcome: a.outcome });
    if (a.outcome === 'ok' || a.outcome === 'error')
      metrics.latency.observe({ provider: a.provider, task: a.task }, a.latencyMs / 1000);
  };
  return {
    registry,
    router,
    metrics,
    canary: `CANARY-${randomBytes(9).toString('hex')}`,
    speech: { provider: null },
  };
}

export function getAiRuntime(ctx: AppContext): AiRuntime {
  let r = runtimes.get(ctx);
  if (!r) {
    r = buildRuntime(ctx);
    runtimes.set(ctx, r);
  }
  return r;
}
