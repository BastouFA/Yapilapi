import { describe, expect, it } from 'vitest';
import {
  PostgresSearchBackend,
  buildSearchQuery,
  buildSuggestQuery,
  escapeLike,
  sanitizeTerms,
} from './postgres.js';
import {
  SEARCH_TYPES,
  parseSearchTypes,
  type SearchRequest,
  type VisibilityGuard,
} from './types.js';
import { boundingBox, haversineKm } from './geo.js';

const guard: VisibilityGuard = (type, viewer, alias) =>
  `/*guard:${type}*/ (${alias} IS NOT NULL AND ${viewer} IS NOT DISTINCT FROM ${viewer})`;
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  viewerId: '00000000-0000-0000-0000-000000000001',
  text: 'jazz',
  match: 'all',
  types: ['events'],
  limit: 11,
  snapshot: new Date('2026-09-23T10:00:00Z'),
  ...over,
});

describe('postgres candidate queries', () => {
  it('always applies the visibility guard for every type', () => {
    for (const t of SEARCH_TYPES) {
      const q = buildSearchQuery(t, req(), guard);
      expect(q?.sql).toContain(`guard:${t}`);
    }
  });

  it('parameterises hostile text: it never appears in the SQL', () => {
    const evil = `'); DROP TABLE users; -- %_\\`;
    for (const t of SEARCH_TYPES) {
      const q = buildSearchQuery(
        t,
        req({ text: evil, topics: [evil], boostTopics: [evil], placeKinds: [evil] }),
        guard,
      )!;
      expect(q.sql).not.toContain('DROP');
      expect(q.sql).not.toContain(evil);
      expect(q.params.some((p) => typeof p === 'string' && p.includes('DROP'))).toBe(true);
    }
    const s = buildSuggestQuery(
      'people',
      { viewerId: null, prefix: evil, types: ['people'], limit: 5 },
      guard,
    )!;
    expect(s.sql).not.toContain('DROP');
  });

  it('uses websearch_to_tsquery (never to_tsquery on raw input)', () => {
    const q = buildSearchQuery('posts', req({ types: ['posts'], text: 'a & b | (c' }), guard)!;
    expect(q.sql).toContain('websearch_to_tsquery');
    expect(q.sql).not.toMatch(/[^_]to_tsquery/);
  });

  it('or-joins terms for natural-language matching', () => {
    const q = buildSearchQuery(
      'creators',
      req({ types: ['creators'], text: 'teach networking!', match: 'any' }),
      guard,
    )!;
    expect(q.params).toContain('teach or networking');
  });

  it('keyset cursor adds a row comparison', () => {
    const q = buildSearchQuery(
      'communities',
      req({ cursor: { score: 1.5, id: '00000000-0000-0000-0000-0000000000aa' } }),
      guard,
    )!;
    expect(q.sql).toContain('(t.score, t.id) <');
    expect(q.params).toContain(1.5);
    expect(buildSearchQuery('communities', req(), guard)!.sql).not.toContain('(t.score, t.id) <');
  });

  it('clamps limit', () => {
    const q = buildSearchQuery('places', req({ limit: 100000 }), guard)!;
    expect(q.params[q.params.length - 1]).toBe(100);
  });

  it('returns null for a topics-only request on a type without topics', () => {
    expect(buildSearchQuery('places', req({ text: '', topics: ['technology'] }), guard)).toBeNull();
    expect(
      buildSearchQuery('posts', req({ text: '', topics: ['technology'] }), guard),
    ).not.toBeNull();
  });

  it('applies intent filters', () => {
    const places = buildSearchQuery(
      'places',
      req({
        text: '',
        placeKinds: ['restaurant'],
        partySize: 6,
        near: { lat: 40, lng: -74, radiusKm: 10 },
      }),
      guard,
    )!;
    expect(places.sql).toContain('pl.kind = ANY(');
    expect(places.sql).toContain('pl.capacity >=');
    expect(places.sql).toContain('acos');
    expect(places.sql).toContain('BETWEEN');
    const events = buildSearchQuery(
      'events',
      req({
        text: '',
        timeWindow: {
          from: new Date('2026-09-25T18:00:00Z'),
          to: new Date('2026-09-28T00:00:00Z'),
        },
      }),
      guard,
    )!;
    expect(events.sql).toContain('e.starts_at <');
    const products = buildSearchQuery(
      'products',
      req({ types: ['products'], text: '', priceHint: 'cheap' }),
      guard,
    )!;
    expect(products.sql).toContain('price_cents');
  });

  it('suggest queries need a prefix and escape LIKE wildcards', () => {
    expect(
      buildSuggestQuery(
        'people',
        { viewerId: null, prefix: '  ', types: ['people'], limit: 5 },
        guard,
      ),
    ).toBeNull();
    expect(
      buildSuggestQuery(
        'posts',
        { viewerId: null, prefix: 'ab', types: ['posts'], limit: 5 },
        guard,
      ),
    ).toBeNull();
    const q = buildSuggestQuery(
      'communities',
      { viewerId: null, prefix: '50%_off', types: ['communities'], limit: 5 },
      guard,
    )!;
    expect(q.params).toContain('50\\%\\_off%');
  });

  it('backend refuses to be built without a guard', () => {
    expect(
      () =>
        new PostgresSearchBackend({
          db: { query: async () => ({ rows: [] }) },
          guard: undefined as never,
        }),
    ).toThrow(/guard/);
  });

  it('runs one query per type and maps rows', async () => {
    const seen: string[] = [];
    const db = {
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [{ id: 'x', score: '1.5' }] };
      },
    };
    const be = new PostgresSearchBackend({ db: db as never, guard });
    const res = await be.search(req({ types: ['events', 'places'] }));
    expect(seen).toHaveLength(2);
    expect(res.events).toEqual([{ id: 'x', score: 1.5 }]);
    expect(res.places).toEqual([{ id: 'x', score: 1.5 }]);
    const sug = await be.suggest({
      viewerId: null,
      prefix: 'ja',
      types: ['people', 'places'],
      limit: 5,
    });
    expect(sug.map((s) => s.type).sort()).toEqual(['people', 'places']);
  });
});

describe('helpers', () => {
  it('sanitises terms', () => {
    expect(sanitizeTerms(`Hello, "World" & (x) OR y-z`)).toEqual(['hello', 'world', 'x', 'y', 'z']);
    expect(sanitizeTerms('a '.repeat(40)).length).toBeLessThanOrEqual(8);
    expect(sanitizeTerms('!!!')).toEqual([]);
  });
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
  });
  it('parses the types parameter incl. singular aliases', () => {
    expect(parseSearchTypes('people,Community, video')).toEqual([
      'people',
      'communities',
      'videos',
    ]);
    expect(parseSearchTypes('nonsense')).toBeNull();
    expect(parseSearchTypes(undefined)).toBeNull();
  });
  it('haversine and bounding box', () => {
    expect(haversineKm(0, 0, 0, 0)).toBeCloseTo(0, 6);
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeGreaterThan(330);
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeLessThan(350);
    const bb = boundingBox(40, -74, 10)!;
    expect(bb.minLat).toBeLessThan(40);
    expect(bb.maxLng).toBeGreaterThan(-74);
    expect(boundingBox(89.9, 0, 50)).toBeNull();
    expect(boundingBox(0, 179.9, 50)).toBeNull();
  });
});
