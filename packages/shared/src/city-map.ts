import type { MessageKey } from './i18n-core.ts';
import { approximatePoint, roundedDistance, type LatLng } from './location.ts';
import type { PublicUser } from './types.ts';

/**
 * Near you: a live map of what's happening around you right now (docs/product/city-map.md).
 *
 * The apps ask for a box (south, west, north, east) and the layers they want, and get back the
 * items in it the viewer may see: lives at a place, events today and tonight, Market listings
 * (by pickup area, never closer than MAP_MARKET_METRES), places with many recent public posts,
 * Pass the Mic chains with reels made there, open questions people asked about the area (Ask
 * the city, by their area only), and friends who are out (only friends sharing a
 * live location with you in a chat, or who turned on "Show me on the map to friends"; always
 * rounded to about a kilometre). The viewer's own position never goes to the server for this:
 * only the box on screen does, and distances are worked out on the device.
 *
 * Tile and projection maths, clustering and the box helpers are here so the web page and the
 * phone screen draw the same map. No zod: the phone app imports this file directly (the
 * request schemas are in city-map-schemas.ts).
 */

export const MAP_LAYERS = ['live', 'today', 'market', 'places', 'chains', 'questions', 'friends'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/** The largest box the map answers for, in degrees each way (about 100 km): zoom in for more. */
export const MAP_MAX_SPAN = 1;
/** At most this many items per layer in one answer (the most relevant first). */
export const MAP_LAYER_LIMIT = 40;
/** Places buzzing: public posts there from at least this many different people in the last MAP_BUZZ_HOURS. */
export const MAP_BUZZ_MIN_PEOPLE = 3;
export const MAP_BUZZ_HOURS = 24;
/** Market listings are shown on a grid this many metres across (their kept point is already rounded to a kilometre). */
export const MAP_MARKET_METRES = 2000;
/** Zoom levels the apps allow (web-mercator tiles; 10 is a large city, 18 a street). */
export const MAP_MIN_ZOOM = 10;
export const MAP_MAX_ZOOM = 18;
export const MAP_DEFAULT_ZOOM = 13;
/** "Show me on the map to friends": for how long. */
export const MAP_PRESENCE_DURATIONS = ['1h', '4h', 'midnight'] as const;
export type MapPresenceDuration = (typeof MAP_PRESENCE_DURATIONS)[number];

/**
 * The map's pictures. OpenStreetMap's own tile servers are for light use; a busy deployment sets
 * its own provider (NEXT_PUBLIC_MAP_TILE_URL on the web, mapTileUrl in the phone build).
 */
export const MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const MAP_TILE_SIZE = 256;
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors';
export const MAP_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';

export interface MapBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** What tapping an item opens. Each app builds its own link from it (mapTargetPath for the web). */
export type MapTarget =
  | { kind: 'live'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'listing'; id: string }
  | { kind: 'place'; id: string }
  | { kind: 'chain'; id: string }
  /** Ask the city: a question (a post). */
  | { kind: 'post'; id: string }
  | { kind: 'chat'; id: string }
  | { kind: 'user'; username: string };

export interface MapItem {
  /** Unique in an answer: the layer and the item's own id. */
  key: string;
  layer: MapLayer;
  title: string;
  /** The place's name, the pickup area, or the city. */
  subtitle: string | null;
  /** Where the pin goes, already rounded as far as this layer needs (`approximate`). */
  point: LatLng;
  approximate: boolean;
  /** Lives: when it started. Events: when it starts. Places and chains: the latest post. Friends: the latest update. */
  at: string | null;
  /** Events: when it ends, if said. Friends: when they stop showing. */
  endsAt: string | null;
  thumbUrl: string | null;
  /** Places: recent posts there. Chains: reels made there. Questions: answers so far. Market: always 1. */
  count: number | null;
  /** Lives: the host. Friends: the friend. */
  user: PublicUser | null;
  target: MapTarget;
}

export interface MapAnswer {
  items: MapItem[];
  /** Layers that had more than MAP_LAYER_LIMIT items in the box: zooming in shows the rest. */
  more: MapLayer[];
}

/** Your own "Show me on the map to friends", when it's on. */
export interface MapPresence {
  point: LatLng;
  startedAt: string;
  endsAt: string;
}

/** Where to start the map when the browser or phone can't say: the profile's city, or the city searched for. */
export interface MapCenter {
  center: LatLng;
  city: string;
}

// ─── Boxes and tiles ────────────────────────────────────────────────────

const RAD = Math.PI / 180;
const clampLat = (lat: number) => Math.max(-85.05112878, Math.min(85.05112878, lat));
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** The world's width in pixels at zoom `z`. */
export const worldSize = (z: number) => MAP_TILE_SIZE * 2 ** z;

/** A point in world pixels at zoom `z` (web mercator; x grows east, y grows south). */
export function project(p: LatLng, z: number): { x: number; y: number } {
  const s = worldSize(z);
  const sin = Math.sin(clampLat(p.lat) * RAD);
  return { x: ((p.lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
}

/** World pixels back to a point. */
export function unproject(x: number, y: number, z: number): LatLng {
  const s = worldSize(z);
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: Math.atan(Math.sinh(n)) / RAD, lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
}

/** The box a view of `width` by `height` pixels shows around `center` at zoom `z`. */
export function viewBox(center: LatLng, z: number, width: number, height: number): MapBox {
  const c = project(center, z);
  const sw = unproject(c.x - width / 2, c.y + height / 2, z);
  const ne = unproject(c.x + width / 2, c.y - height / 2, z);
  return { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng };
}

/**
 * The box to ask the server for: the view, cut down to MAP_MAX_SPAN each way around its centre
 * when the screen is very large, and rounded to 5 decimal places.
 */
export function queryBox(b: MapBox): MapBox {
  const midLat = (b.south + b.north) / 2;
  const midLng = (b.west + b.east) / 2;
  const half = MAP_MAX_SPAN / 2;
  const latHalf = Math.min(half, (b.north - b.south) / 2);
  const lngHalf = Math.min(half, (b.east - b.west) / 2);
  return {
    south: round5(Math.max(-90, midLat - latHalf)),
    north: round5(Math.min(90, midLat + latHalf)),
    west: round5(Math.max(-180, midLng - lngHalf)),
    east: round5(Math.min(180, midLng + lngHalf)),
  };
}

/** The tiles that cover a view, each with where its top-left corner goes on screen. */
export function tilesFor(center: LatLng, z: number, width: number, height: number): { x: number; y: number; z: number; left: number; top: number }[] {
  const c = project(center, z);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const n = 2 ** z;
  const tiles: { x: number; y: number; z: number; left: number; top: number }[] = [];
  for (let ty = Math.floor(top / MAP_TILE_SIZE); ty * MAP_TILE_SIZE < top + height; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / MAP_TILE_SIZE); tx * MAP_TILE_SIZE < left + width; tx++) {
      tiles.push({ x: ((tx % n) + n) % n, y: ty, z, left: tx * MAP_TILE_SIZE - left, top: ty * MAP_TILE_SIZE - top });
    }
  }
  return tiles;
}

/** A tile's address from a template with {z}, {x} and {y}. */
export function tileUrl(template: string, t: { x: number; y: number; z: number }): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

/** Where a point goes on screen, in pixels from the view's top-left corner. */
export function screenPoint(p: LatLng, center: LatLng, z: number, width: number, height: number): { x: number; y: number } {
  const a = project(p, z);
  const c = project(center, z);
  return { x: a.x - c.x + width / 2, y: a.y - c.y + height / 2 };
}

/** The centre after dragging the map by (dx, dy) pixels. */
export function panBy(center: LatLng, z: number, dx: number, dy: number): LatLng {
  const c = project(center, z);
  const p = unproject(c.x - dx, c.y - dy, z);
  return { lat: clampLat(p.lat), lng: p.lng };
}

export const clampZoom = (z: number) => Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, Math.round(z)));

