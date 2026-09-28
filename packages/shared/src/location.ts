import type { MessageKey, PluralKey } from './i18n-core.ts';
import type { PublicUser } from './types.ts';

/**
 * Sharing where you are with a chat, for a limited time ("I'm on my way", meeting up at an event).
 *
 * A live share runs for 15 minutes, an hour or 8 hours (never indefinitely) and can be stopped at
 * any time. The server keeps only the latest point of each share, and deletes it when the share
 * ends: afterwards only the fact that it happened remains. "Send my location once" is a single
 * pin kept like a message, until it's unsent. Approximate shares are snapped to a grid of about
 * a kilometre on the device before they're sent, and again on the server.
 *
 * Distance and direction from the viewer are worked out on the viewer's device only (from their
 * own live share in the chat, or their position read once when they ask); the server never sees
 * where a viewer is. There are no map tiles: the apps draw their own card and open the platform's
 * maps app with the coordinates when asked.
 *
 * No zod here: the mobile app imports this file directly. The request schemas are in location-schemas.ts.
 */

/** How long a live share can run, in minutes. */
export const LOCATION_DURATIONS = [15, 60, 480] as const;
export type LocationDuration = (typeof LOCATION_DURATIONS)[number];

export const LOCATION_PRECISIONS = ['precise', 'approximate'] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

/** A live share takes at most one new point this often. */
export const LOCATION_UPDATE_SECONDS = 10;
/** Approximate points are snapped to a grid this many metres across. */
export const LOCATION_APPROXIMATE_METRES = 1000;
/** Asking the chat where they are: once per person per chat in this many minutes. */
export const LOCATION_REQUEST_MINUTES = 10;

export interface LatLng {
  lat: number;
  lng: number;
}

/** A place on a share: the latest one, as the server keeps it. */
export interface LocationPoint extends LatLng {
  /** How sure the device was, in metres (approximate shares say at least LOCATION_APPROXIMATE_METRES). */
  accuracyM: number | null;
  /** When the device read it. */
  at: string;
}

/** Why a live share ended. */
export type LocationStopReason = 'stopped' | 'expired' | 'blocked' | 'left' | 'joined' | 'unsent';

/** A share on a chat message, as one member sees it. */
export interface LocationShare {
  id: string;
  messageId: string;
  conversationId: string;
  /** Who is sharing (the message's sender). */
  sharer: PublicUser;
  mode: 'live' | 'once';
  precision: LocationPrecision;
  /** The latest point. Null before the first one arrives, once a live share has ended, or when you can't see it. */
  point: LocationPoint | null;
  startedAt: string;
  /** Live shares: when it stops by itself. */
  endsAt: string | null;
  /** Live shares: running now (not stopped, not past its time). */
  live: boolean;
  /** Live shares that ended: when, and why. */
  stoppedAt: string | null;
  stopReason: LocationStopReason | null;
}

const RAD = Math.PI / 180;
const EARTH_METRES = 6_371_000;
const METRES_PER_DEGREE = 111_320;
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;

/** A point kept to about a metre (5 decimal places); nothing finer is ever stored. */
export function precisePoint(p: LatLng): LatLng {
  return { lat: round(Math.max(-90, Math.min(90, p.lat)), 5), lng: round(wrapLng(p.lng), 5) };
}

/**
 * The same point snapped to a grid about a kilometre across: everyone near the same spot gets the
 * same corner, so the exact place can't be worked out from several updates. Snapping twice gives
 * the same point.
 */
export function approximatePoint(p: LatLng): LatLng {
  const latStep = LOCATION_APPROXIMATE_METRES / METRES_PER_DEGREE;
  const lat = Math.max(-90, Math.min(90, Math.round(p.lat / latStep) * latStep));
  // A degree of longitude shrinks towards the poles; each row of the grid uses its own width.
  const lngStep = latStep / Math.max(Math.cos(lat * RAD), 0.01);
  const lng = wrapLng(Math.round(wrapLng(p.lng) / lngStep) * lngStep);
  return { lat: round(lat, 5), lng: round(lng, 5) };
}

/** The point as it may be sent and kept for this precision. */
export function pointFor(p: LatLng, precision: LocationPrecision): LatLng {
  return precision === 'approximate' ? approximatePoint(p) : precisePoint(p);
}

