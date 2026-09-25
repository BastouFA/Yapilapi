import { boundingBox, haversineSql } from './geo.js';
import type {
  Candidate,
  SearchBackend,
  SearchCandidates,
  SearchRequest,
  SearchType,
  SqlRunner,
  SuggestCandidate,
  SuggestRequest,
  VisibilityGuard,
} from './types.js';

/**
 * PostgresSearchBackend: candidate generation straight from the generated `search_tsv` columns and the pg_trgm
 * indexes created in migrations 001-004 and 140.
 *
 *   score = ts_rank_cd(search_tsv, query, 32)        full-text relevance, normalised to 0..1
 *         + 0.9  * similarity(name, text)            typo tolerance / partial names (pg_trgm)
 *         + 0.30 (contains) / +0.20 (prefix)         substring bonus so "tech" finds "Technology Hub"
 *         + 0.5  topic match, +0.15 viewer-interest boost
 *         + 0.25 * popularity   (log scaled, 0..1)
 *         + 0.25 * recency      (exponential half-life; events use time-until-start)
 *         + distance / price hint bonuses
 *
 * Every user supplied value travels as a bind parameter. The only interpolated text is SQL that this file
 * owns (table/column names, constants). Text is fed to `websearch_to_tsquery`, which never raises a syntax error.
 */

export interface PostgresSearchOptions {
  db: SqlRunner;
  /** Authorisation predicate (required). Applied inside every candidate query. */
  guard: VisibilityGuard;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** Escape LIKE/ILIKE metacharacters (we use the default backslash escape). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Split free text into safe terms (letters/digits only). Used for the OR-style tsquery and prefix matching. */
export function sanitizeTerms(text: string, max = 8): string[] {
  const terms = text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && t.length <= 40 && t !== 'or' && t !== 'and');
  return [...new Set(terms)].slice(0, max);
}

interface TypeSpec {
  from: string;
  alias: string;
  id: string;
  /** Lifecycle filters that are not authorisation (soft delete, status). */
  lifecycle: (p: Params, req: Pick<SearchRequest, 'snapshot'>) => string[];
  tsv: string;
  names: string[];
  pop: string;
  ts: string | null;
  halfLifeHours: number;
  /** Extra text-independent filters derived from intent (time window, geo, kinds, party size). */
  filters?: (p: Params, req: SearchRequest) => string[];
  /** Extra score terms (distance, price hint). */
  bonus?: (p: Params, req: SearchRequest) => string[];
  topics?: (p: Params, topicsParam: string) => string;
}

const topicExists =
  (table: string, fk: string, idExpr: string) => (_p: Params, topicsParam: string) =>
    `EXISTS (SELECT 1 FROM ${table} xt JOIN topics tt ON tt.id = xt.topic_id WHERE xt.${fk} = ${idExpr} AND tt.slug = ANY(${topicsParam}::citext[]))`;

function geoFilter(
  p: Params,
  latCol: string,
  lngCol: string,
  near: NonNullable<SearchRequest['near']>,
): string {
  const lat = p.add(near.lat);
  const lng = p.add(near.lng);
  const r = p.add(near.radiusKm);
  const bb = boundingBox(near.lat, near.lng, near.radiusKm);
  const parts = [`${latCol} IS NOT NULL`];
  if (bb)
    parts.push(
      `${latCol} BETWEEN ${p.add(bb.minLat)} AND ${p.add(bb.maxLat)}`,
      `${lngCol} BETWEEN ${p.add(bb.minLng)} AND ${p.add(bb.maxLng)}`,
    );
  parts.push(`${haversineSql(`${lat}::float8`, `${lng}::float8`, latCol, lngCol)} <= ${r}::float8`);
  return parts.join(' AND ');
}

