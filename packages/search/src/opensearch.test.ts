import { describe, expect, it } from 'vitest';
import { FallbackSearchBackend, createSearchBackend } from './factory.js';
import {
  OpenSearchBackend,
  SearchBackendError,
  buildBulkBody,
  buildSearchBody,
  buildSuggestBody,
  indexMapping,
  indexName,
  type SearchDocument,
} from './opensearch.js';
import type { SearchBackend, SearchRequest } from './types.js';

// These tests only cover REQUEST CONSTRUCTION and response parsing against a fake fetch. The adapter has not been
// run against a live OpenSearch cluster (see docs/architecture/search.md).

const snapshot = new Date('2026-09-23T10:00:00Z');
const base = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  viewerId: 'u1',
  text: 'jazz night',
  match: 'all',
  types: ['events'],
  limit: 11,
  snapshot,
  ...over,
});

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { body: {} };
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  }) as typeof fetch;
  return { f, calls };
}

describe('opensearch request construction', () => {
  it('builds a bool/multi_match search with paging via search_after', () => {
    const body = buildSearchBody(
      'communities',
      base({ text: 'tech hub', types: ['communities'], cursor: { score: 1.25, id: 'abc' } }),
    ) as any;
    expect(body.size).toBe(11);
    expect(body.search_after).toEqual([1.25, 'abc']);
    expect(body.sort).toEqual([{ _score: 'desc' }, { id: 'desc' }]);
    const mm = body.query.function_score.query.bool.must[0].multi_match;
    expect(mm).toMatchObject({ query: 'tech hub', operator: 'and', fuzziness: 'AUTO' });
    expect(body._source).toBe(false);
  });

  it('uses OR semantics for natural-language searches and sanitises terms', () => {
    const body = buildSearchBody(
      'events',
      base({ text: 'teach, networking!! or', match: 'any' }),
    ) as any;
    expect(body.query.function_score.query.bool.must[0].multi_match).toMatchObject({
      query: 'teach networking',
      operator: 'or',
    });
  });

  it('browse mode uses match_all', () => {
    const body = buildSearchBody('events', base({ text: '' })) as any;
    expect(body.query.function_score.query.bool.must).toEqual([{ match_all: {} }]);
  });

  it('adds event time-window, geo and place filters', () => {
    const from = new Date('2026-09-25T18:00:00Z');
    const to = new Date('2026-09-28T00:00:00Z');
    const ev = buildSearchBody(
      'events',
      base({ text: '', timeWindow: { from, to }, near: { lat: 1, lng: 2, radiusKm: 25 } }),
    ) as any;
    const filters = ev.query.function_score.query.bool.filter;
    expect(filters).toContainEqual({ range: { startsAt: { lt: to.toISOString() } } });
    expect(filters).toContainEqual({
      geo_distance: { distance: '25km', location: { lat: 1, lon: 2 } },
    });
    const pl = buildSearchBody(
      'places',
      base({ text: '', types: ['places'], placeKinds: ['restaurant'], partySize: 6 }),
    ) as any;
    const pf = pl.query.function_score.query.bool.filter;
    expect(pf).toContainEqual({ terms: { kind: ['restaurant'] } });
    expect(JSON.stringify(pf)).toContain('"capacity":{"gte":6}');
  });

  it('topics: filter when there is no text, boosting should-clause when there is', () => {
    const noText = buildSearchBody('posts', base({ text: '', topics: ['technology'] })) as any;
    expect(noText.query.function_score.query.bool.filter).toContainEqual({
      terms: { topics: ['technology'] },
    });
    const withText = buildSearchBody('posts', base({ text: 'ai', topics: ['technology'] })) as any;
    expect(withText.query.function_score.query.bool.should[0].terms.topics).toEqual(['technology']);
  });

  it('never puts audience/visibility data in the index mapping', () => {
    const m = JSON.stringify(indexMapping());
    for (const k of ['visibility', 'audience', 'author', 'email', 'members'])
      expect(m).not.toContain(k);
    expect((indexMapping() as any).mappings.dynamic).toBe('strict');
  });

  it('builds a bool_prefix suggest body and clamps the size', () => {
    const b = buildSuggestBody({
      viewerId: null,
      prefix: '  ja  ',
      types: ['people'],
      limit: 500,
    }) as any;
    expect(b.size).toBe(20);
    expect(b.query.multi_match).toMatchObject({ query: 'ja', type: 'bool_prefix' });
  });

  it('builds NDJSON for _bulk index and delete operations', () => {
    const doc: SearchDocument = { type: 'events', id: 'e1', title: 'Jazz', popularity: 3 };
    const body = buildBulkBody('yl', [
      { op: 'index', doc },
      { op: 'delete', type: 'places', id: 'p1' },
    ]);
    const lines = body.trimEnd().split('\n');
    expect(body.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({ index: { _index: 'yl-events', _id: 'e1' } });
    expect(JSON.parse(lines[1]!)).toEqual(doc);
    expect(JSON.parse(lines[2]!)).toEqual({ delete: { _index: 'yl-places', _id: 'p1' } });
    expect(indexName('yl', 'topics')).toBe('yl-topics');
  });
});

describe('opensearch backend over a fake transport', () => {
  it('searches each type index and parses hits (score from sort)', async () => {
    const { f, calls } = fakeFetch([
      {
        body: {
          hits: {
            hits: [
              { _id: 'a', _score: 2, sort: [2, 'a'] },
              { _id: 'b', _score: 1.5, sort: [1.5, 'b'] },
            ],
          },
        },
      },
    ]);
    const be = new OpenSearchBackend({
      baseUrl: 'https://user:p%40ss@search.internal:9200/',
      indexPrefix: 'yl',
      fetch: f,
    });
    const res = await be.search(base());
    expect(res.events).toEqual([
      { id: 'a', score: 2 },
      { id: 'b', score: 1.5 },
    ]);
    expect(calls[0]!.url).toBe('https://search.internal:9200/yl-events/_search');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('user:p@ss').toString('base64')}`,
    );
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('uses an API key when given and no URL credentials', async () => {
    const { f, calls } = fakeFetch([{ body: { hits: { hits: [] } } }]);
    await new OpenSearchBackend({ baseUrl: 'http://os:9200', apiKey: 'k', fetch: f }).search(
      base(),
    );
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('ApiKey k');
  });

  it('posts bulk operations as ndjson', async () => {
    const { f, calls } = fakeFetch([
      {
        body: {
          errors: true,
          items: [{ index: { status: 201 } }, { index: { error: { type: 'x' } } }],
        },
      },
    ]);
    const be = new OpenSearchBackend({ baseUrl: 'http://os:9200', fetch: f });
    const r = await be.bulk([
      { op: 'index', doc: { type: 'places', id: '1', title: 'A' } },
      { op: 'index', doc: { type: 'places', id: '2', title: 'B' } },
    ]);
    expect(r.failed).toBe(1);
    expect(calls[0]!.url).toBe('http://os:9200/_bulk?refresh=false');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-ndjson',
    );
    expect(await be.bulk([])).toEqual({ failed: 0 });
  });

  it('ensureIndices tolerates already-existing indices but not other failures', async () => {
    const ok = fakeFetch(
      Array.from({ length: 10 }, () => ({
        status: 400,
        body: { error: 'resource_already_exists_exception' },
      })),
    );
    await expect(
      new OpenSearchBackend({ baseUrl: 'http://os:9200', fetch: ok.f }).ensureIndices(),
    ).resolves.toBeUndefined();
    expect(ok.calls).toHaveLength(10);
    const bad = fakeFetch([{ status: 500, body: 'boom' }]);
    await expect(
      new OpenSearchBackend({ baseUrl: 'http://os:9200', fetch: bad.f }).ensureIndices(),
    ).rejects.toBeInstanceOf(SearchBackendError);
  });

  it('surfaces cluster errors and the factory falls back to Postgres', async () => {
    const { f } = fakeFetch([{ status: 503, body: 'down' }]);
    const failing = new OpenSearchBackend({ baseUrl: 'http://os:9200', fetch: f });
    await expect(failing.search(base())).rejects.toBeInstanceOf(SearchBackendError);

    const errors: unknown[] = [];
    const secondary: SearchBackend = {
      name: 'postgres',
      search: async () => ({ events: [{ id: 'pg', score: 1 }] }),
      suggest: async () => [],
    };
    const wrapped = new FallbackSearchBackend(
      new OpenSearchBackend({
        baseUrl: 'http://os:9200',
        fetch: fakeFetch([{ status: 503, body: '' }]).f,
      }),
      secondary,
      (e) => errors.push(e),
    );
    expect((await wrapped.search(base())).events).toEqual([{ id: 'pg', score: 1 }]);
    expect(errors).toHaveLength(1);
  });
});

describe('backend selection', () => {
  const deps = { db: { query: async () => ({ rows: [] }) }, guard: () => 'true' };
  it('defaults to postgres', () => {
    expect(createSearchBackend({ SEARCH_BACKEND: 'postgres' }, deps).name).toBe('postgres');
  });
  it('requires a URL for opensearch', () => {
    expect(() => createSearchBackend({ SEARCH_BACKEND: 'opensearch' }, deps)).toThrow(
      /OPENSEARCH_URL/,
    );
    expect(
      createSearchBackend({ SEARCH_BACKEND: 'opensearch', OPENSEARCH_URL: 'http://os:9200' }, deps)
        .name,
    ).toBe('opensearch');
  });
});
