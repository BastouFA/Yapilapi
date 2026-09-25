import { sanitizeTerms } from './postgres.js';
import type {
  Candidate,
  SearchBackend,
  SearchCandidates,
  SearchRequest,
  SearchType,
  SuggestCandidate,
  SuggestRequest,
} from './types.js';
import { SEARCH_TYPES } from './types.js';

/**
 * OpenSearch / Elasticsearch-compatible adapter (fetch based, no client dependency).
 *
 * STATUS: request construction is unit-tested; it has NOT been exercised against a live cluster in this
 * environment (none is available). Treat it as an integration adapter to validate in staging before enabling
 * SEARCH_BACKEND=opensearch. See docs/architecture/search.md.
 *
 * Security model: the index only carries searchable text and ranking signals; it deliberately holds NO audience,
 * privacy or membership data. It answers "which ids match, in what order". The API then re-validates every id
 * against the Postgres visibility predicates, so an over-broad or stale index can waste work but never leak.
 */

export interface OpenSearchOptions {
  /** e.g. https://search.internal:9200 . Credentials in the URL (https://user:pass@host) become a Basic auth header. */
  baseUrl: string;
  indexPrefix?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class SearchBackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SearchBackendError';
  }
}

/** Document shape stored in the index (one index per type). */
export interface SearchDocument {
  type: SearchType;
  id: string;
  title: string;
  body?: string;
  topics?: string[];
  kind?: string;
  popularity?: number;
  createdAt?: string;
  startsAt?: string;
  endsAt?: string;
  location?: { lat: number; lon: number };
  capacity?: number;
  priceCents?: number;
}

export const indexName = (prefix: string, type: SearchType) => `${prefix}-${type}`;

/** Index settings + mappings. `title` is search_as_you_type so typeahead needs no separate structure. */
export function indexMapping(): Record<string, unknown> {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
      analysis: { analyzer: { default: { type: 'standard' } } },
    },
    mappings: {
      dynamic: 'strict',
      properties: {
        type: { type: 'keyword' },
        id: { type: 'keyword' },
        title: { type: 'search_as_you_type' },
        body: { type: 'text' },
        topics: { type: 'keyword' },
        kind: { type: 'keyword' },
        popularity: { type: 'float' },
        createdAt: { type: 'date' },
        startsAt: { type: 'date' },
        endsAt: { type: 'date' },
        location: { type: 'geo_point' },
        capacity: { type: 'integer' },
        priceCents: { type: 'integer' },
      },
    },
  };
}

type Json = Record<string, unknown>;

/** Build the `_search` body for one type. Pure; unit-tested. */
export function buildSearchBody(type: SearchType, req: SearchRequest): Json {
  const terms = sanitizeTerms(req.text);
  const text = req.match === 'any' ? terms.join(' ') : req.text.trim().slice(0, 200);
  const filter: Json[] = [];
  const should: Json[] = [];
  const must: Json[] = [];

  if (text) {
    must.push({
      multi_match: {
        query: text,
        fields: ['title^3', 'title._2gram', 'title._3gram', 'body'],
        type: 'best_fields',
        operator: req.match === 'all' ? 'and' : 'or',
        fuzziness: 'AUTO',
        prefix_length: 1,
      },
    });
  }
  if (req.topics?.length) {
    // A topic can satisfy the query on its own (mirrors the Postgres backend: text OR topic).
    const t = { terms: { topics: req.topics, boost: 2 } };
    if (text) should.push(t);
    else filter.push({ terms: { topics: req.topics } });
  }
  if (req.boostTopics?.length) should.push({ terms: { topics: req.boostTopics, boost: 0.5 } });
  if (!must.length && !filter.length) must.push({ match_all: {} });

  if (type === 'events') {
    if (req.timeWindow) {
      filter.push({ range: { startsAt: { lt: req.timeWindow.to.toISOString() } } });
      filter.push({
        bool: {
          should: [
            { range: { endsAt: { gt: req.timeWindow.from.toISOString() } } },
            { bool: { must_not: { exists: { field: 'endsAt' } } } },
          ],
          minimum_should_match: 1,
        },
      });
    } else {
      filter.push({
        range: { startsAt: { gte: new Date(req.snapshot.getTime() - 3 * 3600_000).toISOString() } },
      });
    }
  }
  if (req.near && ['events', 'places', 'posts', 'videos', 'businesses'].includes(type)) {
    filter.push({
      geo_distance: {
        distance: `${req.near.radiusKm}km`,
        location: { lat: req.near.lat, lon: req.near.lng },
      },
    });
  }
  if (type === 'places') {
    if (req.placeKinds?.length) filter.push({ terms: { kind: req.placeKinds } });
    if (req.partySize)
      filter.push({
        bool: {
          should: [
            { bool: { must_not: { exists: { field: 'capacity' } } } },
            { range: { capacity: { gte: req.partySize } } },
          ],
          minimum_should_match: 1,
        },
      });
  }

  const functions: Json[] = [
    {
      field_value_factor: { field: 'popularity', modifier: 'log1p', missing: 0, factor: 1 },
      weight: 0.25,
    },
  ];
  if (type === 'events')
    functions.push({
      gauss: { startsAt: { origin: req.snapshot.toISOString(), scale: '3d', decay: 0.5 } },
      weight: 0.25,
    });
  else if (['posts', 'videos', 'communities', 'products', 'places', 'businesses'].includes(type)) {
    functions.push({
      gauss: {
        createdAt: {
          origin: req.snapshot.toISOString(),
          scale: type === 'posts' || type === 'videos' ? '3d' : '60d',
          decay: 0.5,
        },
      },
      weight: 0.25,
    });
  }
  if (type === 'products' && req.priceHint === 'cheap')
    functions.push({ gauss: { priceCents: { origin: 0, scale: 5000, decay: 0.5 } }, weight: 0.3 });

  const body: Json = {
    size: Math.min(Math.max(Math.trunc(req.limit), 1), 100),
    _source: false,
    track_total_hits: false,
    query: {
      function_score: {
        query: { bool: { must, filter, should } },
        functions,
        score_mode: 'sum',
        boost_mode: 'sum',
      },
    },
    sort: [{ _score: 'desc' }, { id: 'desc' }],
  };
  if (req.cursor) body.search_after = [req.cursor.score, req.cursor.id];
  return body;
}