const distanceBonus = (
  p: Params,
  near: NonNullable<SearchRequest['near']>,
  latCol: string,
  lngCol: string,
) =>
  `0.4 * GREATEST(0, 1 - ${haversineSql(`${p.add(near.lat)}::float8`, `${p.add(near.lng)}::float8`, latCol, lngCol)} / ${p.add(near.radiusKm)}::float8)`;

const EVENT_END = `COALESCE(e.ends_at, e.starts_at + interval '3 hours')`;
const EVENT_LAT = 'COALESCE(e.latitude, pl.latitude)';
const EVENT_LNG = 'COALESCE(e.longitude, pl.longitude)';

const SPECS: Record<SearchType, TypeSpec> = {
  people: {
    from: 'profiles pr',
    alias: 'pr',
    id: 'pr.user_id',
    lifecycle: () => [],
    tsv: 'pr.search_tsv',
    names: ['pr.display_name', 'pr.username::text'],
    pop: 'pr.follower_count',
    ts: null,
    halfLifeHours: 1,
  },
  creators: {
    from: 'profiles pr',
    alias: 'pr',
    id: 'pr.user_id',
    lifecycle: () => [`pr.mode = 'creator'`],
    tsv: 'pr.search_tsv',
    names: ['pr.display_name', 'pr.username::text'],
    pop: 'pr.follower_count',
    ts: null,
    halfLifeHours: 1,
  },
  posts: {
    from: 'posts p',
    alias: 'p',
    id: 'p.id',
    lifecycle: () => [`p.kind <> 'video'`],
    tsv: 'p.search_tsv',
    names: [],
    pop: 'p.like_count + 2 * p.comment_count + 3 * p.share_count + 2 * p.save_count',
    ts: 'p.created_at',
    halfLifeHours: 72,
    filters: (p, req) => (req.near ? [geoFilter(p, 'p.latitude', 'p.longitude', req.near)] : []),
    topics: topicExists('post_topics', 'post_id', 'p.id'),
  },
  videos: {
    from: 'posts p',
    alias: 'p',
    id: 'p.id',
    lifecycle: () => [`p.kind = 'video'`],
    tsv: 'p.search_tsv',
    names: [],
    pop: 'p.like_count + 2 * p.comment_count + 3 * p.share_count + 2 * p.save_count + p.view_count / 20.0',
    ts: 'p.created_at',
    halfLifeHours: 96,
    filters: (p, req) => (req.near ? [geoFilter(p, 'p.latitude', 'p.longitude', req.near)] : []),
    topics: topicExists('post_topics', 'post_id', 'p.id'),
  },
  communities: {
    from: 'communities c',
    alias: 'c',
    id: 'c.id',
    lifecycle: () => ['c.deleted_at IS NULL'],
    tsv: 'c.search_tsv',
    names: ['c.name'],
    pop: 'c.member_count',
    ts: 'c.created_at',
    halfLifeHours: 24 * 90,
    topics: topicExists('community_topics', 'community_id', 'c.id'),
  },
  events: {
    from: 'events e LEFT JOIN places pl ON pl.id = e.place_id',
    alias: 'e',
    id: 'e.id',
    lifecycle: (p, req) => [
      'e.deleted_at IS NULL',
      `e.status = 'published'`,
      `${EVENT_END} > ${p.add(req.snapshot.toISOString())}::timestamptz`,
    ],
    tsv: 'e.search_tsv',
    names: ['e.title'],
    pop: 'e.going_count + 0.5 * e.interested_count',
    ts: null,
    halfLifeHours: 72,
    filters: (p, req) => {
      const f: string[] = [];
      if (req.timeWindow)
        f.push(
          `e.starts_at < ${p.add(req.timeWindow.to.toISOString())}::timestamptz`,
          `${EVENT_END} > ${p.add(req.timeWindow.from.toISOString())}::timestamptz`,
        );
      if (req.near) f.push(geoFilter(p, EVENT_LAT, EVENT_LNG, req.near));
      return f;
    },
    topics: topicExists('event_topics', 'event_id', 'e.id'),
    bonus: (p, req) => [
      // Sooner is better; events already under way count as "now".
      `0.25 * power(0.5::numeric, GREATEST(0, EXTRACT(EPOCH FROM (e.starts_at - ${p.add(req.snapshot.toISOString())}::timestamptz)) / 3600.0)::numeric / 72.0)`,
      ...(req.near ? [distanceBonus(p, req.near, EVENT_LAT, EVENT_LNG)] : []),
    ],
  },
  places: {
    from: 'places pl',
    alias: 'pl',
    id: 'pl.id',
    lifecycle: () => ['pl.deleted_at IS NULL'],
    tsv: 'pl.search_tsv',
    names: ['pl.name'],
    pop: 'pl.rating_count + 2 * pl.rating_avg',
    ts: 'pl.created_at',
    halfLifeHours: 24 * 365,
    filters: (p, req) => {
      const f: string[] = [];
      if (req.placeKinds?.length) f.push(`pl.kind = ANY(${p.add(req.placeKinds)}::text[])`);
      if (req.partySize)
        f.push(`(pl.capacity IS NULL OR pl.capacity >= ${p.add(req.partySize)}::int)`);
      if (req.near) f.push(geoFilter(p, 'pl.latitude', 'pl.longitude', req.near));
      return f;
    },
    bonus: (p, req) =>
      req.near ? [distanceBonus(p, req.near, 'pl.latitude', 'pl.longitude')] : [],
  },
  businesses: {
    from: 'businesses b',
    alias: 'b',
    id: 'b.id',
    lifecycle: () => ['b.deleted_at IS NULL', `b.status = 'active'`],
    tsv: 'b.search_tsv',
    names: ['b.name'],
    pop: `CASE WHEN b.verified_at IS NOT NULL THEN 20 ELSE 0 END`,
    ts: 'b.created_at',
    halfLifeHours: 24 * 180,
    filters: (p, req) =>
      req.near
        ? [
            `EXISTS (SELECT 1 FROM places bp WHERE bp.business_id = b.id AND bp.deleted_at IS NULL AND ${geoFilter(p, 'bp.latitude', 'bp.longitude', req.near)})`,
          ]
        : [],
  },
  products: {
    from: 'products pd',
    alias: 'pd',
    id: 'pd.id',
    lifecycle: () => ['pd.deleted_at IS NULL', `pd.status = 'active'`],
    tsv: 'pd.search_tsv',
    names: ['pd.title'],
    pop: 'pd.rating_count + 2 * pd.rating_avg',
    ts: 'pd.created_at',
    halfLifeHours: 24 * 60,
    bonus: (_p, req) =>
      req.priceHint === 'cheap'
        ? ['0.3 / (1 + pd.price_cents / 5000.0)']
        : req.priceHint === 'premium'
          ? ['0.3 * pd.price_cents / (pd.price_cents + 5000.0)']
          : [],
  },
  topics: {
    from: 'topics tp',
    alias: 'tp',
    id: 'tp.id',
    lifecycle: () => [],
    tsv: `to_tsvector('simple', tp.name || ' ' || replace(tp.slug::text, '-', ' '))`,
    names: ['tp.name', 'tp.slug::text'],
    pop: '(SELECT count(*) FROM post_topics ptc WHERE ptc.topic_id = tp.id)',
    ts: null,
    halfLifeHours: 1,
  },
};

