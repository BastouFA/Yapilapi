import type { MessageKey } from './i18n-core.ts';
import { distanceMetres, type LatLng } from './location.ts';
import type { MusicTrack } from './music.ts';
import type { PublicUser } from './types.ts';
import type { VoiceClip } from './voice.ts';

/**
 * Stash (docs/product/stash.md): hide something at a real place, and it only opens for someone
 * who is there. A note, a photo, a short video, a song, a voice note or a gift (a short code, a
 * promo code, a riddle's answer: just text), with an optional title and hint ("Under the big tree").
 *
 * You hide it where you are (the device's position, accurate to STASH_MAX_ACCURACY metres or better)
 * and choose who can open it (one person, friends, a squad or everyone), for how long and whether
 * only the first finder gets it. The exact point is kept but never sent to anyone but you (and the
 * team's moderators): everyone else sees an area about STASH_AREA_METRES across around it, placed
 * with a random offset of its own so the point isn't its middle, and "about 300 m away". It opens
 * within STASH_OPEN_METRES of the point.
 *
 * Pure helpers and types, safe for the phone (no zod; the request schemas are in stash-schemas.ts).
 */

export const STASH_KINDS = ['text', 'photo', 'video', 'song', 'voice', 'gift'] as const;
export type StashKind = (typeof STASH_KINDS)[number];

export const STASH_AUDIENCES = ['person', 'friends', 'squad', 'everyone'] as const;
export type StashAudience = (typeof STASH_AUDIENCES)[number];

/** How long it stays findable: a day, a week, or until you take it back. */
export const STASH_DURATIONS = ['24h', '7d', 'none'] as const;
export type StashDuration = (typeof STASH_DURATIONS)[number];

/** A note's words (also the line that goes with a photo, video, song, voice note or gift). */
export const STASH_TEXT_MAX = 500;
export const STASH_TITLE_MAX = 60;
export const STASH_HINT_MAX = 140;
/** A gift's code or words, revealed on opening. */
export const STASH_GIFT_MAX = 64;
/** A video stash is short: at most this long. */
export const STASH_VIDEO_MAX_MS = 60_000;
/** Stashes one person may hide in a day. */
export const STASH_PER_DAY = 20;
/** A position less accurate than this (in metres) can't hide or open a stash. */
export const STASH_MAX_ACCURACY = 100;
/** A stash opens within this many metres of where it was hidden… */
export const STASH_OPEN_METRES = 50;
/** …give or take the device's accuracy, up to this many metres. */
export const STASH_ACCURACY_SLACK = 30;
/** Others see an area this many metres across, never the point. */
export const STASH_AREA_METRES = 100;
/** How far the area's middle may be from the point (a random distance and direction of its own, kept). */
export const STASH_AREA_OFFSET_METRES = 35;
/** Faster than this between two positions (km/h) isn't someone on the ground: the second is refused. */
export const STASH_MAX_SPEED_KMH = 300;
/** Only a jump of more than this many metres is checked against STASH_MAX_SPEED_KMH (GPS wanders over short distances). */
export const STASH_JUMP_METRES = 1000;
/** Recent positions are kept this long, then deleted (only to spot impossible jumps). */
export const STASH_SAMPLE_MINUTES = 60;
/** "Stashes near you": this far around, at most. */
export const STASH_NEAR_METRES = 5000;
/** A thank-you's words. */
export const STASH_THANKS_MAX = 140;
/** The quick thank-yous a finder can send back (shown as icons). */
export const STASH_REACTIONS = ['thanks', 'love', 'laugh', 'wow'] as const;
export type StashReaction = (typeof STASH_REACTIONS)[number];
/** Explorer badges: a first find, 10 and 50 finds, finds in 3 cities. */
export const STASH_BADGES = ['first_find', 'finds_10', 'finds_50', 'cities_3'] as const;
export type StashBadge = (typeof STASH_BADGES)[number];
/** "Top explorers in Lagos" lists this many people. */
export const STASH_EXPLORERS_LIMIT = 10;

