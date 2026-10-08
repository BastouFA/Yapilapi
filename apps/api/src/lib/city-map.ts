import type { Pool, PoolClient } from 'pg';
import {
  CHAIN_RULES,
  MAP_BUZZ_HOURS,
  MAP_BUZZ_MIN_PEOPLE,
  MAP_LAYER_LIMIT,
  approximatePoint,
  friendPoint,
  marketPoint,
  type LatLng,
  type MapAnswer,
  type MapBox,
  type MapItem,
  type MapLayer,
  type MapPresence,
  type MapPresenceDuration,
} from '@yapilapi/shared';
import { ASK_MAP_CANDIDATES, questionMapItems } from './ask-city.ts';
import { chainsById } from './chains.ts';
import { listingListedSql, listingPhotos, LISTING_FROM } from './market.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { eventVisibleSql, liveVisibleSql, notBlockedSql, postUnlockedSql, postVisibleSql, PUBLIC_POST_SQL } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Near you (docs/product/city-map.md): what's happening in a box on the map, for one viewer.
 *
 * Each layer is read in two steps. First the candidates in the area around the box (the box
 * widened to a grid, so people looking at the same part of a city share it): ids and points,
 * the same for everyone, kept in memory for MAP_CACHE_MS. Then, every time and never cached,
 * the candidates this viewer may see, with what their card shows, through the same visibility
 * rules as everywhere else (postVisibleSql, eventVisibleSql, liveVisibleSql, listingListedSql,
 * chainsById, askListedSql), so blocks, private accounts, audiences, minors and regional rules apply as they
 * do in feeds. Friends out is never cached: it's only ever about this viewer.
 *
 * Points: places (lives, events, buzzing places, chains) are public place pages already. Market
 * listings keep only a point rounded to a kilometre and the map moves it to the 2 km grid
 * (marketPoint). Friends are always on the kilometre grid (friendPoint), whatever they shared.
 */

export const MAP_CACHE_MS = 30_000;
const CACHE_MAX = 500;
/** Candidates read per layer and area: more than a box shows, since some are for other people. */
const CANDIDATES = MAP_LAYER_LIMIT * 5;

interface Candidate {
  id: string;
  lat: number;
  lng: number;
  /** Places and chains: posts or reels there. */
  n?: number;
  /** Places and chains: the latest one. */
  at?: Date | null;
  /** Chains: the place the reels were made at. */
  place_id?: string;
}

export interface MapCache {
  get(key: string): Candidate[] | undefined;
  set(key: string, value: Candidate[]): void;
}

/** A small in-memory cache with a time limit, oldest out first. One per app. */
export function createMapCache(ttlMs = MAP_CACHE_MS): MapCache {
  const entries = new Map<string, { at: number; value: Candidate[] }>();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (Date.now() - e.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: Date.now(), value });
      while (entries.size > CACHE_MAX) entries.delete(entries.keys().next().value!);
    },
  };
}

/** The box widened to a grid whose cells suit its size: the area candidates are read and cached for. */
export function areaOf(b: MapBox): { key: string; box: MapBox } {
  const span = Math.max(b.north - b.south, b.east - b.west);
  const cell = [0.02, 0.05, 0.1, 0.25, 0.5].find((c) => c >= span / 2) ?? 1;
  const snap = (v: number, f: (n: number) => number) => Math.round(f(v / cell) * cell * 1e6) / 1e6;
  const box = {
    south: Math.max(-90, snap(b.south, Math.floor)),
    west: Math.max(-180, snap(b.west, Math.floor)),
    north: Math.min(90, snap(b.north, Math.ceil)),
    east: Math.min(180, snap(b.east, Math.ceil)),
  };
  return { key: `${cell}:${box.south}:${box.west}:${box.north}:${box.east}`, box };
}

const inBox = (b: MapBox, p: LatLng) => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
const inBoxSql = (lat: string, lng: string) => `${lat} BETWEEN $1 AND $3 AND ${lng} BETWEEN $2 AND $4`;
const boxParams = (b: MapBox) => [b.south, b.west, b.north, b.east];
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
/** An image for a card: a photo's small size, or a video's poster. `m` is a media row. */
const thumbSql = (m = 'm') =>
  `CASE WHEN ${m}.kind = 'video' THEN ${m}.poster_url ELSE coalesce(${m}.variants->>'thumb', ${m}.variants->>'medium', ${m}.url) END`;