const MIN_LIKE_LEN = 2;

/** Apply the guard and make sure the viewer bind parameter is always referenced (Postgres cannot type an unused $1). */
function guardFor(guard: VisibilityGuard, type: SearchType, viewer: string, alias: string): string {
  const g = guard(type, viewer, alias);
  return g.includes(viewer) ? g : `(${g} AND (${viewer} IS NULL OR TRUE))`;
}

/** Build the candidate query for one type. Exported for unit tests (parameterisation, shape). */
export function buildSearchQuery(
  type: SearchType,
  req: SearchRequest,
  guard: VisibilityGuard,
): BuiltQuery | null {
  const spec = SPECS[type];
  const p = new Params();
  const viewer = `${p.add(req.viewerId)}::uuid`;
  const text = req.text.trim().slice(0, 200);
  const terms = sanitizeTerms(text);
  const hasText = terms.length > 0 || (text.length > 0 && req.match === 'all');
  const topics = req.topics?.length ? req.topics.slice(0, 10) : [];

  const where: string[] = [...spec.lifecycle(p, req), guardFor(guard, type, viewer, spec.alias)];

  const topicCond = spec.topics && topics.length ? spec.topics(p, p.add(topics)) : null;
  const score: string[] = [];

  if (hasText) {
    const tsText = req.match === 'any' ? terms.join(' or ') : text;
    const tsq = `websearch_to_tsquery('simple', ${p.add(tsText)}::text)`;
    const conds = [`${spec.tsv} @@ ${tsq}`];
    score.push(`ts_rank_cd(${spec.tsv}, ${tsq}, 32)`);
    if (spec.names.length) {
      const raw = p.add(terms.join(' ') || text);
      const sims = spec.names.map((n) => `similarity(${n}, ${raw}::text)`);
      for (const n of spec.names) conds.push(`${n} % ${raw}::text`);
      score.push(`0.9 * GREATEST(${sims.join(', ')}, 0)`);
      const needle = terms.join(' ') || text;
      if (needle.length >= MIN_LIKE_LEN) {
        const contains = p.add(`%${escapeLike(needle)}%`);
        const prefix = p.add(`${escapeLike(needle)}%`);
        for (const n of spec.names) conds.push(`${n} ILIKE ${contains}`);
        score.push(
          `(CASE WHEN ${spec.names.map((n) => `${n} ILIKE ${contains}`).join(' OR ')} THEN 0.3 ELSE 0 END)`,
        );
        score.push(
          `(CASE WHEN ${spec.names.map((n) => `${n} ILIKE ${prefix}`).join(' OR ')} THEN 0.2 ELSE 0 END)`,
        );
      }
    }
    if (topicCond) conds.push(topicCond);
    where.push(`(${conds.join(' OR ')})`);
  } else if (topics.length) {
    if (!topicCond) return null; // topics requested but this type has no topics and there is no text to match
    where.push(topicCond);
    score.push('0.3');
  } else {
    score.push('0.3'); // browse mode: popularity and recency order the results
  }
  if (topicCond) score.push(`(CASE WHEN ${topicCond} THEN 0.5 ELSE 0 END)`);
  if (spec.topics && req.boostTopics?.length)
    score.push(
      `(CASE WHEN ${spec.topics(p, p.add(req.boostTopics.slice(0, 30)))} THEN 0.15 ELSE 0 END)`,
    );

  score.push(`0.25 * LEAST(1, ln(1 + GREATEST((${spec.pop})::numeric, 0)) / 8.0)`);
  if (spec.ts) {
    score.push(
      `0.25 * power(0.5::numeric, GREATEST(0, EXTRACT(EPOCH FROM (${p.add(req.snapshot.toISOString())}::timestamptz - ${spec.ts})) / 3600.0)::numeric / ${spec.halfLifeHours}::numeric)`,
    );
  }
  where.push(...(spec.filters?.(p, req) ?? []));
  score.push(...(spec.bonus?.(p, req) ?? []));

  let cursorSql = '';
  if (req.cursor)
    cursorSql = `WHERE (t.score, t.id) < (${p.add(req.cursor.score)}::float8, ${p.add(req.cursor.id)}::uuid)`;
  const limit = p.add(Math.min(Math.max(Math.trunc(req.limit), 1), 100));

  const sql = `SELECT t.id, t.score FROM (
    SELECT ${spec.id} AS id, round((${score.join(' + ')})::numeric, 6)::float8 AS score
      FROM ${spec.from}
     WHERE ${where.join('\n       AND ')}
  ) t ${cursorSql}
  ORDER BY t.score DESC, t.id DESC LIMIT ${limit}`;
  return { sql, params: p.values };
}

