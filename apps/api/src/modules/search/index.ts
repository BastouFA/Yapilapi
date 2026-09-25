import { z } from 'zod';
import { clampLimit, decodeCursor, encodeCursor, invalid } from '@yapilapi/shared';
import {
  SEARCH_TYPES,
  createSearchBackend,
  parseIntent,
  parseSearchTypes,
  isValidTimeZone,
  type Candidate,
  type ParsedIntent,
  type SearchBackend,
  type SearchRequest,
  type SearchType,
} from '@yapilapi/search';
import type { Queryable } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { searchGuard } from './guards.js';
import { hydrate, ordered, suggestionLabel, type GeoPoint, type ResultItem } from './views.js';

export { searchGuard } from './guards.js';

const HISTORY_MAX_PER_USER = 50;
const HISTORY_RETENTION_DAYS = 90;
const DEFAULT_TYPES: SearchType[] = [...SEARCH_TYPES];
const SUGGEST_TYPES: SearchType[] = [
  'people',
  'communities',
  'places',
  'topics',
  'events',
  'businesses',
];

const searchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  types: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(400).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).default(25),
  tz: z.string().max(64).optional(),
  interpret: z.enum(['auto', 'off']).default('auto'),
});

const suggestQuery = z.object({
  q: z.string().trim().min(1).max(60),
  types: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

type ScoreCursor = { s: number; id: string; snap: string };

// ------------------------------------------------------------------ shared helpers (also used by discover)
const backends = new WeakMap<AppContext, SearchBackend>();
/** The backend selected by SEARCH_BACKEND (postgres by default; opensearch falls back to postgres on errors). */
export function getSearchBackend(ctx: AppContext): SearchBackend {
  let b = backends.get(ctx);
  if (!b) {
    b = createSearchBackend(ctx.config, {
      db: ctx.db,
      guard: searchGuard,
      onError: (e) => ctx.log.warn({ err: e }, 'search backend failed, using postgres fallback'),
    });
    backends.set(ctx, b);
  }
  return b;
}

const topicVocab = new WeakMap<
  AppContext,
  { at: number; rows: Array<{ slug: string; name: string }> }
>();
async function topicVocabulary(ctx: AppContext) {
  const hit = topicVocab.get(ctx);
  if (hit && Date.now() - hit.at < 300_000) return hit.rows;
  const { rows } = await ctx.db.query<{ slug: string; name: string }>(
    'SELECT slug::text AS slug, name FROM topics',
  );
  topicVocab.set(ctx, { at: Date.now(), rows });
  return rows;
}

export const normalizeQuery = (q: string) =>
  q.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);

interface ViewerPrefs {
  personalization: boolean;
  timezone: string;
  ageBand: 'teen' | 'adult' | null;
  interests: string[];
}

async function viewerPrefs(
  ctx: AppContext,
  userId: string | null,
  wantInterests: boolean,
): Promise<ViewerPrefs> {
  if (!userId) return { personalization: false, timezone: 'UTC', ageBand: null, interests: [] };
  const { rows } = await ctx.db.query<{
    personalization: boolean | null;
    timezone: string;
    age_band: 'teen' | 'adult';
  }>(
    `SELECT up.personalization, u.timezone, u.age_band FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  const personalization = r?.personalization ?? true;
  let interests: string[] = [];
  if (personalization && wantInterests) {
    const i = await ctx.db.query<{ slug: string }>(
      `SELECT t.slug::text AS slug FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1 LIMIT 30`,
      [userId],
    );
    interests = i.rows.map((x) => x.slug);
  }
  return {
    personalization,
    timezone: r?.timezone ?? 'UTC',
    ageBand: r?.age_band ?? null,
    interests,
  };
}

export async function recordSearch(db: Queryable, userId: string, query: string): Promise<void> {
  const normalized = normalizeQuery(query);
  if (normalized.length < 2) return;
  await db.query(
    `INSERT INTO search_history (user_id, normalized_query, query) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, normalized_query) DO UPDATE SET search_count = search_history.search_count + 1, last_searched_at = now(), query = EXCLUDED.query`,
    [userId, normalized, query.trim().slice(0, 200)],
  );
  await db.query(
    `DELETE FROM search_history WHERE user_id = $1 AND (
       last_searched_at < now() - ($2::int || ' days')::interval
       OR normalized_query NOT IN (SELECT normalized_query FROM search_history WHERE user_id = $1 ORDER BY last_searched_at DESC LIMIT $3))`,
    [userId, HISTORY_RETENTION_DAYS, HISTORY_MAX_PER_USER],
  );
}

/** Retention job entry point: purge every user's history older than the retention window. */
export async function purgeExpiredSearchHistory(db: Queryable): Promise<number> {
  const r = await db.query(
    `DELETE FROM search_history WHERE last_searched_at < now() - ($1::int || ' days')::interval`,
    [HISTORY_RETENTION_DAYS],
  );
  return r.rowCount ?? 0;
}

function describeIntent(
  i: ParsedIntent,
  searched: SearchType[],
  extra: { needsLocation: boolean; fellBack: boolean; overridden: boolean },
) {
  return {
    mode: i.mode,
    explanation: extra.fellBack
      ? 'No matches for the interpreted search, so we searched for exactly what you typed'
      : i.explanation,
    entityTypes: searched,
    keywords: i.keywords,
    topics: i.topics,
    timeWindow: i.timeWindow
      ? {
          label: i.timeWindow.label,
          from: i.timeWindow.from.toISOString(),
          to: i.timeWindow.to.toISOString(),
        }
      : null,
    partySize: i.partySize,
    nearMe: i.nearMe,
    priceHint: i.priceHint,
    placeKinds: i.placeKinds,
    typesOverridden: extra.overridden,
    ...(extra.needsLocation ? { needsLocation: true } : {}),
    ...(extra.fellBack ? { fellBack: true } : {}),
  };
}

export const searchModule: ApiModule = {
  name: 'search',
  register(app, ctx) {
    const backend = getSearchBackend(ctx);

    route(app, ctx, {
      method: 'GET',
      url: '/v1/search',
      summary: 'Universal search with natural-language understanding',
      tags: ['search'],
      auth: 'optional',
      query: searchQuery,
      rateLimit: { limit: 90, windowSec: 60, by: 'user' },
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        if ((query.lat === undefined) !== (query.lng === undefined))
          throw invalid('Provide both lat and lng');
        const explicit = query.types ? parseSearchTypes(query.types) : null;
        if (query.types && !explicit)
          throw invalid(`types must be a comma separated list of: ${SEARCH_TYPES.join(', ')}`);
        const cur = decodeCursor<ScoreCursor>(query.cursor);
        if (
          cur &&
          (typeof cur.s !== 'number' ||
            typeof cur.id !== 'string' ||
            typeof cur.snap !== 'string' ||
            Number.isNaN(Date.parse(cur.snap)) ||
            !z.uuid().safeParse(cur.id).success)
        )
          throw invalid('Invalid cursor');

        const prefs = await viewerPrefs(ctx, viewer, true);
        const tz = query.tz && isValidTimeZone(query.tz) ? query.tz : prefs.timezone;
        const snapshot = cur ? new Date(cur.snap) : new Date();
        const intent: ParsedIntent =
          query.interpret === 'off'
            ? parseIntent('', { now: snapshot, timeZone: tz })
            : parseIntent(query.q, {
                now: snapshot,
                timeZone: tz,
                topics: await topicVocabulary(ctx),
              });
        const raw = query.interpret === 'off';

        // Which types: explicit `types` wins; otherwise what the sentence is about; otherwise everything.
        let types: SearchType[] =
          explicit ?? (intent.entityTypes.length ? intent.entityTypes : DEFAULT_TYPES);
        if (
          types.includes('products') &&
          !(await ctx.flags.isEnabled('COMMERCE', viewer ?? undefined))
        ) {
          types = types.filter((t) => t !== 'products');
          if (!types.length) await ctx.flags.require('COMMERCE', viewer ?? undefined);
        }
        if (cur && types.length !== 1)
          throw invalid(
            'A cursor can only be used when searching exactly one type (pass types=...)',
          );
        const single = types.length === 1;
        const limit = clampLimit(query.limit ?? (single ? 20 : 5));

        const geo: GeoPoint | undefined =
          query.lat !== undefined && query.lng !== undefined
            ? { lat: query.lat, lng: query.lng }
            : undefined;
        const needsLocation = intent.nearMe && !geo;
        const text = raw ? query.q : intent.keywords.join(' ');
        const match: SearchRequest['match'] = intent.mode === 'natural_language' ? 'any' : 'all';

        const run = async (over: Partial<SearchRequest>, typeList: SearchType[]) => {
          const req: SearchRequest = {
            viewerId: viewer,
            text,
            match,
            types: typeList,
            limit: limit + 1,
            cursor: cur ? { score: cur.s, id: cur.id } : null,
            snapshot,
            topics: intent.topics,
            boostTopics: prefs.interests,
            timeWindow: intent.timeWindow,
            near: intent.nearMe && geo ? { ...geo, radiusKm: query.radiusKm } : null,
            placeKinds: intent.placeKinds,
            partySize: intent.partySize,
            priceHint: intent.priceHint,
            ...over,
          };
          const found = await backend.search(req);
          const groups: Partial<
            Record<SearchType, { items: ResultItem[]; nextCursor: string | null }>
          > = {};
          // "people" and "creators" overlap; in a multi-type search a creator is shown once, under creators.
          const creatorIds = new Set((found.creators ?? []).map((c) => c.id));
          for (const t of typeList) {
            let cands: Candidate[] = found[t] ?? [];
            if (t === 'people' && !single && typeList.includes('creators'))
              cands = cands.filter((c) => !creatorIds.has(c.id));
            const hasMore = cands.length > limit;
            const page = cands.slice(0, limit);
            const items = ordered(
              page,
              await hydrate(
                ctx,
                viewer,
                t,
                page.map((c) => c.id),
                geo,
              ),
            );
            const last = page[page.length - 1];
            groups[t] = {
              items: items.map((i) => ({ ...i.item, relevance: i.score })),
              nextCursor:
                hasMore && last
                  ? encodeCursor({ s: last.score, id: last.id, snap: snapshot.toISOString() })
                  : null,
            };
          }
          return groups;
        };

        let groups = await run({}, types);
        let total = Object.values(groups).reduce((n, g) => n + (g?.items.length ?? 0), 0);
        let fellBack = false;
        // The interpretation was too narrow (e.g. a person named "Grant Events"): retry as a plain keyword search.
        if (total === 0 && !cur && !raw && intent.mode === 'natural_language') {
          const plain =
            explicit ?? DEFAULT_TYPES.filter((t) => t !== 'products' || types.includes('products'));
          groups = await run(
            {
              text: query.q,
              match: 'all',
              topics: [],
              timeWindow: null,
              near: null,
              placeKinds: [],
              partySize: null,
              priceHint: null,
            },
            plain,
          );
          total = Object.values(groups).reduce((n, g) => n + (g?.items.length ?? 0), 0);
          fellBack = true;
          types = plain;
        }

        if (viewer && prefs.personalization && prefs.ageBand === 'adult' && !cur) {
          await recordSearch(ctx.db, viewer, query.q).catch((e) =>
            ctx.log.warn({ err: e }, 'search history write failed'),
          );
        }
        ctx.metrics.events.inc({ name: 'search' });
        return {
          query: query.q,
          interpretedAs: describeIntent(intent, types, {
            needsLocation,
            fellBack,
            overridden: Boolean(explicit),
          }),
          types,
          total,
          results: groups,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/search/suggest',
      summary: 'Typeahead suggestions',
      tags: ['search'],
      auth: 'optional',
      query: suggestQuery,
      rateLimit: { limit: 240, windowSec: 60, by: 'user' },
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const explicit = query.types ? parseSearchTypes(query.types) : null;
        if (query.types && !explicit)
          throw invalid(`types must be a comma separated list of: ${SEARCH_TYPES.join(', ')}`);
        const types = (explicit ?? SUGGEST_TYPES).filter((t) => t !== 'posts' && t !== 'videos');
        const limit = query.limit ?? 8;
        const cands = (
          await backend.suggest({ viewerId: viewer, prefix: query.q, types, limit: limit + 2 })
        ).slice(0, limit * 2);
        const byType = new Map<SearchType, string[]>();
        for (const c of cands) byType.set(c.type, [...(byType.get(c.type) ?? []), c.id]);
        const hydrated = new Map<SearchType, Map<string, ResultItem>>();
        for (const [t, ids] of byType) hydrated.set(t, await hydrate(ctx, viewer, t, ids));
        const items: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const c of cands) {
          const item = hydrated.get(c.type)?.get(c.id);
          if (!item) continue;
          const key = `${c.type === 'creators' ? 'people' : c.type}:${c.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ type: c.type, id: c.id, ...suggestionLabel(c.type, item), score: c.score });
          if (items.length >= limit) break;
        }
        // Recent searches that continue what is being typed (only for people who keep personalization on).
        let recent: string[] = [];
        if (viewer) {
          const prefs = await viewerPrefs(ctx, viewer, false);
          if (prefs.personalization) {
            const r = await ctx.db.query<{ query: string }>(
              `SELECT query FROM search_history WHERE user_id = $1 AND normalized_query LIKE $2 ESCAPE '\\' ORDER BY last_searched_at DESC LIMIT 3`,
              [viewer, `${normalizeQuery(query.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
            );
            recent = r.rows.map((x) => x.query);
          }
        }
        return { query: query.q, items, recent };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/search/history',
      summary: 'Your recent searches',
      tags: ['search'],
      auth: 'user',
      rateLimit: { limit: 60, windowSec: 60, by: 'user' },
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT query, search_count, last_searched_at FROM search_history WHERE user_id = $1 AND last_searched_at >= now() - ($2::int || ' days')::interval ORDER BY last_searched_at DESC LIMIT 20`,
          [auth.userId, HISTORY_RETENTION_DAYS],
        );
        const prefs = await viewerPrefs(ctx, auth.userId, false);
        return {
          recording: prefs.personalization && prefs.ageBand === 'adult',
          items: rows.map((r) => ({
            query: r.query,
            searchCount: r.search_count,
            lastSearchedAt: (r.last_searched_at as Date).toISOString(),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/search/history',
      summary: 'Clear your search history (or one entry with ?q=)',
      tags: ['search'],
      auth: 'user',
      query: z.object({ q: z.string().trim().min(1).max(200).optional() }),
      rateLimit: { limit: 30, windowSec: 60, by: 'user' },
      handler: async ({ auth, req, query }) => {
        const r = query.q
          ? await ctx.db.query(
              'DELETE FROM search_history WHERE user_id = $1 AND normalized_query = $2',
              [auth.userId, normalizeQuery(query.q)],
            )
          : await ctx.db.query('DELETE FROM search_history WHERE user_id = $1', [auth.userId]);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'search.history_cleared',
            targetType: 'user',
            targetId: auth.userId,
            metadata: { scope: query.q ? 'entry' : 'all', removed: r.rowCount ?? 0 },
          },
          req,
        );
        return undefined;
      },
    });
  },
};