/** Whether someone is under 18 (unknown ages count as adults, as for messages). */
const minorSql = (x: string) => `coalesce((SELECT ux.birth_date > current_date - interval '18 years' FROM users ux WHERE ux.id = ${x}), false)`;

/** The end of the viewer's day in their time zone (for Today), as a time. */
export async function endOfDay(db: Q, tz: string): Promise<Date> {
  const { rows } = await db.query<{ end: Date }>(`SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS end`, [tz]);
  return rows[0]!.end;
}

/** A time zone Postgres and Intl know, or UTC. */
export function safeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

// ─── Candidates (the same for everyone) ─────────────────────────────────

const CANDIDATE_SQL: Record<Exclude<MapLayer, 'friends'>, string> = {
  // Lives on now at a place.
  live: `SELECT l.id, pl.lat, pl.lng FROM live_sessions l JOIN places pl ON pl.id = l.place_id AND pl.deleted_at IS NULL
         WHERE l.status = 'live' AND l.place_id IS NOT NULL AND ${inBoxSql('pl.lat', 'pl.lng')}
         ORDER BY l.started_at DESC NULLS LAST LIMIT $5`,
  // Events at a place that are on now or start before the end of the viewer's day ($6). Never ones for people with the link.
  today: `SELECT e.id, pl.lat, pl.lng FROM events e JOIN places pl ON pl.id = e.place_id AND pl.deleted_at IS NULL
          WHERE e.deleted_at IS NULL AND e.visibility <> 'private' AND NOT e.online AND ${inBoxSql('pl.lat', 'pl.lng')}
            AND e.starts_at < $6 AND coalesce(e.ends_at, e.starts_at + interval '3 hours') > now()
          ORDER BY e.starts_at LIMIT $5`,
  // Listed things with a pickup point (already rounded to a kilometre when listed).
  market: `SELECT l.id, l.approx_lat AS lat, l.approx_lng AS lng FROM market_listings l JOIN users su ON su.id = l.seller_id
           WHERE l.deleted_at IS NULL AND su.status = 'active' AND l.moderation_status = 'normal' AND l.status <> 'sold' AND l.expires_at > now()
             AND l.approx_lat IS NOT NULL AND ${inBoxSql('l.approx_lat', 'l.approx_lng')}
           ORDER BY l.created_at DESC LIMIT $5`,
  // Places where several different people posted publicly in the last MAP_BUZZ_HOURS ($6), the busiest first.
  places: `SELECT pl.id, pl.lat, pl.lng, count(*)::int AS n, max(p.created_at) AS at
           FROM places pl JOIN posts p ON p.place_id = pl.id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
           WHERE pl.deleted_at IS NULL AND ${inBoxSql('pl.lat', 'pl.lng')} AND p.created_at > now() - make_interval(hours => $6) AND ${PUBLIC_POST_SQL}
           GROUP BY pl.id HAVING count(DISTINCT p.author_id) >= $7
           ORDER BY count(DISTINCT p.author_id) DESC, max(p.created_at) DESC LIMIT $5`,
  // Active chains with reels made at a place here: each at the place most of its reels here were made at.
  chains: `SELECT DISTINCT ON (x.chain_id) x.chain_id AS id, x.place_id, pl.lat, pl.lng, x.n, x.at
           FROM (SELECT l.chain_id, lp.place_id, count(*)::int AS n, max(l.created_at) AS at
                 FROM reel_chain_links l JOIN posts lp ON lp.id = l.post_id JOIN users lu ON lu.id = lp.author_id
                 JOIN reel_chains ch ON ch.id = l.chain_id JOIN places pl ON pl.id = lp.place_id
                 WHERE ch.last_link_at > now() - make_interval(days => $6) AND pl.deleted_at IS NULL AND ${inBoxSql('pl.lat', 'pl.lng')}
                   AND lp.deleted_at IS NULL AND lp.status = 'published' AND lp.moderation_status = 'normal' AND lu.status = 'active'
                 GROUP BY l.chain_id, lp.place_id) x
           JOIN places pl ON pl.id = x.place_id
           ORDER BY x.chain_id, x.n DESC, x.at DESC LIMIT $5`,
  // Ask the city: open questions whose area is here (lib/ask-city.ts).
  questions: ASK_MAP_CANDIDATES,
};

