import {
  estimateCostMicros,
  estimateTokens,
  type ChatRequest,
  type ChatResponse,
  type TaskKind,
} from '@yapilapi/ai';
import { AppError } from '@yapilapi/shared';
import { AllProvidersFailedError, ProviderError } from '@yapilapi/ai';
import type { AppContext } from '../../lib/context.js';
import type { AiRuntime } from './runtime.js';
import { AiUnavailableError } from './errors.js';

const today = () => new Date().toISOString().slice(0, 10);
const tomorrowIso = () =>
  new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1),
  ).toISOString();

export interface UsageSummary {
  day: string;
  user: {
    tokensUsed: number;
    tokenLimit: number;
    tokensRemaining: number;
    requests: number;
    costMicros: number;
  };
  translations: { used: number; limit: number };
  resetsAt: string;
}

export async function usageSummary(ctx: AppContext, userId: string): Promise<UsageSummary> {
  const { rows } = await ctx.db.query<{
    task: string;
    requests: number;
    tokens_in: number;
    tokens_out: number;
    cost_micros: number;
  }>(
    'SELECT task, requests, tokens_in, tokens_out, cost_micros FROM ai_usage WHERE user_id = $1 AND day = $2',
    [userId, today()],
  );
  const used = rows.reduce((n, r) => n + Number(r.tokens_in) + Number(r.tokens_out), 0);
  const limit = ctx.config.AI_USER_DAILY_TOKENS;
  return {
    day: today(),
    user: {
      tokensUsed: used,
      tokenLimit: limit,
      tokensRemaining: Math.max(0, limit - used),
      requests: rows.reduce((n, r) => n + r.requests, 0),
      costMicros: rows.reduce((n, r) => n + Number(r.cost_micros), 0),
    },
    translations: {
      used: rows.find((r) => r.task === 'translate')?.requests ?? 0,
      limit: ctx.config.AI_TRANSLATIONS_PER_DAY,
    },
    resetsAt: tomorrowIso(),
  };
}

/** Persisted, per-user and global daily token budgets. Checked BEFORE a provider is called. */
export async function assertBudget(ctx: AppContext, userId: string): Promise<void> {
  const u = await ctx.db.query<{ n: string }>(
    'SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n FROM ai_usage WHERE user_id = $1 AND day = $2',
    [userId, today()],
  );
  if (Number(u.rows[0]!.n) >= ctx.config.AI_USER_DAILY_TOKENS) {
    ctx.metrics.events.inc({ name: 'ai_quota_user' });
    throw new AppError(
      'rate_limited',
      'You have used your AI allowance for today. It resets at midnight UTC.',
      { reason: 'ai_user_daily_budget', resetsAt: tomorrowIso() },
    );
  }
  const g = await ctx.db.query<{ n: string }>(
    'SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n FROM ai_usage_global WHERE day = $1',
    [today()],
  );
  if (Number(g.rows[0]!.n) >= ctx.config.AI_GLOBAL_DAILY_TOKENS) {
    ctx.metrics.events.inc({ name: 'ai_quota_global' });
    throw new AppError('rate_limited', 'AI is at capacity right now. Please try again later.', {
      reason: 'ai_global_daily_budget',
      resetsAt: tomorrowIso(),
    });
  }
}

/** Atomically count one translation against the user's daily quota; throws 429 when it is used up. */
export async function reserveTranslation(ctx: AppContext, userId: string): Promise<void> {
  const { rows } = await ctx.db.query<{ requests: number }>(
    `INSERT INTO ai_usage (user_id, day, task, requests) VALUES ($1,$2,'translate',1)
     ON CONFLICT (user_id, day, task) DO UPDATE SET requests = ai_usage.requests + 1, updated_at = now() RETURNING requests`,
    [userId, today()],
  );
  if (rows[0]!.requests > ctx.config.AI_TRANSLATIONS_PER_DAY) {
    await ctx.db.query(
      `UPDATE ai_usage SET requests = requests - 1 WHERE user_id = $1 AND day = $2 AND task = 'translate'`,
      [userId, today()],
    );
    throw new AppError(
      'rate_limited',
      'You have reached your daily translation limit. Cached translations are still free.',
      {
        reason: 'ai_translation_quota',
        limit: ctx.config.AI_TRANSLATIONS_PER_DAY,
        resetsAt: tomorrowIso(),
      },
    );
  }
}

/** Give back a reserved translation when the model call produced nothing (a failed attempt should not cost the user quota). */
export async function releaseTranslation(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db.query(
    `UPDATE ai_usage SET requests = GREATEST(requests - 1, 0) WHERE user_id = $1 AND day = $2 AND task = 'translate'`,
    [userId, today()],
  );
}