/** The point snapped to the Market's grid: everything listed near the same spot shares one pin place. */
export function marketPoint(p: LatLng): LatLng {
  const latStep = MAP_MARKET_METRES / 111_320;
  const lat = Math.round(p.lat / latStep) * latStep;
  const lngStep = latStep / Math.max(Math.cos(lat * RAD), 0.01);
  return { lat: round5(lat), lng: round5(Math.round(p.lng / lngStep) * lngStep) };
}

/** A friend's point as the map shows it: always the kilometre grid, whatever they shared in a chat. */
export const friendPoint = (p: LatLng): LatLng => approximatePoint(p);

// ─── Pins ───────────────────────────────────────────────────────────────

export interface MapCluster {
  key: string;
  /** Where the pin goes on screen. */
  x: number;
  y: number;
  items: MapItem[];
}

/**
 * Pins close together on screen become one, with a count: items are put in cells `cell` pixels
 * across and each cell's pin goes to the middle of its items. At high zoom most cells hold one.
 * Items on the same spot (a place with a live and an event) always share a pin.
 */
export function clusterItems(items: MapItem[], center: LatLng, z: number, width: number, height: number, cell = 56): MapCluster[] {
  const cells = new Map<string, { xs: number; ys: number; items: MapItem[] }>();
  for (const item of items) {
    const s = screenPoint(item.point, center, z, width, height);
    if (s.x < -cell || s.y < -cell || s.x > width + cell || s.y > height + cell) continue;
    const k = `${Math.floor(s.x / cell)}:${Math.floor(s.y / cell)}`;
    const c = cells.get(k) ?? { xs: 0, ys: 0, items: [] };
    c.xs += s.x;
    c.ys += s.y;
    c.items.push(item);
    cells.set(k, c);
  }
  return [...cells.entries()].map(([k, c]) => ({ key: `${z}:${k}`, x: c.xs / c.items.length, y: c.ys / c.items.length, items: c.items }));
}