async function candidates(db: Q, cache: MapCache, layer: Exclude<MapLayer, 'friends'>, box: MapBox, dayEnd: Date): Promise<Candidate[]> {
  const area = areaOf(box);
  const key = `${layer}:${area.key}${layer === 'today' ? `:${dayEnd.toISOString()}` : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const params: unknown[] = [...boxParams(area.box), CANDIDATES];
  if (layer === 'today') params.push(dayEnd);
  if (layer === 'places') params.push(MAP_BUZZ_HOURS, MAP_BUZZ_MIN_PEOPLE);
  if (layer === 'chains') params.push(CHAIN_RULES.activeDays);
  const { rows } = await db.query<Candidate>(CANDIDATE_SQL[layer], params);
  // Chains come back by id (DISTINCT ON): the busiest first.
  if (layer === 'chains') rows.sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  cache.set(key, rows);
  return rows;
}

// ─── What this viewer may see ───────────────────────────────────────────

type Built = { items: MapItem[]; more: boolean };
const cut = (items: MapItem[]): Built => ({ items: items.slice(0, MAP_LAYER_LIMIT), more: items.length > MAP_LAYER_LIMIT });
const user = (r: Record<string, unknown>) => publicUserFrom(r, 'u_');
const userCols = (alias: string) =>
  `${alias}.user_id AS u_id, ${alias}.username AS u_username, ${alias}.display_name AS u_display_name, ${alias}.avatar_url AS u_avatar_url, ${alias}.mode AS u_mode, ${plusCol('u_', alias)}`;

async function liveItems(db: Q, viewer: string | null, c: Candidate[]): Promise<Built> {
  const { rows } = await db.query(
    `SELECT l.id, l.title, l.started_at, pl.name AS place_name, pl.lat, pl.lng, ${userCols('pr')}
     FROM live_sessions l JOIN places pl ON pl.id = l.place_id AND pl.deleted_at IS NULL
     JOIN profiles pr ON pr.user_id = l.host_id JOIN users hu ON hu.id = l.host_id
     WHERE l.id = ANY($2::uuid[]) AND l.status = 'live' AND hu.status = 'active' AND ${liveVisibleSql('$1')}
     ORDER BY l.started_at DESC NULLS LAST`,
    [viewer, c.map((x) => x.id)],
  );
  return cut(
    rows.map((r) => ({
      key: `live:${r.id}`,
      layer: 'live',
      title: r.title,
      subtitle: r.place_name,
      point: { lat: r.lat, lng: r.lng },
      approximate: false,
      at: iso(r.started_at),
      endsAt: null,
      thumbUrl: r.u_avatar_url ?? null,
      count: null,
      user: user(r),
      target: { kind: 'live', id: r.id },
    })),
  );
}

async function eventItems(db: Q, viewer: string | null, c: Candidate[], dayEnd: Date): Promise<Built> {
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.starts_at, e.ends_at, pl.name AS place_name, pl.lat, pl.lng
     FROM events e JOIN places pl ON pl.id = e.place_id AND pl.deleted_at IS NULL JOIN users hu ON hu.id = e.host_id
     WHERE e.id = ANY($2::uuid[]) AND hu.status = 'active' AND e.starts_at < $3 AND coalesce(e.ends_at, e.starts_at + interval '3 hours') > now()
       AND ${eventVisibleSql('$1')}
     ORDER BY e.starts_at`,
    [viewer, c.map((x) => x.id), dayEnd],
  );
  return cut(
    rows.map((r) => ({
      key: `today:${r.id}`,
      layer: 'today',
      title: r.title,
      subtitle: r.place_name,
      point: { lat: r.lat, lng: r.lng },
      approximate: false,
      at: iso(r.starts_at),
      endsAt: iso(r.ends_at),
      thumbUrl: null,
      count: null,
      user: null,
      target: { kind: 'event', id: r.id },
    })),
  );
}