/** Typeahead: prefix / word-prefix matches first, then fuzzy. Same guards as full search. */
export function buildSuggestQuery(
  type: SearchType,
  req: SuggestRequest,
  guard: VisibilityGuard,
  snapshot = new Date(),
): BuiltQuery | null {
  const spec = SPECS[type];
  if (!spec.names.length) return null;
  const needle = req.prefix.trim().toLowerCase().slice(0, 60);
  if (!needle) return null;
  const p = new Params();
  const viewer = `${p.add(req.viewerId)}::uuid`;
  const where = [...spec.lifecycle(p, { snapshot }), guardFor(guard, type, viewer, spec.alias)];
  const esc = escapeLike(needle);
  const prefix = p.add(`${esc}%`);
  const word = p.add(`% ${esc}%`);
  const raw = p.add(needle);
  const conds = spec.names.flatMap((n) => [`${n} ILIKE ${prefix}`, `${n} ILIKE ${word}`]);
  if (needle.length >= 3) for (const n of spec.names) conds.push(`${n} % ${raw}::text`);
  where.push(`(${conds.join(' OR ')})`);
  const starts = spec.names.map((n) => `${n} ILIKE ${prefix}`).join(' OR ');
  const wordStarts = spec.names.map((n) => `${n} ILIKE ${word}`).join(' OR ');
  const sims = spec.names.map((n) => `similarity(${n}, ${raw}::text)`).join(', ');
  const score = `round((CASE WHEN ${starts} THEN 1.0 WHEN ${wordStarts} THEN 0.7 ELSE 0 END + 0.3 * GREATEST(${sims}, 0) + 0.1 * LEAST(1, ln(1 + GREATEST((${spec.pop})::numeric, 0)) / 8.0))::numeric, 6)::float8`;
  const limit = p.add(Math.min(Math.max(Math.trunc(req.limit), 1), 20));
  const sql = `SELECT ${spec.id} AS id, ${score} AS score FROM ${spec.from} WHERE ${where.join(' AND ')} ORDER BY score DESC, ${spec.id} DESC LIMIT ${limit}`;
  return { sql, params: p.values };
}