/** Items nearest first from `from` (the viewer's own spot on their device, or the map's centre). */
export function byDistance(items: MapItem[], from: LatLng): MapItem[] {
  const d = (p: LatLng) => (p.lat - from.lat) ** 2 + ((p.lng - from.lng) * Math.cos(from.lat * RAD)) ** 2;
  return [...items].sort((a, b) => d(a.point) - d(b.point));
}

/** The web address an item opens. */
export function mapTargetPath(t: MapTarget): string {
  switch (t.kind) {
    case 'live':
      return `/live/${t.id}`;
    case 'event':
      return `/events/${t.id}`;
    case 'listing':
      return `/market/${t.id}`;
    case 'place':
      return `/places/${t.id}`;
    case 'chain':
      return `/chains/${t.id}`;
    case 'post':
      return `/p/${t.id}`;
    case 'chat':
      return `/inbox/${t.id}`;
    case 'user':
      return `/u/${t.username}`;
  }
}

// ─── Words ──────────────────────────────────────────────────────────────

export const MAP_LAYER_KEYS: Record<MapLayer, MessageKey> = {
  live: 'sidebar.live',
  today: 'm.picker.today',
  market: 'market.title',
  places: 'map.layer.places',
  chains: 'map.layer.chains',
  questions: 'map.layer.questions',
  friends: 'map.layer.friends',
};

export const MAP_PRESENCE_KEYS: Record<MapPresenceDuration, MessageKey> = {
  '1h': 'location.duration.60',
  '4h': 'map.presence.4h',
  midnight: 'map.presence.midnight',
};

/** "2.3 km", "450 m", or null under 100 m: how far an item is, in the reader's language. */
export function mapDistance(t: (key: MessageKey, vars?: Record<string, string | number>) => string, metres: number, locale: string): string | null {
  const d = roundedDistance(metres);
  if (d.unit === 'near') return null;
  let n = String(d.value);
  try {
    n = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(d.value);
  } catch {
    // An unknown locale keeps the plain number.
  }
  return t(d.unit === 'm' ? 'location.distance.m' : 'location.distance.km', { n });
}
