import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mapPresenceSchema, mapQuerySchema, type MapCenter, type MapLayer } from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { featureDisabled, parse } from '../lib/errors.ts';
import { createMapCache, mapItems, presenceOf, safeZone, setPresence, stopPresence } from '../lib/city-map.ts';
import { seesSensitiveMedia } from '../lib/interactions.ts';
import { isEnabled } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/**
 * Near you (docs/product/city-map.md, lib/city-map.ts): what's happening in a box on the map, and
 * "Show me on the map to friends". Behind CITY_MAP. Lives need LIVE and chains PASS_THE_MIC too.
 */
export default async function cityMapModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const cache = createMapCache();
  const on = async () => {
    if (!(await isEnabled(db, 'CITY_MAP'))) throw featureDisabled('Near you');
  };

  /**
   * What's in the box (south, west, north, east; at most MAP_MAX_SPAN degrees each way) on the
   * layers asked for, as this viewer may see it. Signed out: everything but Friends out.
   */
  app.get('/v1/map', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    await on();
    const q = parse(mapQuerySchema, req.query);
    const viewer = req.user?.id ?? null;
    const off = new Set<MapLayer>();
    if (!(await isEnabled(db, 'LIVE'))) off.add('live');
    if (!(await isEnabled(db, 'PASS_THE_MIC'))) off.add('chains');
    const answer = await mapItems(db, cache, {
      box: { south: q.south, west: q.west, north: q.north, east: q.east },
      layers: q.layers,
      tz: safeZone(q.tz),
      viewer,
      sensitive: await seesSensitiveMedia(db, viewer),
      off,
    });
    // Only for this viewer, and only briefly: lives start and end, friends move.
    reply.header('cache-control', 'private, max-age=15');
    return answer;
  });

  /**
   * Where to start the map when the device can't say: the city searched for, or the viewer's own
   * profile city, as the middle of the place pages there. Null when there are none.
   */
  app.get('/v1/map/center', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const q = parse(z.object({ city: z.string().trim().min(1).max(60).optional() }), req.query);
    let city = q.city ?? null;
    if (!city && req.user)
      city = (await db.query<{ city: string | null }>(`SELECT city FROM profiles WHERE user_id = $1`, [req.user.id])).rows[0]?.city ?? null;
    if (!city) return { center: null };
    const like = `${city.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await db.query<{ city: string; lat: number; lng: number }>(
      `SELECT min(pl.city) AS city, avg(pl.lat) AS lat, avg(pl.lng) AS lng FROM places pl
       WHERE pl.deleted_at IS NULL AND pl.lat IS NOT NULL AND lower(pl.city) LIKE $1
       GROUP BY lower(pl.city) ORDER BY (lower(pl.city) = lower($2)) DESC, count(*) DESC LIMIT 1`,
      [like, city],
    );
    const r = rows[0];
    const center: MapCenter | null = r ? { center: { lat: Number(r.lat), lng: Number(r.lng) }, city: r.city } : null;
    return { center };
  });

  /** Your "Show me on the map to friends", or null when it's off. */
  app.get('/v1/map/presence', { preHandler: requireAuth }, async (req) => {
    await on();
    return { presence: await presenceOf(db, me(req).id) };
  });

  /** Turn it on, or move it to where you are now (rounded to about a kilometre before it's kept). */
  app.put('/v1/map/presence', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const input = parse(mapPresenceSchema, req.body);
    return { presence: await setPresence(db, me(req).id, input, input.duration, safeZone(input.timeZone)) };
  });

  /** Stop it now: the point is deleted. */
  app.delete('/v1/map/presence', { preHandler: requireAuth }, async (req) => {
    await on();
    await stopPresence(db, me(req).id);
    return { presence: null };
  });
}