async function marketItems(db: Q, viewer: string | null, c: Candidate[]): Promise<Built> {
  const { rows } = await db.query(
    `SELECT l.id, l.title, l.area, l.created_at, l.approx_lat, l.approx_lng ${LISTING_FROM}
     WHERE l.id = ANY($2::uuid[]) AND l.approx_lat IS NOT NULL AND ${listingListedSql('$1')}
     ORDER BY l.created_at DESC`,
    [viewer, c.map((x) => x.id)],
  );
  const photos = await listingPhotos(
    db,
    rows.slice(0, MAP_LAYER_LIMIT).map((r) => r.id),
    viewer,
  );
  return cut(
    rows.map((r) => {
      const photo = photos.get(r.id)?.[0];
      return {
        key: `market:${r.id}`,
        layer: 'market',
        title: r.title,
        subtitle: r.area,
        // Never the kept point: the 2 km grid around it.
        point: marketPoint({ lat: r.approx_lat, lng: r.approx_lng }),
        approximate: true,
        at: iso(r.created_at),
        endsAt: null,
        thumbUrl: photo ? photo.thumbUrl || photo.url : null,
        count: 1,
        user: null,
        target: { kind: 'listing', id: r.id },
      } satisfies MapItem;
    }),
  );
}

async function placeItems(db: Q, viewer: string | null, c: Candidate[]): Promise<Built> {
  const byId = new Map(c.map((x) => [x.id, x]));
  // The picture: the newest post there this viewer can see and open, with a photo or video that isn't sensitive.
  const { rows } = await db.query(
    `SELECT pl.id, pl.name, pl.city, pl.lat, pl.lng,
            (SELECT ${thumbSql()} FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
               JOIN post_media pm ON pm.post_id = p.id AND pm.position = 0 JOIN media m ON m.id = pm.media_id
             WHERE p.place_id = pl.id AND p.created_at > now() - make_interval(hours => $3) AND m.moderation <> 'sensitive'
               AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}
             ORDER BY p.created_at DESC LIMIT 1) AS thumb
     FROM places pl WHERE pl.id = ANY($2::uuid[]) AND pl.deleted_at IS NULL`,
    [viewer, c.map((x) => x.id), MAP_BUZZ_HOURS],
  );
  const items = rows.map((r) => ({
    key: `places:${r.id}`,
    layer: 'places' as const,
    title: r.name,
    subtitle: r.city,
    point: { lat: r.lat, lng: r.lng },
    approximate: false,
    at: iso(byId.get(r.id)?.at),
    endsAt: null,
    thumbUrl: r.thumb ?? null,
    count: byId.get(r.id)?.n ?? null,
    user: null,
    target: { kind: 'place' as const, id: r.id },
  }));
  items.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return cut(items);
}

async function chainItems(db: Q, viewer: string | null, c: Candidate[], sensitive: boolean): Promise<Built> {
  if (!c.length) return { items: [], more: false };
  // Only chains with a reel made at that place that this viewer can see (visibleLinkSql's rules, inline for the place).
  const { rows: seen } = await db.query<{ chain_id: string }>(
    `SELECT DISTINCT l.chain_id FROM reel_chain_links l JOIN posts p ON p.id = l.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     JOIN (SELECT unnest($2::uuid[]) AS chain_id, unnest($3::uuid[]) AS place_id) w ON w.chain_id = l.chain_id AND w.place_id = p.place_id
     WHERE p.moderation_status = 'normal' AND ${postVisibleSql('$1')}
       AND ($4 OR NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation = 'sensitive'))`,
    [viewer, c.map((x) => x.id), c.map((x) => x.place_id), sensitive],
  );
  const ok = new Set(seen.map((r) => r.chain_id));
  const shown = c.filter((x) => ok.has(x.id));
  const chains = await chainsById(
    db,
    shown.slice(0, MAP_LAYER_LIMIT + 1).map((x) => x.id),
    viewer,
    sensitive,
  );
  const byId = new Map(shown.map((x) => [x.id, x]));
  const names = await db.query<{ id: string; name: string }>(`SELECT id, name FROM places WHERE id = ANY($1::uuid[])`, [shown.map((x) => x.place_id)]);
  const placeName = new Map(names.rows.map((r) => [r.id, r.name]));
  return cut(
    chains.map((ch) => {
      const x = byId.get(ch.id)!;
      return {
        key: `chains:${ch.id}`,
        layer: 'chains',
        title: ch.prompt,
        subtitle: placeName.get(x.place_id!) ?? null,
        point: { lat: x.lat, lng: x.lng },
        approximate: false,
        at: iso(x.at),
        endsAt: null,
        thumbUrl: ch.cover?.posterUrl ?? null,
        count: x.n ?? null,
        user: null,
        target: { kind: 'chain', id: ch.id },
      } satisfies MapItem;
    }),
  );
}

