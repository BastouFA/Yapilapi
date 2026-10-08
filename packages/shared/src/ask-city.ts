import type { MessageKey } from './i18n-core.ts';
import type { MapBox } from './city-map.ts';
import type { LatLng } from './location.ts';

/**
 * Ask the city (docs/product/ask-the-city.md): ask a question out loud, or in writing, and people
 * nearby answer by voice or text. Live local knowledge: "Best suya in Yaba?", "Is Third Mainland
 * jammed?", "Who fixes iPhones near Ikeja?".
 *
 * A question is a post (a Yap, or a text post) shared with everyone, with an area (a city, and a
 * place or part of it: never where the asker is), a topic and, when it's about now, an end.
 * Answers are its comments, voice replies included; the asker marks the ones that helped, which
 * come first and count towards the answerer's "Helped 12 people in Lagos".
 *
 * Pure helpers and types, safe for the phone (no zod here; the schemas are in
 * ask-city-schemas.ts). Not to be confused with "Ask me" (ask.ts), questions to one person.
 */

export const ASK_TOPICS = ['food', 'traffic', 'services', 'safety', 'events', 'shopping', 'other'] as const;
export type AskTopic = (typeof ASK_TOPICS)[number];

/** How long a question stays open: an hour, until the end of the asker's day, or a week. Left out: until it's old. */
export const ASK_EXPIRIES = ['1h', 'today', 'week'] as const;
export type AskExpiry = (typeof ASK_EXPIRIES)[number];

/** Questions one person may ask in a day. */
export const ASK_PER_DAY = 10;
/** The words of a written question, or the line that goes with a spoken one (YAP_TEXT_MAX). */
export const ASK_TEXT_MAX = 280;
/** A question without an end is listed as open for this many days. */
export const ASK_OPEN_DAYS = 14;
/** People who help answer get at most this many notifications about new questions a day. */
export const ASK_NOTIFY_PER_DAY = 3;
/** In For you and the Yaps filter, about one slot in this many is a question near you. */
export const ASK_FEED_EVERY = 15;
/** Map-area questions are placed on a grid this many metres across (never closer than that). */
export const ASK_AREA_METRES = 2000;

/** A traffic question is about now: it closes after an hour unless the asker chooses otherwise. */
export function askDefaultExpiry(topic: AskTopic): AskExpiry | null {
  return topic === 'traffic' ? '1h' : null;
}

/** A question as posts carry it (`Post.askCity`). */
export interface AskCityInfo {
  topic: AskTopic;
  /** The city it's about, as written ("Lagos"). */
  city: string;
  /** The part of it: a place's name or a neighbourhood ("Yaba"), or null for the whole city. */
  area: string | null;
  /** The place page it names, when it was asked about one. */
  placeId: string | null;
  /** When it closes, or null for a question without an end (open for ASK_OPEN_DAYS). */
  expiresAt: string | null;
  /** Still taking answers in Ask the city, on the map and in notifications (answers can always be added under it). */
  open: boolean;
  /** Answers people can see (the post's comment count). */
  answers: number;
  /** Answers the asker marked helpful. */
  helpful: number;
}

/** "Yaba, Lagos", or "Lagos" alone. */
export function askAreaLabel(q: Pick<AskCityInfo, 'city' | 'area'>): string {
  const area = q.area?.trim();
  return area && area.toLocaleLowerCase() !== q.city.trim().toLocaleLowerCase() ? `${area}, ${q.city}` : q.city;
}

/** The key cities are matched by: trimmed, lower case, single spaces. */
export function cityKey(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The point kept for a question asked from the map: the middle of the part on screen, moved to a
 * grid ASK_AREA_METRES across. With "Use my location" the map is centred on the asker, so the
 * middle itself is never kept.
 */
export function askAreaPoint(b: MapBox): LatLng {
  const latStep = ASK_AREA_METRES / 111_320;
  const lat = Math.round((b.south + b.north) / 2 / latStep) * latStep;
  const lngStep = latStep / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lng = Math.round((b.west + b.east) / 2 / lngStep) * lngStep;
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
  return { lat: r5(Math.max(-90, Math.min(90, lat))), lng: r5(Math.max(-180, Math.min(180, lng))) };
}

/** "Helped 12 people in Lagos", on the profile of someone whose answers people found helpful. */
export interface LocalHelper {
  /** Different people who marked one of their answers helpful, in that city. */
  people: number;
  city: string;
}

/** "Help answer questions near me": off by default. */
export interface AskHelperSettings {
  on: boolean;
  /** The city questions come from: the one chosen, or the profile's. Null when neither is set. */
  city: string | null;
  topics: AskTopic[];
}

/** Where a question is about, as the apps send it. One of a place, a city (with the map's view, when asked from there). */
export interface AskAreaInput {
  placeId?: string;
  city?: string;
  /** The part of the map on screen: only its middle, on the ASK_AREA_METRES grid, is kept. */
  box?: MapBox;
}

// ─── Words ──────────────────────────────────────────────────────────────

export const ASK_TOPIC_KEYS: Record<AskTopic, MessageKey> = {
  food: 'askCity.topic.food',
  traffic: 'askCity.topic.traffic',
  services: 'askCity.topic.services',
  safety: 'askCity.topic.safety',
  events: 'askCity.topic.events',
  shopping: 'askCity.topic.shopping',
  other: 'askCity.topic.other',
};

export const ASK_EXPIRY_KEYS: Record<AskExpiry, MessageKey> = {
  '1h': 'location.duration.60',
  today: 'm.picker.today',
  week: 'askCity.expiry.week',
};

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

const ASK_NOTICES = ['ask_nearby', 'ask_helpful'] as const;

/** Notifications about Ask the city, in the reader's language, or null for other kinds. */
export function askNoticeText(n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> }, t: Tr): string | null {
  switch (n.type) {
    case 'ask_nearby': {
      const topic = ASK_TOPIC_KEYS[n.data.topic as AskTopic];
      return t('push.ask_nearby', { area: String(n.data.area ?? ''), topic: topic ? t(topic) : '' });
    }
    case 'ask_helpful':
      return t('push.ask_helpful', { name: n.actor?.displayName ?? '' });
    default:
      return null;
  }
}

/** The question an Ask the city notification opens (a post id), or null for other kinds. */
export function askNoticePost(n: { type: string; entityId?: string | null }): string | null {
  return (ASK_NOTICES as readonly string[]).includes(n.type) && n.entityId ? n.entityId : null;
}
