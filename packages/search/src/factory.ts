import { OpenSearchBackend } from './opensearch.js';
import { PostgresSearchBackend } from './postgres.js';
import type {
  SearchBackend,
  SearchCandidates,
  SearchRequest,
  SqlRunner,
  SuggestCandidate,
  SuggestRequest,
  VisibilityGuard,
} from './types.js';

/** Wraps a primary backend; if it throws (cluster down, timeout) the request is answered by the fallback. */
export class FallbackSearchBackend implements SearchBackend {
  constructor(
    private readonly primary: SearchBackend,
    private readonly fallback: SearchBackend,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  get name() {
    return this.primary.name;
  }

  async search(req: SearchRequest): Promise<SearchCandidates> {
    try {
      return await this.primary.search(req);
    } catch (e) {
      this.onError(e);
      return this.fallback.search(req);
    }
  }

  async suggest(req: SuggestRequest): Promise<SuggestCandidate[]> {
    try {
      return await this.primary.suggest(req);
    } catch (e) {
      this.onError(e);
      return this.fallback.suggest(req);
    }
  }
}

export interface SearchBackendConfig {
  SEARCH_BACKEND: 'postgres' | 'opensearch';
  OPENSEARCH_URL?: string | undefined;
}

/**
 * Select the backend from configuration (SEARCH_BACKEND). `opensearch` requires OPENSEARCH_URL and is always
 * wrapped with a Postgres fallback so an outage of the external cluster degrades search instead of breaking it.
 */
export function createSearchBackend(
  cfg: SearchBackendConfig,
  deps: { db: SqlRunner; guard: VisibilityGuard; onError?: (e: unknown) => void },
): SearchBackend {
  const pg = new PostgresSearchBackend({ db: deps.db, guard: deps.guard });
  if (cfg.SEARCH_BACKEND !== 'opensearch') return pg;
  if (!cfg.OPENSEARCH_URL) throw new Error('SEARCH_BACKEND=opensearch requires OPENSEARCH_URL');
  return new FallbackSearchBackend(
    new OpenSearchBackend({ baseUrl: cfg.OPENSEARCH_URL }),
    pg,
    deps.onError,
  );
}
