import { z } from 'zod';
import { clampLimit, decodeCursor, encodeCursor, invalid } from '@yapilapi/shared';
import { isValidTimeZone, resolveTimeWindow, type TimeWindow } from '@yapilapi/search';
import { route } from '../../lib/route.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { readScoreCursor } from './sql.js';
import {
  K_ANONYMITY,
  discoverBusinesses,
  discoverCommunities,
  discoverCreators,
  discoverEvents,
  discoverLive,
  discoverPlaces,
  discoverProducts,
  discoverTopics,
  localPosts,
  nowSnapshot,
  suggestByInterests,
  suggestPeople,
  trendingPosts,
  trendingTopics,
  viewerSignals,
  type Geo,
} from './queries.js';

const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const geoQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).default(25),
});
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9-]+$/);

const WINDOWS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 } as const;
const WHEN = {
  today: 'today',
  tonight: 'tonight',
  tomorrow: 'tomorrow',
  this_weekend: 'this weekend',
  next_weekend: 'next weekend',
  this_week: 'this week',
  next_week: 'next week',
} as const;
const PLACE_KINDS = ['restaurant', 'store', 'venue', 'attraction', 'service'] as const;
const PRODUCT_KINDS = ['physical', 'service', 'digital', 'ticket', 'booking'] as const;

function geoOf(
  q: { lat?: number | undefined; lng?: number | undefined; radiusKm: number },
  required = false,
): Geo | null {
  if ((q.lat === undefined) !== (q.lng === undefined)) throw invalid('Provide both lat and lng');
  if (q.lat === undefined || q.lng === undefined) {
    if (required) throw invalid('lat and lng are required');
    return null;
  }
  return { lat: q.lat, lng: q.lng, radiusKm: q.radiusKm };
}

function readTimeCursor(raw: string | undefined): { t: string; id: string } | null {
  const c = decodeCursor<{ t: string; id: string }>(raw);
  if (!c) return null;
  if (
    typeof c.t !== 'string' ||
    Number.isNaN(Date.parse(c.t)) ||
    typeof c.id !== 'string' ||
    !z.uuid().safeParse(c.id).success
  )
    throw invalid('Invalid cursor');
  return c;
}

const READ = { limit: 120, windowSec: 60, by: 'user' } as const;