/** Metres between two points (great-circle distance). */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The direction to set off from `a` to reach `b`, in degrees clockwise from north (0 to 359). */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export const COMPASS_POINTS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** The nearest of the eight compass points for a bearing. */
export function compassPoint(bearing: number): CompassPoint {
  return COMPASS_POINTS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

/**
 * How far away, rounded the way people say it: "less than 100 m", then to 50 m under a kilometre,
 * to 0.1 km under 10 km, and whole kilometres beyond. Apps put `value` in their own words.
 */
export function roundedDistance(metres: number): { unit: 'near' | 'm' | 'km'; value: number } {
  if (metres < 100) return { unit: 'near', value: 100 };
  if (metres < 950) return { unit: 'm', value: Math.round(metres / 50) * 50 };
  if (metres < 9_950) return { unit: 'km', value: Math.round(metres / 100) / 10 };
  return { unit: 'km', value: Math.round(metres / 1000) };
}

/** From the viewer to the sharer: how far and which way. */
export function relativePosition(viewer: LatLng, target: LatLng): { metres: number; direction: CompassPoint } {
  return { metres: distanceMetres(viewer, target), direction: compassPoint(bearingDegrees(viewer, target)) };
}

/** A share is live while it's a live share, not stopped, and before its end (by the given clock). */
export function isLive(s: Pick<LocationShare, 'mode' | 'stoppedAt' | 'endsAt'>, now = Date.now()): boolean {
  return s.mode === 'live' && !s.stoppedAt && !!s.endsAt && new Date(s.endsAt).getTime() > now;
}

/** Seconds since the point was read (never below zero). */
export function secondsSince(at: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
}

/** Coordinates as maps apps and links expect them (dots, up to 5 decimal places). */
const coord = (n: number) => String(round(n, 5));

/**
 * Where "Open in maps" goes: OpenStreetMap on the web, Apple Maps on iOS, a geo: link (the
 * phone's choice of maps app) on Android. Only the coordinates go, and only when the person asks.
 */
export function mapsUrl(p: LatLng, platform: 'web' | 'ios' | 'android'): string {
  const lat = coord(p.lat);
  const lng = coord(p.lng);
  if (platform === 'ios') return `https://maps.apple.com/?ll=${lat},${lng}&q=${lat},${lng}`;
  if (platform === 'android') return `geo:${lat},${lng}?q=${lat},${lng}`;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
}

/**
 * The card's drawing: a quiet street pattern made up from the place (the same place always gets
 * the same pattern, and it says nothing about the real streets there). Lines are in a 0 to 100 box.
 */
export function mapPattern(p: LatLng, count = 7): { x1: number; y1: number; x2: number; y2: number; major: boolean }[] {
  // A small, stable generator seeded from the rounded place.
  let seed = Math.abs(Math.round(p.lat * 1000) * 73_856_093 + Math.round(p.lng * 1000) * 19_349_663) % 2_147_483_647 || 1;
  const next = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const across = i % 2 === 0;
    const at = 8 + next() * 84;
    const tilt = (next() - 0.5) * 24;
    lines.push(across ? { x1: -5, y1: at - tilt, x2: 105, y2: at + tilt, major: i < 2 } : { x1: at - tilt, y1: -5, x2: at + tilt, y2: 105, major: i < 2 });
  }
  return lines;
}

// ─── Words ──────────────────────────────────────────────────────────────

/** The app's translator (web and phone pass their own `t`, `tp` and language). */
export interface LocationWords {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  tp: (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;
  locale: string;
}

const number = (n: number, locale: string) => {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
};

/** "Updated 20 s ago" (short, on the card) or "20 seconds ago" (long, read out). */
export function locationAgo(w: LocationWords, seconds: number, long: boolean): string {
  if (seconds < 10) return w.t(long ? 'location.ago.now' : 'location.updated.now');
  if (seconds < 60) return long ? w.tp('location.ago.seconds', seconds) : w.t('location.updated.s', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return long ? w.tp('location.ago.minutes', minutes) : w.t('location.updated.min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  return long ? w.tp('location.ago.hours', hours) : w.t('location.updated.h', { n: hours });
}

/** "2.3 km", "450 m": a rounded distance in the reader's language (null when it's under 100 m). */
function distanceWords(w: LocationWords, metres: number): string | null {
  const d = roundedDistance(metres);
  if (d.unit === 'near') return null;
  return w.t(d.unit === 'm' ? 'location.distance.m' : 'location.distance.km', { n: number(d.value, w.locale) });
}

/** "About 2.3 km north-east of you", or "Less than 100 m from you". */
export function locationFromYou(w: LocationWords, viewer: LatLng, target: LatLng): string {
  const { metres, direction } = relativePosition(viewer, target);
  const distance = distanceWords(w, metres);
  if (!distance) return w.t('location.fromYouNear');
  return w.t('location.fromYou', { distance, direction: w.t(`location.dir.${direction}` as MessageKey) });
}

/**
 * What the card's picture says to someone who can't see it: "Ada is about 2.3 km north-east of you,
 * updated 20 seconds ago". `viewer` is where the person looking is (worked out on their device), if known.
 */
export function locationAlt(w: LocationWords, share: LocationShare, meId: string | undefined, viewer: LatLng | null, now = Date.now()): string {
  const name = share.sharer.displayName;
  const mine = share.sharer.id === meId;
  const live = isLive(share, now);
  if (share.mode === 'live' && !live) return w.t(mine ? 'location.alt.mineStopped' : 'location.alt.stopped', { name });
  if (!share.point) return live ? w.t('location.alt.waiting', { name }) : w.t('location.hidden');
  const ago = locationAgo(w, secondsSince(share.point.at, now), true);
  if (mine) return share.mode === 'live' ? w.t('location.alt.mineLive', { ago }) : w.t('location.alt.mineOnce');
  if (!viewer) return share.mode === 'live' ? w.t('location.alt.liveNoDistance', { name, ago }) : w.t('location.alt.onceNoDistance', { name });
  const { metres, direction } = relativePosition(viewer, share.point);
  const distance = distanceWords(w, metres);
  if (!distance) return share.mode === 'live' ? w.t('location.alt.liveNear', { name, ago }) : w.t('location.alt.onceNear', { name });
  const dir = w.t(`location.dir.${direction}` as MessageKey);
  return share.mode === 'live'
    ? w.t('location.alt.live', { name, distance, direction: dir, ago })
    : w.t('location.alt.once', { name, distance, direction: dir });
}

/** The card's status line: "Updated 20 s ago · Until 14:30", "Waiting for the first update", "Stopped sharing" or "Sent once". */
export function locationStatus(w: LocationWords, share: LocationShare, now = Date.now()): string {
  if (share.mode === 'once') return w.t('location.sentOnce');
  if (!isLive(share, now)) return w.t('location.stopped');
  const until = w.t('location.until', { time: clockTime(share.endsAt!, w.locale) });
  return share.point ? `${locationAgo(w, secondsSince(share.point.at, now), false)} · ${until}` : `${w.t('location.waiting')} · ${until}`;
}

/** A time of day in the reader's language ("14:30", "2:30 PM"). */
export function clockTime(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return new Date(iso).toTimeString().slice(0, 5);
  }
}