export function buildSuggestBody(req: SuggestRequest): Json {
  return {
    size: Math.min(Math.max(Math.trunc(req.limit), 1), 20),
    _source: false,
    query: {
      multi_match: {
        query: req.prefix.trim().slice(0, 60),
        type: 'bool_prefix',
        fields: ['title', 'title._2gram', 'title._3gram'],
      },
    },
    sort: [{ _score: 'desc' }, { id: 'desc' }],
  };
}

export type BulkOp =
  { op: 'index'; doc: SearchDocument } | { op: 'delete'; type: SearchType; id: string };

/** NDJSON body for `POST /_bulk` (must end with a newline). */
export function buildBulkBody(prefix: string, ops: BulkOp[]): string {
  const lines: string[] = [];
  for (const o of ops) {
    if (o.op === 'index') {
      lines.push(
        JSON.stringify({ index: { _index: indexName(prefix, o.doc.type), _id: o.doc.id } }),
        JSON.stringify(o.doc),
      );
    } else {
      lines.push(JSON.stringify({ delete: { _index: indexName(prefix, o.type), _id: o.id } }));
    }
  }
  return `${lines.join('\n')}\n`;
}

interface Hit {
  _id: string;
  _score: number | null;
  sort?: unknown[];
}

function parseHits(json: unknown): Candidate[] {
  const hits = (json as { hits?: { hits?: Hit[] } })?.hits?.hits ?? [];
  return hits.map((h) => ({ id: String(h._id), score: Number(h.sort?.[0] ?? h._score ?? 0) }));
}

export class OpenSearchBackend implements SearchBackend {
  readonly name = 'opensearch' as const;
  private readonly base: string;
  private readonly prefix: string;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenSearchOptions) {
    const u = new URL(opts.baseUrl);
    this.headers = { accept: 'application/json' };
    if (u.username)
      this.headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
    else if (opts.apiKey) this.headers.authorization = `ApiKey ${opts.apiKey}`;
    u.username = '';
    u.password = '';
    this.base = u.toString().replace(/\/$/, '');
    this.prefix = opts.indexPrefix ?? 'yapilapi';
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  private async call(
    method: string,
    path: string,
    body?: string,
    contentType = 'application/json',
  ): Promise<unknown> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { ...this.headers, ...(body !== undefined ? { 'content-type': contentType } : {}) },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok)
      throw new SearchBackendError(
        `OpenSearch ${method} ${path} failed with ${res.status}`,
        res.status,
      );
    return json;
  }

  /** Create any missing indices. Idempotent. */
  async ensureIndices(): Promise<void> {
    for (const type of SEARCH_TYPES) {
      try {
        await this.call('PUT', `/${indexName(this.prefix, type)}`, JSON.stringify(indexMapping()));
      } catch (e) {
        if (!(e instanceof SearchBackendError && e.status === 400)) throw e; // 400 = resource_already_exists_exception
      }
    }
  }

  /** Bulk index/delete. Returns the number of per-item failures reported by the cluster. */
  async bulk(ops: BulkOp[]): Promise<{ failed: number }> {
    if (!ops.length) return { failed: 0 };
    const json = (await this.call(
      'POST',
      '/_bulk?refresh=false',
      buildBulkBody(this.prefix, ops),
      'application/x-ndjson',
    )) as { errors?: boolean; items?: Array<Record<string, { error?: unknown }>> };
    const failed = json?.errors
      ? (json.items ?? []).filter((i) => Object.values(i)[0]?.error).length
      : 0;
    return { failed };
  }

  async search(req: SearchRequest): Promise<SearchCandidates> {
    const out: SearchCandidates = {};
    await Promise.all(
      req.types.map(async (type) => {
        const json = await this.call(
          'POST',
          `/${indexName(this.prefix, type)}/_search`,
          JSON.stringify(buildSearchBody(type, req)),
        );
        out[type] = parseHits(json);
      }),
    );
    return out;
  }

  async suggest(req: SuggestRequest): Promise<SuggestCandidate[]> {
    const lists = await Promise.all(
      req.types.map(async (type) => {
        const json = await this.call(
          'POST',
          `/${indexName(this.prefix, type)}/_search`,
          JSON.stringify(buildSuggestBody(req)),
        );
        return parseHits(json).map((c): SuggestCandidate => ({ ...c, type }));
      }),
    );
    return lists.flat().sort((a, b) => b.score - a.score);
  }
}