async function recordSuccess(
  ctx: AppContext,
  userId: string | null,
  task: TaskKind,
  r:
    | ChatResponse
    | { provider: string; model: string; usage: { inputTokens: number; outputTokens: number } },
  latencyMs: number,
  countRequest: boolean,
): Promise<void> {
  const cost = estimateCostMicros(r.provider, r.model, r.usage);
  if (userId) {
    await ctx.db.query(
      `INSERT INTO ai_usage (user_id, day, task, requests, tokens_in, tokens_out, cost_micros) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, day, task) DO UPDATE SET requests = ai_usage.requests + $4, tokens_in = ai_usage.tokens_in + $5, tokens_out = ai_usage.tokens_out + $6, cost_micros = ai_usage.cost_micros + $7, updated_at = now()`,
      [
        userId,
        today(),
        task,
        countRequest ? 1 : 0,
        r.usage.inputTokens,
        r.usage.outputTokens,
        cost,
      ],
    );
  }
  await ctx.db.query(
    `INSERT INTO ai_usage_global (day, task, provider, requests, tokens_in, tokens_out, cost_micros, latency_ms_total) VALUES ($1,$2,$3,1,$4,$5,$6,$7)
     ON CONFLICT (day, task, provider) DO UPDATE SET requests = ai_usage_global.requests + 1, tokens_in = ai_usage_global.tokens_in + $4, tokens_out = ai_usage_global.tokens_out + $5, cost_micros = ai_usage_global.cost_micros + $6, latency_ms_total = ai_usage_global.latency_ms_total + $7`,
    [
      today(),
      task,
      r.provider,
      r.usage.inputTokens,
      r.usage.outputTokens,
      cost,
      Math.round(latencyMs),
    ],
  );
}

async function recordFailure(ctx: AppContext, task: TaskKind, provider: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO ai_usage_global (day, task, provider, requests, failures) VALUES ($1,$2,$3,0,1)
     ON CONFLICT (day, task, provider) DO UPDATE SET failures = ai_usage_global.failures + 1`,
    [today(), task, provider],
  );
}

export interface ModelCallResult {
  response: ChatResponse;
  attempts: Array<{ provider: string; outcome: string; errorKind?: string | undefined }>;
}

/**
 * The Model Router seen from the API: budget check -> routed call (fallback + breaker) -> persisted usage, cost and latency metrics.
 * `userId` null = system call (no per-user budget). Errors: 429 quota, 422 provider cannot do this (dev translation), 503 nothing available.
 */
export async function callModel(
  ctx: AppContext,
  runtime: AiRuntime,
  userId: string | null,
  req: ChatRequest,
  opts: { countRequest?: boolean } = {},
): Promise<ModelCallResult> {
  if (userId) await assertBudget(ctx, userId);
  const started = Date.now();
  try {
    const routed = await runtime.router.chat(req);
    const latency = Date.now() - started;
    const r = routed.result;
    runtime.metrics.tokens.inc({ provider: r.provider, direction: 'input' }, r.usage.inputTokens);
    runtime.metrics.tokens.inc({ provider: r.provider, direction: 'output' }, r.usage.outputTokens);
    runtime.metrics.cost.inc(
      { provider: r.provider },
      estimateCostMicros(r.provider, r.model, r.usage),
    );
    // Providers that fail to report usage still consume budget: fall back to our estimate.
    const usage =
      r.usage.inputTokens + r.usage.outputTokens > 0
        ? r.usage
        : {
            inputTokens: estimateTokens(req.messages.map((m) => m.content).join('\n')),
            outputTokens: estimateTokens(r.content),
          };
    await recordSuccess(ctx, userId, req.task, { ...r, usage }, latency, opts.countRequest ?? true);
    for (const a of routed.attempts)
      if (a.outcome === 'error') await recordFailure(ctx, req.task, a.provider);
    return {
      response: { ...r, usage },
      attempts: routed.attempts.map((a) => ({
        provider: a.provider,
        outcome: a.outcome,
        errorKind: a.errorKind,
      })),
    };
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      for (const a of err.attempts)
        if (a.outcome === 'error') await recordFailure(ctx, req.task, a.provider);
      ctx.log.warn({ attempts: err.attempts, task: req.task }, 'all AI providers failed');
      throw new AiUnavailableError();
    }
    if (err instanceof ProviderError) {
      if (err.kind === 'unsupported')
        throw new AppError('unprocessable', err.message, { reason: 'provider_unsupported' });
      if (err.kind === 'invalid_request')
        throw new AppError('unprocessable', 'The AI provider rejected this request', {
          reason: 'provider_rejected',
        });
      throw new AiUnavailableError();
    }
    throw err;
  }
}
