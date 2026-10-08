/**
 * Yapilapi Today (docs/product/yapilapi-today.md): every morning, a short briefing of what your
 * people and your city are talking about, read aloud in your language. Types and limits both
 * apps use; the phone imports this file directly, so it stays free of zod.
 */

/** The hour (in your time zone) a Today is made by default, and the hours you can choose from. */
export const TODAY_DEFAULT_HOUR = 7;
export const TODAY_HOURS = [5, 6, 7, 8, 9, 10, 11] as const;
/** At most this many segments, and about this many words in all. */
export const TODAY_MAX_SEGMENTS = 7;
export const TODAY_MAX_WORDS = 300;

export interface TodaySource {
  postId: string;
  /** The author, by handle. */
  username: string;
  displayName: string;
  /** A Yap's own recording ("Hear @ada"): only while the listener can hear it. */
  voice: { id: string; url: string; durationMs: number } | null;
}

export interface TodaySegment {
  /** Its position in the briefing (what "Not interested in this" names). */
  index: number;
  /** About your people (follows, friends, squads) or your city. */
  kind: 'people' | 'city';
  text: string;
  /** Read aloud by a plain synthetic voice, when listening is set up and within the day's budget. */
  audioUrl: string | null;
  /** The posts it is about, each one you can open. */
  sources: TodaySource[];
}

export interface TodayBriefing {
  id: string;
  /** The local date it is for (YYYY-MM-DD). */
  day: string;
  lang: string;
  segments: TodaySegment[];
  /** Made by the local development provider (rule-based, no model). */
  dev: boolean;
  createdAt: string;
}

export interface TodaySettings {
  enabled: boolean;
  /** 5 to 11: from this hour in your time zone. */
  hour: number;
  /** Include what's being said in your city (needs a city on your profile). */
  city: boolean;
  /** "Your Today is ready" (quiet hours respected). Off by default. */
  notify: boolean;
  timezone: string;
}