/** The launch cities: quick picks when the device can't say where you are, and the explorer lists. */
export const LAUNCH_CITIES = [
  { key: 'lagos', name: 'Lagos', center: { lat: 6.5244, lng: 3.3792 } },
  { key: 'lome', name: 'Lomé', center: { lat: 6.1375, lng: 1.2123 } },
  { key: 'paris', name: 'Paris', center: { lat: 48.8566, lng: 2.3522 } },
] as const;
export type LaunchCity = (typeof LAUNCH_CITIES)[number];
export type LaunchCityKey = LaunchCity['key'];
/** A point within this many kilometres of a launch city's middle counts as that city. */
export const LAUNCH_CITY_KM = 60;

/** The launch city a point is in (the nearest within LAUNCH_CITY_KM), or null. */
export function launchCityAt(p: LatLng): LaunchCity | null {
  let best: { city: LaunchCity; d: number } | null = null;
  for (const city of LAUNCH_CITIES) {
    const d = distanceMetres(p, city.center);
    if (d <= LAUNCH_CITY_KM * 1000 && (!best || d < best.d)) best = { city, d };
  }
  return best?.city ?? null;
}

/** Whether a position is good enough to hide or open a stash. */
export const accurateEnough = (accuracy: number) => Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= STASH_MAX_ACCURACY;

/**
 * How many metres are left before a stash opens, from `metres` away with a position accurate to
 * `accuracy` metres (some of the accuracy counts in the finder's favour, up to STASH_ACCURACY_SLACK).
 * Zero: it opens.
 */
export function stashMetresToGo(metres: number, accuracy: number): number {
  return Math.max(0, metres - Math.min(Math.max(accuracy, 0), STASH_ACCURACY_SLACK) - STASH_OPEN_METRES);
}

/**
 * "About 120 m to go", rounded up so it never says exactly where: to 10 m under 100 m, 50 m under
 * 500 m, 100 m under a kilometre. Further than that: null ("keep looking nearby").
 */
export function roundedToGo(metres: number): number | null {
  if (metres <= 0) return 0;
  if (metres < 100) return Math.ceil(metres / 10) * 10;
  if (metres < 500) return Math.ceil(metres / 50) * 50;
  if (metres < 1000) return Math.ceil(metres / 100) * 100;
  return null;
}

/** Kilometres an hour between two positions `seconds` apart (a second at least). */
export function speedKmh(a: LatLng, b: LatLng, seconds: number): number {
  return distanceMetres(a, b) / 1000 / (Math.max(seconds, 1) / 3600);
}

/** Badges earned with this many finds in this many different cities. */
export function stashBadges(finds: number, cities: number): StashBadge[] {
  const out: StashBadge[] = [];
  if (finds >= 1) out.push('first_find');
  if (finds >= 10) out.push('finds_10');
  if (finds >= 50) out.push('finds_50');
  if (cities >= 3) out.push('cities_3');
  return out;
}

/** What's inside, once it's open (or always, for the person who hid it). */
export interface StashContent {
  /** A note, or the words that go with the rest. */
  body: string | null;
  /** A gift: the code or words revealed. */
  giftCode: string | null;
  media: { kind: 'image' | 'video'; url: string; posterUrl: string | null; width: number | null; height: number | null; altText: string | null } | null;
  voice: VoiceClip | null;
  song: { track: MusicTrack; startMs: number; durationMs: number } | null;
}

/** A stash as the apps show it. Never the point, except to the person who hid it (`point`). */
export interface StashCard {
  id: string;
  kind: StashKind;
  title: string | null;
  hint: string | null;
  audience: StashAudience;
  /** Hidden by the YAPILAPI team (launch stashes): no person's name on it. */
  seeded: boolean;
  /** Who hid it; null when the team did. */
  owner: PublicUser | null;
  /** Roughly where: the area's middle, never the point, and how wide it is. */
  area: { center: LatLng; metres: number };
  city: string | null;
  expiresAt: string | null;
  /** Only the first person to find it can open it. */
  firstOnly: boolean;
  /** How many people opened it. */
  finds: number;
  createdAt: string;
  mine: boolean;
  /** You opened it. */
  found: boolean;
  /** A first-finder stash someone else opened first. */
  taken: boolean;
  /** Ended (its time is up) or taken back. */
  ended: boolean;
  /** Inside, when you opened it or hid it; null otherwise. */
  content: StashContent | null;
  /** Yours only: the exact point. */
  point?: LatLng;
  /** Yours only: who it's for. */
  recipient?: PublicUser | null;
  squad?: { id: string; name: string } | null;
  /** Yours only: 'normal' when findable; anything else means it's held for a look, or removed. */
  moderation?: 'normal' | 'review' | 'restricted' | 'removed';
}

