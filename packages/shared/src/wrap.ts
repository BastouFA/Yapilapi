import type { Post, PublicUser } from './types.ts';

/**
 * The weekly wrap: a private look back at your week, made on Sunday evening in your time zone.
 * Only you see it. Optional: off in Settings, and nothing is made or sent for a week without
 * activity. The card image carries only your own content (counts, your moment of the week, the
 * songs you used), never anything about other people.
 */

/** Hour (in your time zone) on Sunday from which the wrap is made. */
export const WRAP_HOUR = 18;
/** How long the Pulse card stays, from the Sunday it was made. */
export const WRAP_CARD_DAYS = 3;

export interface WeeklyWrapCounts {
  posts: number;
  reels: number;
  newFriends: number;
  communities: number;
  places: number;
  events: number;
  songs: number;
}

export interface WeeklyWrapSong {
  kind: 'track' | 'sound';
  id: string;
  title: string;
  /** Catalogue songs: the artist. Sounds: null. */
  artist: string | null;
  /** How many of your posts used it this week. */
  uses: number;
}

export interface WeeklyWrap {
  id: string;
  /** Monday and Sunday of the week, as dates in your time zone (YYYY-MM-DD). */
  weekStart: string;
  weekEnd: string;
  timezone: string;
  counts: WeeklyWrapCounts;
  /** Your posts and reels from the week with the most going on, best first (up to 3). */
  best: Post[];
  /** One of your own posts, chosen for the week. Null when none can be shown now. */
  moment: Post | null;
  /** People who became your friends this week and whom you can still see (up to 6). */
  newFriends: PublicUser[];
  communities: { id: string; slug: string; name: string }[];
  events: { id: string; title: string; startsAt: string }[];
  places: { id: string; name: string }[];
  songs: WeeklyWrapSong[];
  /** The shareable card image (PNG), only for you. Fetch it signed in. */
  cardPath: string;
  createdAt: string;
}

/** The small card on Pulse. */
export interface WeeklyWrapCard {
  id: string;
  weekStart: string;
  weekEnd: string;
  counts: WeeklyWrapCounts;
  /** A picture from your moment of the week, when it has one you can see. */
  thumbUrl: string | null;
}

/** "On this day" on Pulse: your own posts from this day in earlier years. Links to Memories. */
export interface OnThisDayCard {
  /** How many posts in all. */
  count: number;
  /** The years they're from, newest first. */
  years: number[];
  /** Up to 3, newest first. */
  posts: Post[];
}

export interface PulseCards {
  wrap: WeeklyWrapCard | null;
  onThisDay: OnThisDayCard | null;
}

export interface WeeklyWrapSettings {
  /** Make a weekly wrap. */
  enabled: boolean;
  /** Tell me when it's ready. */
  notify: boolean;
  /** The time zone Sunday evening is worked out in (your device's, last time it checked in). */
  timezone: string;
}

/**
 * The Monday that starts the week containing `date` (a YYYY-MM-DD date), and its Sunday. Weeks
 * run Monday to Sunday, as ISO weeks do.
 */
export function weekOf(date: string): { start: string; end: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(d.getTime() - dow * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** True when the wrap would say nothing: no posts, friends, communities, places, events or songs. */
export function isEmptyWeek(c: WeeklyWrapCounts): boolean {
  return !c.posts && !c.reels && !c.newFriends && !c.communities && !c.places && !c.events && !c.songs;
}
