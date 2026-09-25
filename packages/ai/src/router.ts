import {
  ProviderError,
  type CallOptions,
  type ChatRequest,
  type ChatResponse,
  type EmbedResponse,
  type ModelProvider,
  type TaskKind,
} from './types.js';

/** Registry of providers by name. Tests register controllable providers here: the external model is the only thing ever faked. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  register(p: ModelProvider): this {
    this.providers.set(p.name, p);
    return this;
  }
  unregister(name: string): void {
    this.providers.delete(name);
  }
  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }
  has(name: string): boolean {
    return this.providers.has(name);
  }
  list(): ModelProvider[] {
    return [...this.providers.values()];
  }
}

export interface BreakerConfig {
  /** Consecutive health-relevant failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial request is allowed. */
  openMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Per-provider circuit breaker: closed -> (N consecutive failures) -> open -> (after openMs) -> half-open trial -> closed | open. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  constructor(
    private readonly cfg: BreakerConfig,
    private readonly now: () => number,
  ) {}

  get state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.cfg.openMs ? 'half_open' : 'open';
  }

  /** May a request go out right now? In half-open exactly one trial is allowed at a time. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'open') return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.trialInFlight = false;
    this.failures += 1;
    if (this.openedAt !== null || this.failures >= this.cfg.failureThreshold)
      this.openedAt = this.now();
  }

  /** A request that ended without telling us anything about health (e.g. invalid input): release a half-open trial slot. */
  release(): void {
    this.trialInFlight = false;
  }
}

export interface RouterConfig {
  /** Per-task provider order. Missing tasks use `defaultChain`. */
  routes: Partial<Record<TaskKind, string[]>>;
  defaultChain: string[];
  timeoutMs: number;
  breaker: BreakerConfig;
  now?: () => number;
}

export interface Attempt {
  provider: string;
  outcome: 'ok' | 'error' | 'skipped_open' | 'skipped_unsupported';
  errorKind?: ProviderError['kind'];
  latencyMs: number;
}

export interface Routed<T> {
  result: T;
  provider: string;
  attempts: Attempt[];
}

export class AllProvidersFailedError extends Error {
  constructor(
    readonly task: TaskKind,
    readonly attempts: Attempt[],
    readonly lastError: ProviderError | null,
  ) {
    super(
      `No provider could serve the ${task} task (${attempts.map((a) => `${a.provider}:${a.outcome}${a.errorKind ? `/${a.errorKind}` : ''}`).join(', ') || 'none configured'})`,
    );
    this.name = 'AllProvidersFailedError';
  }
}

/**
 * Model Router: per-task routing, fallback chain on provider errors/timeouts, and a circuit breaker per provider.
 * It knows nothing about users, budgets or permissions (those wrap it in the API layer) and it never invents a provider:
 * `dev` is only used when it is in the chain.
 */
export class ModelRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly now: () => number;
  onAttempt?: (a: Attempt & { task: TaskKind }) => void;

  constructor(
    readonly registry: ProviderRegistry,
    readonly config: RouterConfig,
  ) {
    this.now = config.now ?? Date.now;
  }

  setRoute(task: TaskKind, chain: string[] | undefined): void {
    if (chain) this.config.routes[task] = chain;
    else delete this.config.routes[task];
  }

  /** The providers that would be tried for a task, in order (unknown names dropped). */
  chain(task: TaskKind): string[] {
    const names = this.config.routes[task] ?? this.config.defaultChain;
    return [...new Set(names)].filter((n) => this.registry.has(n));
  }

  breaker(name: string): CircuitBreaker {
    let b = this.breakers.get(name);
    if (!b) {
      b = new CircuitBreaker(this.config.breaker, this.now);
      this.breakers.set(name, b);
    }
    return b;
  }

  breakerState(name: string): BreakerState {
    return this.breaker(name).state;
  }

  chat(req: ChatRequest, opts: CallOptions = {}): Promise<Routed<ChatResponse>> {
    return this.run(req.task, (p, o) => p.chat(req, o), opts);
  }

  embed(texts: string[], opts: CallOptions = {}): Promise<Routed<EmbedResponse>> {
    return this.run(
      'embed',
      (p, o) =>
        p.embed
          ? p.embed(texts, o)
          : Promise.reject(new ProviderError('unsupported', `${p.name} has no embeddings`, p.name)),
      opts,
    );
  }

  private async run<T>(
    task: TaskKind,
    fn: (p: ModelProvider, o: CallOptions) => Promise<T>,
    opts: CallOptions,
  ): Promise<Routed<T>> {
    const attempts: Attempt[] = [];
    let lastError: ProviderError | null = null;
    for (const name of this.chain(task)) {
      const provider = this.registry.get(name)!;
      const started = this.now();
      const record = (a: Omit<Attempt, 'latencyMs'>) => {
        const full: Attempt = { ...a, latencyMs: this.now() - started };
        attempts.push(full);
        this.onAttempt?.({ ...full, task });
      };
      if (!provider.supports(task)) {
        record({ provider: name, outcome: 'skipped_unsupported' });
        continue;
      }
      const breaker = this.breaker(name);
      if (!breaker.tryAcquire()) {
        record({ provider: name, outcome: 'skipped_open' });
        continue;
      }
      try {
        const result = await this.withTimeout(provider, fn, opts);
        breaker.onSuccess();
        record({ provider: name, outcome: 'ok' });
        return { result, provider: name, attempts };
      } catch (err) {
        const pe =
          err instanceof ProviderError
            ? err
            : new ProviderError('network', `${name} failed: ${(err as Error).message}`, name);
        if (pe.countsAgainstBreaker) breaker.onFailure();
        else breaker.release();
        record({ provider: name, outcome: 'error', errorKind: pe.kind });
        lastError = pe;
        if (!pe.retryable) throw pe; // the request itself is bad: another provider would say the same
      }
    }
    // Only "unsupported" failures (e.g. the dev provider cannot translate this): surface the provider's own message.
    if (
      lastError &&
      lastError.kind === 'unsupported' &&
      attempts.every((a) => a.outcome !== 'error' || a.errorKind === 'unsupported')
    )
      throw lastError;
    throw new AllProvidersFailedError(task, attempts, lastError);
  }

  private async withTimeout<T>(
    provider: ModelProvider,
    fn: (p: ModelProvider, o: CallOptions) => Promise<T>,
    opts: CallOptions,
  ): Promise<T> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(
          new ProviderError(
            'timeout',
            `${provider.name} timed out after ${this.config.timeoutMs}ms`,
            provider.name,
          ),
        );
      }, this.config.timeoutMs);
    });
    try {
      return await Promise.race([fn(provider, { signal: ac.signal }), timeout]);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}