export class PostgresSearchBackend implements SearchBackend {
  readonly name = 'postgres' as const;
  private readonly db: SqlRunner;
  private readonly guard: VisibilityGuard;

  constructor(opts: PostgresSearchOptions) {
    if (typeof opts.guard !== 'function')
      throw new Error('PostgresSearchBackend requires a visibility guard');
    this.db = opts.db;
    this.guard = opts.guard;
  }

  async search(req: SearchRequest): Promise<SearchCandidates> {
    const out: SearchCandidates = {};
    await Promise.all(
      req.types.map(async (type) => {
        const q = buildSearchQuery(type, req, this.guard);
        if (!q) {
          out[type] = [];
          return;
        }
        const { rows } = await this.db.query<Candidate>(q.sql, q.params);
        out[type] = rows.map((r) => ({ id: r.id, score: Number(r.score) }));
      }),
    );
    return out;
  }

  async suggest(req: SuggestRequest): Promise<SuggestCandidate[]> {
    const snapshot = new Date();
    const lists = await Promise.all(
      req.types.map(async (type): Promise<SuggestCandidate[]> => {
        const q = buildSuggestQuery(type, req, this.guard, snapshot);
        if (!q) return [];
        const { rows } = await this.db.query<Candidate>(q.sql, q.params);
        return rows.map((r) => ({ type, id: r.id, score: Number(r.score) }));
      }),
    );
    return lists.flat().sort((a, b) => b.score - a.score);
  }
}