/**
 * Friends out, for a signed-in viewer: friends sharing a live location with a chat the viewer is in
 * now, and friends who turned on "Show me on the map to friends". Never anyone else. Blocks either
 * way hide them, and an adult and someone under 18 never see each other here unless one is the
 * other's guardian through an active family link. Always on the kilometre grid.
 */
async function friendItems(db: Q, viewer: string, box: MapBox): Promise<Built> {
  const allowed = (f: string) => `(
    EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $5 AND fr.user_b = ${f}) OR (fr.user_b = $5 AND fr.user_a = ${f}))
    AND ${notBlockedSql(f, '$5')}
    AND EXISTS (SELECT 1 FROM users fu WHERE fu.id = ${f} AND fu.status = 'active')
    AND (${minorSql(f)} = ${minorSql('$5')}
         OR EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
                    AND ((fl.guardian_id = $5 AND fl.teen_id = ${f}) OR (fl.guardian_id = ${f} AND fl.teen_id = $5)))))`;
  // A little wider than the box: a point near its edge may round into it.
  const pad = 0.02;
  const params = [box.south - pad, box.west - pad, box.north + pad, box.east + pad, viewer];
  const [shares, presence] = await Promise.all([
    db.query(
      `SELECT DISTINCT ON (s.user_id) s.user_id AS friend_id, s.conversation_id, s.lat, s.lng, s.point_at AS at, s.ends_at, ${userCols('pr')}
       FROM location_shares s JOIN profiles pr ON pr.user_id = s.user_id
       WHERE s.mode = 'live' AND s.stopped_at IS NULL AND s.ends_at > now() AND s.lat IS NOT NULL AND s.user_id <> $5
         AND ${inBoxSql('s.lat', 's.lng')}
         AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = s.conversation_id AND cm.user_id = $5 AND cm.left_at IS NULL)
         AND ${allowed('s.user_id')}
       ORDER BY s.user_id, s.point_at DESC NULLS LAST`,
      params,
    ),
    db.query(
      `SELECT mp.user_id AS friend_id, mp.lat, mp.lng, mp.updated_at AS at, mp.ends_at, ${userCols('pr')}
       FROM map_presence mp JOIN profiles pr ON pr.user_id = mp.user_id
       WHERE mp.ends_at > now() AND mp.user_id <> $5 AND ${inBoxSql('mp.lat', 'mp.lng')} AND ${allowed('mp.user_id')}`,
      params,
    ),
  ]);
  const byFriend = new Map<string, MapItem>();
  for (const r of [...presence.rows, ...shares.rows]) {
    const item: MapItem = {
      key: `friends:${r.friend_id}`,
      layer: 'friends',
      title: r.u_display_name,
      subtitle: null,
      point: friendPoint({ lat: r.lat, lng: r.lng }),
      approximate: true,
      at: iso(r.at),
      endsAt: iso(r.ends_at),
      thumbUrl: r.u_avatar_url ?? null,
      count: null,
      user: user(r),
      // Sharing in a chat: tapping opens that chat; otherwise their profile.
      target: r.conversation_id ? { kind: 'chat', id: r.conversation_id } : { kind: 'user', username: r.u_username },
    };
    const had = byFriend.get(r.friend_id);
    if (!had || (item.at ?? '') > (had.at ?? '')) byFriend.set(r.friend_id, item);
  }
  return cut([...byFriend.values()].filter((i) => inBox(box, i.point)));
}