export const discoverModule: ApiModule = {
  name: 'discover',
  register(app, ctx: AppContext) {
    // ------------------------------------------------------------------ trending
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/trending',
      summary: 'Trending topics and posts (public content, by engagement velocity)',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery.extend({ window: z.enum(['1h', '6h', '24h', '7d']).default('24h') }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const cur = readScoreCursor(query.cursor);
        const snapshot = cur ? new Date(cur.snap) : new Date();
        const hours = WINDOWS[query.window];
        const [posts, topics] = await Promise.all([
          trendingPosts(ctx, viewer, hours, snapshot, cur, clampLimit(query.limit)),
          cur ? Promise.resolve([]) : trendingTopics(ctx, viewer, hours, snapshot, 10),
        ]);
        return { window: query.window, topics, items: posts.items, nextCursor: posts.nextCursor };
      },
    });

    // ------------------------------------------------------------------ people
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/people',
      summary: 'People you may know, each with an explanation',
      tags: ['discover'],
      auth: 'user',
      query: pageQuery,
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const cur = readScoreCursor(query.cursor);
        const snapshot = cur ? new Date(cur.snap) : new Date();
        const limit = clampLimit(query.limit);
        const sig = await viewerSignals(ctx, auth.userId);
        // People who turned personalization off get generic, non-behavioural suggestions.
        if (sig.personalization) {
          const graph = await suggestPeople(ctx, auth.userId, sig, cur, limit, snapshot);
          if (graph.items.length || cur) return { source: 'graph', ...graph };
        }
        const cold = await suggestByInterests(
          ctx,
          auth.userId,
          sig.interests.map((i) => i.slug),
          sig.ageBand === 'teen',
          limit,
        );
        return {
          source: sig.interests.length ? 'interests' : 'popular',
          items: cold,
          nextCursor: null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/suggested-follows',
      summary:
        'Onboarding: accounts to follow, from chosen topics (works before interests are saved)',
      tags: ['discover'],
      auth: 'user',
      query: z.object({
        topics: z.string().max(600).optional(),
        limit: z.coerce.number().int().min(1).max(30).default(12),
      }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const sig = await viewerSignals(ctx, auth.userId);
        let slugs: string[];
        if (query.topics) {
          const parsed = [
            ...new Set(
              query.topics
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean),
            ),
          ].slice(0, 12);
          if (parsed.some((s) => !slug.safeParse(s).success))
            throw invalid('topics must be a comma separated list of topic slugs');
          const known = await ctx.db.query<{ slug: string }>(
            'SELECT slug::text AS slug FROM topics WHERE slug = ANY($1::citext[])',
            [parsed],
          );
          slugs = known.rows.map((r) => r.slug);
        } else slugs = sig.interests.map((i) => i.slug);
        const items = await suggestByInterests(
          ctx,
          auth.userId,
          slugs,
          sig.ageBand === 'teen',
          query.limit,
        );
        return { basedOn: slugs, source: slugs.length ? 'interests' : 'popular', items };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/creators',
      summary: 'Creators worth following',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery.extend({ topic: slug.optional() }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const cur = readScoreCursor(query.cursor);
        const sig = await viewerSignals(ctx, viewer);
        return discoverCreators(
          ctx,
          viewer,
          sig,
          query.topic ?? null,
          cur,
          clampLimit(query.limit),
          cur ? new Date(cur.snap) : new Date(),
        );
      },
    });

    // ------------------------------------------------------------------ communities & topics
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/communities',
      summary: 'Public communities matched to your interests, with reasons',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery.extend({ topic: slug.optional() }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const cur = readScoreCursor(query.cursor);
        const sig = await viewerSignals(ctx, viewer);
        return discoverCommunities(
          ctx,
          viewer,
          sig,
          query.topic ?? null,
          cur,
          clampLimit(query.limit),
          cur ? new Date(cur.snap) : new Date(),
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/topics',
      summary: 'Topics to explore (ones you do not follow first)',
      tags: ['discover'],
      auth: 'optional',
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        return discoverTopics(ctx, viewer, await viewerSignals(ctx, viewer), query.limit);
      },
    });

    // ------------------------------------------------------------------ places & events
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/places',
      summary: 'Places nearby (haversine) or top rated',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery.extend(geoQuery.shape).extend({ kind: z.enum(PLACE_KINDS).optional() }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const cur = readScoreCursor(query.cursor);
        return discoverPlaces(ctx, auth?.userId ?? null, {
          geo: geoOf(query),
          kind: query.kind ?? null,
          cursor: cur,
          limit: clampLimit(query.limit),
          snapshot: cur ? new Date(cur.snap) : new Date(),
        });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/events',
      summary: 'Upcoming events you may see, optionally nearby or in a time window',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery.extend(geoQuery.shape).extend({
        when: z
          .enum(Object.keys(WHEN) as [keyof typeof WHEN, ...Array<keyof typeof WHEN>])
          .optional(),
        tz: z.string().max(64).optional(),
      }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        let window: TimeWindow | null = null;
        if (query.when) {
          const sig = await viewerSignals(ctx, viewer);
          window = resolveTimeWindow(
            WHEN[query.when],
            new Date(),
            query.tz && isValidTimeZone(query.tz) ? query.tz : sig.timezone,
          );
        }
        const r = await discoverEvents(ctx, viewer, {
          geo: geoOf(query),
          window,
          cursor: readTimeCursor(query.cursor),
          limit: clampLimit(query.limit),
          snapshot: new Date(),
        });
        return {
          items: r.items,
          nextCursor: r.nextCursor ? encodeCursor(r.nextCursor) : null,
          ...(window
            ? {
                window: {
                  label: window.label,
                  from: window.from.toISOString(),
                  to: window.to.toISOString(),
                },
              }
            : {}),
        };
      },
    });

    // ------------------------------------------------------------------ commerce
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/products',
      summary: 'Products from visible sellers',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery.extend({
        kind: z.enum(PRODUCT_KINDS).optional(),
        maxPriceCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
      }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        await ctx.flags.require('COMMERCE', auth?.userId);
        const cur = readScoreCursor(query.cursor);
        return discoverProducts(ctx, auth?.userId ?? null, {
          kind: query.kind ?? null,
          maxPriceCents: query.maxPriceCents ?? null,
          cursor: cur,
          limit: clampLimit(query.limit),
          snapshot: cur ? new Date(cur.snap) : new Date(),
        });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/businesses',
      summary: 'Businesses (optionally with a place nearby)',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery
        .extend(geoQuery.shape)
        .extend({ category: z.string().trim().min(1).max(60).optional() }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const cur = readScoreCursor(query.cursor);
        return discoverBusinesses(ctx, auth?.userId ?? null, {
          geo: geoOf(query),
          category: query.category ?? null,
          cursor: cur,
          limit: clampLimit(query.limit),
          snapshot: cur ? new Date(cur.snap) : new Date(),
        });
      },
    });

    // ------------------------------------------------------------------ live (feature flag LIVE)
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/live',
      summary: 'Live sessions you may watch right now',
      tags: ['discover'],
      auth: 'optional',
      query: pageQuery,
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        await ctx.flags.require('LIVE', auth?.userId);
        const r = await discoverLive(ctx, auth?.userId ?? null, {
          cursor: readTimeCursor(query.cursor),
          limit: clampLimit(query.limit),
        });
        return { items: r.items, nextCursor: r.nextCursor ? encodeCursor(r.nextCursor) : null };
      },
    });

    // ------------------------------------------------------------------ local
    route(app, ctx, {
      method: 'GET',
      url: '/v1/discover/local',
      summary: 'What is around a location: places, events, public posts, businesses',
      tags: ['discover'],
      auth: 'optional',
      query: geoQuery.extend({ limit: z.coerce.number().int().min(1).max(10).default(6) }),
      rateLimit: READ,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const geo = geoOf(query, true)!;
        const snapshot = new Date();
        const [places, events, posts, businesses] = await Promise.all([
          discoverPlaces(ctx, viewer, {
            geo,
            kind: null,
            cursor: null,
            limit: query.limit,
            snapshot,
          }),
          discoverEvents(ctx, viewer, {
            geo,
            window: null,
            cursor: null,
            limit: query.limit,
            snapshot,
          }),
          localPosts(ctx, viewer, geo, query.limit, snapshot),
          discoverBusinesses(ctx, viewer, {
            geo,
            category: null,
            cursor: null,
            limit: query.limit,
            snapshot,
          }),
        ]);
        return {
          radiusKm: geo.radiusKm,
          places: places.items,
          events: events.items,
          posts,
          businesses: businesses.items,
        };
      },
    });

    // ------------------------------------------------------------------ NOW (feature flag NOW)
    route(app, ctx, {
      method: 'GET',
      url: '/v1/now',
      summary: 'NOW: what is happening around you right now (aggregate and public only)',
      tags: ['now'],
      auth: 'user',
      query: geoQuery.extend({ limit: z.coerce.number().int().min(1).max(10).default(6) }),
      rateLimit: { limit: 60, windowSec: 60, by: 'user' },
      handler: async ({ auth, query }) => {
        await ctx.flags.require('NOW', auth.userId);
        const geo = geoOf(query);
        const snapshot = new Date();
        const liveOn = await ctx.flags.isEnabled('LIVE', auth.userId);
        const [snap, live] = await Promise.all([
          nowSnapshot(ctx, auth.userId, geo, snapshot, query.limit),
          liveOn
            ? discoverLive(ctx, auth.userId, { cursor: null, limit: query.limit })
            : Promise.resolve(null),
        ]);
        // Nothing about the caller's location is stored or echoed back; counts are only shown for groups of at least K people.
        return {
          generatedAt: snapshot.toISOString(),
          privacy: {
            minGroupSize: K_ANONYMITY,
            approximateCounts: true,
            locationStored: false,
            individualsShown: false,
          },
          live: { enabled: liveOn, items: live?.items ?? [] },
          events: snap.eventsNow,
          trendingTopics: snap.trendingTopics,
          activeCommunities: snap.activeCommunities,
          nearby: geo ? snap.nearby : null,
          needsLocation: !geo,
        };
      },
    });
  },
};