/** Someone who found your stash, and what they sent back. */
export interface StashFind {
  finder: PublicUser;
  foundAt: string;
  reaction: StashReaction | null;
  thanks: string | null;
}

/** The answer to "open it": opened (with what's inside), or how far there is to go. */
export interface StashOpenResult {
  opened: boolean;
  /** Not opened: metres to go, rounded (roundedToGo); null when it's further than a kilometre. */
  toGoMetres: number | null;
  stash: StashCard;
}

/** "Stashes found: 12 · Hidden: 5", and badges. Null when the person keeps it to themselves. */
export interface StashExplorer {
  found: number;
  hidden: number;
  cities: number;
  badges: StashBadge[];
}

export interface StashExplorerRow {
  user: PublicUser;
  finds: number;
}

export interface StashSettings {
  /** "Show my stash counts on my profile". */
  showCounts: boolean;
  /** "Show me in explorer lists" (always off under 18). */
  explorerLists: boolean;
  /** "Tell me about new stashes near me", at most once a day (off unless chosen). */
  nearbyNotify: boolean;
  /** Under 18: explorer lists can't be turned on. */
  explorerListsLocked: boolean;
}

// ─── Words ──────────────────────────────────────────────────────────────

export const STASH_KIND_KEYS: Record<StashKind, MessageKey> = {
  text: 'stash.kind.text',
  photo: 'stash.kind.photo',
  video: 'stash.kind.video',
  song: 'stash.kind.song',
  voice: 'stash.kind.voice',
  gift: 'stash.kind.gift',
};

export const STASH_AUDIENCE_KEYS: Record<StashAudience, MessageKey> = {
  person: 'stash.audience.person',
  friends: 'stash.audience.friends',
  squad: 'stash.audience.squad',
  everyone: 'stash.audience.everyone',
};

export const STASH_DURATION_KEYS: Record<StashDuration, MessageKey> = {
  '24h': 'stash.duration.24h',
  '7d': 'stash.duration.7d',
  none: 'stash.duration.none',
};

export const STASH_REACTION_KEYS: Record<StashReaction, MessageKey> = {
  thanks: 'stash.reaction.thanks',
  love: 'stash.reaction.love',
  laugh: 'stash.reaction.laugh',
  wow: 'stash.reaction.wow',
};

export const STASH_BADGE_KEYS: Record<StashBadge, MessageKey> = {
  first_find: 'stash.badge.first_find',
  finds_10: 'stash.badge.finds_10',
  finds_50: 'stash.badge.finds_50',
  cities_3: 'stash.badge.cities_3',
};

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;
type Tp = (key: 'stash.notif.found' | 'push.stash_nearby', count: number, vars?: Record<string, string | number>) => string;

const STASH_NOTICES = ['stash_found', 'stash_thanks', 'stash_nearby'] as const;

/**
 * Notifications about stashes, in the reader's language, or null for other kinds: "Ada found your
 * stash", "Ada and 2 others found your stash", "Ada thanked you for your stash", "3 new stashes near you today".
 */
export function stashNoticeText(n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> }, t: Tr, tp: Tp): string | null {
  const name = n.actor?.displayName ?? t('push.someone');
  switch (n.type) {
    case 'stash_found': {
      const others = Math.max(0, Number(n.data.count ?? 1) - 1);
      return others ? tp('stash.notif.found', others, { name }) : t('push.stash_found', { name });
    }
    case 'stash_thanks':
      return t('push.stash_thanks', { name });
    case 'stash_nearby':
      return tp('push.stash_nearby', Number(n.data.count ?? 1));
    default:
      return null;
  }
}

/** The stash a notification opens (an id), the Stash page ('') for "new stashes near you", or null for other kinds. */
export function stashNoticeTarget(n: { type: string; entityId?: string | null }): string | null {
  if (!(STASH_NOTICES as readonly string[]).includes(n.type)) return null;
  return n.type === 'stash_nearby' ? '' : (n.entityId ?? '');
}