export interface MapRequest {
  box: MapBox;
  layers: MapLayer[];
  tz: string;
  viewer: string | null;
  sensitive: boolean;
  /** Layers turned off by a feature flag. */
  off: Set<MapLayer>;
}

/** What's in the box for this viewer, layer by layer. */
export async function mapItems(db: Q, cache: MapCache, req: MapRequest): Promise<MapAnswer> {
  const layers = req.layers.filter((l) => !req.off.has(l) && (l !== 'friends' || req.viewer));
  const dayEnd = await endOfDay(db, req.tz);
  const built = await Promise.all(
    layers.map(async (layer): Promise<Built> => {
      if (layer === 'friends') return friendItems(db, req.viewer!, req.box);
      const c = (await candidates(db, cache, layer, req.box, dayEnd)).filter((x) => inBox(req.box, x));
      if (!c.length) return { items: [], more: false };
      if (layer === 'live') return liveItems(db, req.viewer, c);
      if (layer === 'today') return eventItems(db, req.viewer, c, dayEnd);
      if (layer === 'market') return marketItems(db, req.viewer, c);
      if (layer === 'places') return placeItems(db, req.viewer, c);
      if (layer === 'questions')
        return cut(
          await questionMapItems(
            db,
            req.viewer,
            c.map((x) => x.id),
          ),
        );
      return chainItems(db, req.viewer, c, req.sensitive);
    }),
  );
  return {
    items: built.flatMap((b) => b.items),
    more: layers.filter((_, i) => built[i]!.more),
  };
}

// ─── Show me on the map to friends ──────────────────────────────────────

export async function presenceOf(db: Q, userId: string): Promise<MapPresence | null> {
  const { rows } = await db.query(`SELECT lat, lng, started_at, ends_at FROM map_presence WHERE user_id = $1 AND ends_at > now()`, [userId]);
  const r = rows[0];
  return r ? { point: { lat: r.lat, lng: r.lng }, startedAt: iso(r.started_at)!, endsAt: iso(r.ends_at)! } : null;
}

/**
 * Turn it on (or move it): only the point rounded to the kilometre grid is kept. A new duration
 * starts again from now; none keeps the end it has (or an hour when it was off). "Until midnight"
 * is the coming midnight in the person's time zone (the next one when that's under 15 minutes away).
 */
export async function setPresence(db: Q, userId: string, at: LatLng, duration: MapPresenceDuration | undefined, tz: string): Promise<MapPresence> {
  const p = approximatePoint(at);
  const ends =
    duration === undefined
      ? db.query(`SELECT coalesce((SELECT ends_at FROM map_presence WHERE user_id = $1 AND ends_at > now()), now() + interval '1 hour') AS end`, [userId])
      : duration === 'midnight'
        ? db.query(
            `SELECT CASE WHEN m - now() < interval '15 minutes' THEN m + interval '1 day' ELSE m END AS end
             FROM (SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS m) d`,
            [tz],
          )
        : db.query(`SELECT now() + make_interval(hours => $1) AS end`, [duration === '4h' ? 4 : 1]);
  const end = (await ends).rows[0].end as Date;
  await db.query(
    `INSERT INTO map_presence (user_id, lat, lng, ends_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now(), ends_at = EXCLUDED.ends_at,
       started_at = CASE WHEN $5 OR map_presence.ends_at <= now() THEN now() ELSE map_presence.started_at END`,
    [userId, p.lat, p.lng, end, duration !== undefined],
  );
  return (await presenceOf(db, userId))!;
}

export async function stopPresence(db: Q, userId: string): Promise<void> {
  await db.query(`DELETE FROM map_presence WHERE user_id = $1`, [userId]);
}

/** Delete presence past its time (the map never shows it; this keeps no point longer than chosen). */
export async function sweepPresence(db: Q): Promise<number> {
  return (await db.query(`DELETE FROM map_presence WHERE ends_at <= now()`)).rowCount ?? 0;
}
