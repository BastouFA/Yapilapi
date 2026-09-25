/**
 * Search domain types shared by every backend and by the API module.
 *
 * Architecture rule (see docs/architecture/search.md): a SearchBackend is only a CANDIDATE GENERATOR. It returns
 * ranked ids. The API always re-checks every candidate against the authoritative Postgres visibility predicates
 * before anything is returned, so a stale or over-broad external index can never leak content.
 */

export const SEARCH_TYPES = [
  'people',
  'creators',
  'posts',
  'videos',
  'communities',
  'events',
  'places',
  'businesses',
  'products',
  'topics',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** Singular aliases accepted in the `types` query parameter. */
export const SEARCH_TYPE_ALIASES: Record<string, SearchType> = {
  person: 'people',
  user: 'people',
  users: 'people',
  profile: 'people',
  profiles: 'people',
  creator: 'creators',
  post: 'posts',
  video: 'videos',
  community: 'communities',
  group: 'communities',
  groups: 'communities',
  event: 'events',
  place: 'places',
  business: 'businesses',
  product: 'products',
  topic: 'topics',
};

export function parseSearchTypes(input: string | undefined): SearchType[] | null {
  if (!input) return null;
  const out = new Set<SearchType>();
  for (const raw of input.split(',')) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if ((SEARCH_TYPES as readonly string[]).includes(t)) out.add(t as SearchType);
    else if (SEARCH_TYPE_ALIASES[t]) out.add(SEARCH_TYPE_ALIASES[t]!);
    else return null;
  }
  return out.size ? [...out] : null;
}

export type PriceHint = 'cheap' | 'premium';

export interface TimeWindow {
  label:
    'tonight' | 'today' | 'tomorrow' | 'this weekend' | 'next weekend' | 'this week' | 'next week';
  from: Date;
  to: Date;
}

export interface GeoFilter {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface SearchRequest {
  /** Viewer id or null for anonymous. */
  viewerId: string | null;
  /** Free text. Sanitised by the backend; may be empty for "browse" style intents. */
  text: string;
  /** `all` = every term must match (plain keyword search); `any` = ranked OR (natural-language search). */
  match: 'all' | 'any';
  types: SearchType[];
  /** Number of candidates wanted PER type (the API asks for limit + 1 to detect a next page). */
  limit: number;
  /** Keyset position; only meaningful when exactly one type is requested. */
  cursor?: { score: number; id: string } | null;
  /** Fixed for a whole paginated session so time-decay terms are stable across pages. */
  snapshot: Date;
  /** Topic slugs that a result must be tagged with (or match textually). */
  topics?: string[];
  /** Topic slugs the viewer is interested in: a small ranking boost only, never a filter. */
  boostTopics?: string[];
  timeWindow?: { from: Date; to: Date } | null;
  near?: GeoFilter | null;
  placeKinds?: string[];
  partySize?: number | null;
  priceHint?: PriceHint | null;
}

export interface Candidate {
  id: string;
  score: number;
}

export type SearchCandidates = Partial<Record<SearchType, Candidate[]>>;

export interface SuggestRequest {
  viewerId: string | null;
  prefix: string;
  types: SearchType[];
  limit: number;
}

export interface SuggestCandidate extends Candidate {
  type: SearchType;
}

export interface SearchBackend {
  readonly name: 'postgres' | 'opensearch';
  search(req: SearchRequest): Promise<SearchCandidates>;
  suggest(req: SuggestRequest): Promise<SuggestCandidate[]>;
}

/** Minimal structural DB interface (matches `Queryable` from @yapilapi/database and `pg.Pool`). */
export interface SqlRunner {
  query<R = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/**
 * Authorisation predicate supplied by the application. Given the search type, a SQL expression for the viewer
 * (e.g. `$1::uuid`, may evaluate to NULL) and the alias of the primary table, it returns a boolean SQL fragment.
 * Required — a Postgres backend cannot be constructed without it, so visibility can not be forgotten.
 */
export type VisibilityGuard = (type: SearchType, viewer: string, alias: string) => string;
