/**
 * Yap Radio (docs/product/yap-radio.md): press play once and listen hands-free, one Yap after
 * another, like radio. Types, limits and pure helpers shared by the API, the web and the phone
 * (which imports this file directly, so no zod here).
 */
import type { Post } from './types.ts';
import { VOICE_COMPLETE_AT } from './voice.ts';

/**
 * The stations. `for_you`: the recommender's Yap ranking. `friends`: people you follow and your
 * friends. `near`: Yaps tagged at places near you (or in your city). `topics`: #tags you follow,
 * or the one in `key`. `squad`: your squad's Yaps (members only, `key` its id). `person`: one
 * person's Yaps (`key` their username, "Play as radio" on a profile). `place`: one place's Yaps
 * (`key` its id).
 */
export const RADIO_STATIONS = ['for_you', 'friends', 'near', 'topics', 'squad', 'person', 'place'] as const;
export type RadioStationKind = (typeof RADIO_STATIONS)[number];
/** Stations that need a `key`. */
export const RADIO_KEYED: readonly RadioStationKind[] = ['squad', 'person', 'place'];

export interface RadioStation {
  kind: RadioStationKind;
  /** The squad id, the username, the place id or the #tag (for topics, optional). */
  key?: string | null;
}

/** A station as the API describes it: its name when it has one of its own (a squad, a person, a place, a tag). */
export interface RadioStationInfo extends RadioStation {
  key: string | null;
  title: string | null;
}

/** GET /v1/radio/:station: the next Yaps to play, in order, and where to carry on from. */
export interface RadioPage {
  station: RadioStationInfo;
  items: Post[];
  /** The speakers among `items` the listener follows (for the Follow button). */
  following: string[];
  nextCursor: string | null;
  /** Near you with no place to go by (no location sent and no city on the profile): say how to give one. */
  needsPlace?: boolean;
}

/** GET /v1/radio: the stations offered to you (the four main ones, your squads, the tags you follow). */
export interface RadioStations {
  stations: RadioStationInfo[];
}

/** Yaps per page (the API allows up to RADIO_PAGE_MAX). Off Data saver the next page is asked for when this many are left. */
export const RADIO_PAGE = 10;
export const RADIO_PAGE_MAX = 20;
export const RADIO_REFILL_AT = 2;
/** The short quiet between two Yaps, in the app (none in the background on the phone, where a pause could end the session). */
export const RADIO_GAP_MS = 700;
/** Skipped within this long of starting: a quick skip, which tells the recommender "not this". */
export const RADIO_QUICK_SKIP_MS = 5000;
/** A Yap quickly skipped on the radio isn't played again there for this many days. Finished ones never are. */
export const RADIO_SKIP_DAYS = 7;
/** "Back" within this long of a Yap starting goes to the one before; later it starts this one again. */
export const RADIO_BACK_RESTART_MS = 3000;
/** The sleep timer's choices, in minutes. */
export const RADIO_SLEEP_MINUTES = [15, 30, 60] as const;
export type RadioSleepMinutes = (typeof RADIO_SLEEP_MINUTES)[number];
/** Near you: Yaps tagged within this many kilometres of where you are. */
export const RADIO_NEAR_KM = 25;
/** A stored clip is about this many bytes a minute (AAC mono, about 32 kbit/s). */
export const RADIO_BYTES_PER_MINUTE = 240_000;
/** Where you left off is picked up again for this long. */
export const RADIO_RESUME_MS = 7 * 24 * 3600_000;

/** One string for a station ("for_you", "squad:<id>", "topics:music"): what the apps keep to resume, and compare. */
export function stationId(s: RadioStation): string {
  return s.key ? `${s.kind}:${s.key}` : s.kind;
}

/** The station back from stationId, or null when it isn't one. */
export function parseStationId(id: string | null | undefined): RadioStation | null {
  if (!id) return null;
  const i = id.indexOf(':');
  const kind = (i < 0 ? id : id.slice(0, i)) as RadioStationKind;
  const key = i < 0 ? null : id.slice(i + 1) || null;
  if (!RADIO_STATIONS.includes(kind)) return null;
  if (RADIO_KEYED.includes(kind) && !key) return null;
  if (!RADIO_KEYED.includes(kind) && kind !== 'topics' && key) return null;
  return { kind, key };
}

/** About how many bytes a Yap's clip is: its stored size when known, otherwise from its length. */
export function clipBytes(post: Pick<Post, 'media' | 'voice'>): number {
  const sized = post.media.find((m) => m.kind === 'audio')?.sizes?.original;
  if (sized && sized > 0) return sized;
  return Math.round(((post.voice?.durationMs ?? 0) / 60_000) * RADIO_BYTES_PER_MINUTE);
}

/** What a stop after `heardMs` of a clip means for the recommender: a quick skip, a finish, or nothing. */
export function radioOutcome(heardMs: number, furthestMs: number, durationMs: number): 'skip' | 'complete' | null {
  if (durationMs > 0 && furthestMs >= durationMs * VOICE_COMPLETE_AT) return 'complete';
  if (heardMs < RADIO_QUICK_SKIP_MS) return 'skip';
  return null;
}

/** What "back" does at `positionMs` into the current Yap: start it again, or go to the one before. */
export function radioBack(positionMs: number, index: number): 'restart' | 'previous' {
  return positionMs > RADIO_BACK_RESTART_MS || index <= 0 ? 'restart' : 'previous';
}

/** The sleep timer's time left as "12:05" (minutes and seconds), never below zero. */
export function sleepClock(leftMs: number): string {
  const s = Math.max(0, Math.ceil(leftMs / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where the radio was, kept on the device so it can pick up again. */
export interface RadioResume {
  station: string;
  postId: string;
  positionMs: number;
  /** When it was kept (ms since the epoch). */
  at: number;
}

/** A kept resume point, if it's still recent and well formed. */
export function readResume(value: unknown, now = Date.now()): RadioResume | null {
  const r = value as Partial<RadioResume> | null;
  if (!r || typeof r !== 'object' || typeof r.station !== 'string' || typeof r.postId !== 'string') return null;
  if (!parseStationId(r.station) || typeof r.at !== 'number' || now - r.at > RADIO_RESUME_MS) return null;
  const positionMs = typeof r.positionMs === 'number' && r.positionMs > 0 ? Math.round(r.positionMs) : 0;
  return { station: r.station, postId: r.postId, positionMs, at: r.at };
}
