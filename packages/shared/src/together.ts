import { ROOM_REACTIONS, type RoomReaction } from './constants.ts';
import type { MessageKey, PluralKey } from './i18n.ts';
import type { MediaItem, PublicUser } from './types.ts';

/**
 * Together: a shared album for a trip, a wedding, a party or an event.
 *
 * The people in it (a host, co-hosts and members) add photos and videos while it's open, each
 * labelled with when it was taken. Everyone in it can star what they love, react and leave short
 * comments; the best of it is picked from those stars and reactions. When it closes, it becomes
 * something to look back on: a recap video, a post of your own photos, or a chapter.
 *
 * Only the people in an album ever see it. These are the pure parts both apps and the API share
 * (no zod: the phone imports this file directly).
 */

export const TOGETHER_TITLE_MAX = 80;
export const TOGETHER_DESCRIPTION_MAX = 500;
export const TOGETHER_CAPTION_MAX = 300;
export const TOGETHER_COMMENT_MAX = 280;
/** Photos and videos added in one go. */
export const TOGETHER_ADD_BATCH = 20;
/** Photos and videos in one album. */
export const TOGETHER_ITEMS_MAX = 1000;
/** People in one album, the host included. */
export const TOGETHER_MEMBERS_MAX = 250;
/** How many items the best of holds. */
export const TOGETHER_BEST_MAX = 12;
/** A post made from an album holds up to this many of your photos (the carousel limit). */
export const TOGETHER_POST_MAX = 10;
/** "Ada added 12 photos": at most one of these per album, per person who adds, per this many minutes. */
export const TOGETHER_ADDED_NOTICE_MINUTES = 30;
/** Members hear that an album is closing this long before it does. */
export const TOGETHER_CLOSING_NOTICE_MINUTES = 60;
/** An album can stay open for adding at most this long at a time. */
export const TOGETHER_MAX_OPEN_DAYS = 60;
/** The shortest window: an album closing sooner than this from now is refused. */
export const TOGETHER_MIN_OPEN_MINUTES = 10;
/** Reactions: icon names from the design system (the room set), never emoji. */
export const TOGETHER_REACTIONS = ROOM_REACTIONS;
export type TogetherReaction = RoomReaction;

/** When an album is open for adding. 'open': until a host closes it. */
export const TOGETHER_WINDOWS = ['tonight', 'day', 'weekend', 'week', 'custom', 'open'] as const;
export type TogetherWindow = (typeof TOGETHER_WINDOWS)[number];

export type TogetherRole = 'host' | 'cohost' | 'member';
export type TogetherStatus = 'open' | 'closed';

/** The three ways to look at an album. */
export const TOGETHER_VIEWS = ['moments', 'people', 'grid'] as const;
export type TogetherView = (typeof TOGETHER_VIEWS)[number];

// ── Shapes the API returns ────────────────────────────────────────────────

export interface TogetherCover {
  /** A small picture for cards (a photo's thumbnail, a video's poster). */
  thumbUrl: string | null;
  /** A larger picture for the album's header. */
  url: string | null;
  kind: 'image' | 'video';
}

/** An album in your list. */
export interface TogetherSummary {
  id: string;
  title: string;
  description: string;
  status: TogetherStatus;
  /** When it closes for adding; null while it's open until a host closes it (or once closed). */
  closesAt: string | null;
  closedAt: string | null;
  createdAt: string;
  cover: TogetherCover | null;
  itemCount: number;
  memberCount: number;
  myRole: TogetherRole;
  host: PublicUser;
  eventId: string | null;
  conversationId: string | null;
  /** People asking to join (hosts only; 0 for everyone else). */
  requestCount: number;
  lastAddedAt: string | null;
}

export interface TogetherReactionCount {
  kind: TogetherReaction;
  count: number;
  mine: boolean;
}

/** A photo or video in an album. */
export interface TogetherItem {
  id: string;
  media: MediaItem & { kind: 'image' | 'video'; durationMs: number | null; processing: boolean };
  caption: string;
  /** When it was taken: from the file's date when the app knew it, else when it was added. */
  takenAt: string;
  /** Whether takenAt came from the file. */
  takenFromFile: boolean;
  addedAt: string;
  author: PublicUser;
  mine: boolean;
  stars: number;
  starred: boolean;
  reactions: TogetherReactionCount[];
  comments: number;
  /** In the best of. */
  best: boolean;
  /** A file name for saving it. */
  fileName: string;
}

export interface TogetherMember {
  user: PublicUser;
  role: TogetherRole;
  /** Photos and videos they added. */
  items: number;
}

export interface TogetherDetail extends TogetherSummary {
  members: TogetherMember[];
  /** Oldest first, by when they were taken. */
  items: TogetherItem[];
  /** The best of, oldest first (item ids). */
  bestOf: string[];
  /** Hosts only: the invite link's code, and whether the link works now. */
  invite: { code: string | null; enabled: boolean } | null;
  /** You may add now (it's open). */
  canAdd: boolean;
  /** You may change it, approve requests and remove anyone's items. */
  canManage: boolean;
  event: { id: string; title: string; startsAt: string } | null;
}

export interface TogetherComment {
  id: string;
  body: string;
  author: PublicUser;
  createdAt: string;
  mine: boolean;
  /** Yours, or you're a host. */
  canDelete: boolean;
}

export interface TogetherJoinRequest {
  user: PublicUser;
  createdAt: string;
  /** Friends with the host looking at it. */
  friend: boolean;
}

/** What someone with an invite link sees before they're in: no photos, only what the album is. */
export interface TogetherInvitePreview {
  id: string;
  title: string;
  description: string;
  host: PublicUser;
  memberCount: number;
  itemCount: number;
  status: TogetherStatus;
  state: 'member' | 'requested' | 'declined' | 'none';
}

/** Adding people: who went in, and how many couldn't (blocks, age rules, already in). */
export interface TogetherAddResult {
  added: number;
  skipped: number;
}

// ── When it closes ────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/** The next 04:00 (local time) at least `minAhead` ms from `now`. */
function nextFourAm(now: Date, minAhead: number, weekday?: number): Date {
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  for (let i = 0; i < 15; i++) {
    if (d.getTime() - now.getTime() >= minAhead && (weekday === undefined || d.getDay() === weekday)) return d;
    d.setDate(d.getDate() + 1);
    d.setHours(4, 0, 0, 0);
  }
  return d;
}

/**
 * When an album chosen with `window` closes, in the device's time zone. Tonight runs to 4 in the
 * morning (parties go late); a weekend to 4 on Monday morning; a day and a week from now.
 * 'custom' uses `custom`; 'open' has no end (null).
 */
export function togetherClosesAt(window: TogetherWindow, now = new Date(), custom?: Date | null): Date | null {
  switch (window) {
    case 'tonight':
      return nextFourAm(now, 2 * HOUR);
    case 'day':
      return new Date(now.getTime() + 24 * HOUR);
    case 'weekend':
      return nextFourAm(now, 12 * HOUR, 1);
    case 'week':
      return new Date(now.getTime() + 7 * 24 * HOUR);
    case 'custom':
      return custom ?? null;
    case 'open':
      return null;
  }
}

/** Whether a chosen closing time is allowed: at least a few minutes away, and within the longest window. */
export function togetherClosesAtOk(at: Date, now = new Date()): boolean {
  const ms = at.getTime() - now.getTime();
  return ms >= TOGETHER_MIN_OPEN_MINUTES * 60_000 && ms <= TOGETHER_MAX_OPEN_DAYS * 24 * HOUR;
}

// ── Moments: grouped by day and time of day ───────────────────────────────

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

/**
 * The part of the day a time falls in, and the day it belongs to (local time). The small hours
 * belong to the night before: 1 a.m. on Sunday is still "Saturday night".
 */
export function dayPartOf(at: Date): { part: DayPart; day: Date } {
  const h = at.getHours();
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  if (h < 5) {
    day.setDate(day.getDate() - 1);
    return { part: 'night', day };
  }
  return { part: h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night', day };
}

export interface MomentGroup<T> {
  /** Stable across renders: the day and the part. */
  key: string;
  day: Date;
  part: DayPart;
  items: T[];
}

/** Items (already oldest first) in runs of the same day and part of the day, like "Saturday evening". */
export function momentGroups<T extends { takenAt: string }>(items: T[]): MomentGroup<T>[] {
  const out: MomentGroup<T>[] = [];
  for (const item of items) {
    const { part, day } = dayPartOf(new Date(item.takenAt));
    const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}-${part}`;
    const last = out.at(-1);
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, day, part, items: [item] });
  }
  return out;
}

/**
 * The day in a moment's heading: the weekday ("Saturday") when the album's moments fit in a
 * week, else a short date ("Sat 12 Oct"), with the year when it isn't this year.
 */
export function momentDayLabel(day: Date, locale: string, groups: { day: Date }[], now = new Date()): string {
  const first = groups[0]?.day ?? day;
  const last = groups.at(-1)?.day ?? day;
  const withinWeek = last.getTime() - first.getTime() < 6.5 * 24 * HOUR;
  try {
    if (withinWeek) return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(day);
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
    }).format(day);
  } catch {
    return day.toDateString();
  }
}

// ── People: grouped by who added them ─────────────────────────────────────

export interface PeopleGroup<T> {
  user: PublicUser;
  items: T[];
}

/** Items by who added them: the people who added most first, then by name. */
export function peopleGroups<T extends { author: PublicUser }>(items: T[]): PeopleGroup<T>[] {
  const map = new Map<string, PeopleGroup<T>>();
  for (const item of items) {
    const g = map.get(item.author.id);
    if (g) g.items.push(item);
    else map.set(item.author.id, { user: item.author, items: [item] });
  }
  return [...map.values()].sort((a, b) => b.items.length - a.items.length || a.user.displayName.localeCompare(b.user.displayName));
}

// ── The best of ───────────────────────────────────────────────────────────

export interface BestOfCandidate {
  id: string;
  authorId: string;
  stars: number;
  /** Reactions of any kind. */
  reactions: number;
  takenAt: string;
}

/** A star counts more than a reaction: it's someone saying "this one". */
export const bestScore = (c: BestOfCandidate) => c.stars * 3 + c.reactions;

/**
 * The best of an album: items someone starred or reacted to, highest score first (more stars,
 * then taken earlier, break ties). Nobody's photos take over: in a first pass each person has at
 * most a third of the places; places left over go to the next best of anyone. Returned oldest
 * first, the way the album tells the story.
 */
export function pickBestOf(items: BestOfCandidate[], max = TOGETHER_BEST_MAX): string[] {
  const ranked = items
    .filter((c) => bestScore(c) > 0)
    .sort((a, b) => bestScore(b) - bestScore(a) || b.stars - a.stars || a.takenAt.localeCompare(b.takenAt) || a.id.localeCompare(b.id));
  const cap = Math.max(1, Math.ceil(max / 3));
  const picked = new Set<string>();
  const perAuthor = new Map<string, number>();
  for (const c of ranked) {
    if (picked.size >= max) break;
    const n = perAuthor.get(c.authorId) ?? 0;
    if (n >= cap) continue;
    picked.add(c.id);
    perAuthor.set(c.authorId, n + 1);
  }
  for (const c of ranked) {
    if (picked.size >= max) break;
    picked.add(c.id);
  }
  const order = new Map(items.map((c) => [c.id, c.takenAt]));
  return [...picked].sort((a, b) => order.get(a)!.localeCompare(order.get(b)!) || a.localeCompare(b));
}

/** A file name for saving an item: the album's title in plain letters, and the item. */
export function togetherFileName(title: string, itemId: string, kind: 'image' | 'video', url?: string | null): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
  const ext = /\.(jpe?g|png|webp|gif|heic|mp4|mov|webm)(?:$|\?)/i.exec(url ?? '')?.[1]?.toLowerCase() ?? (kind === 'video' ? 'mp4' : 'jpg');
  return `${slug || 'together'}-${itemId.slice(0, 8)}.${ext}`;
}

// ── Notifications ─────────────────────────────────────────────────────────

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;
type TrPlural = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

/**
 * What a Together notification says, as a whole sentence in the reader's language (both apps
 * use this), or null for other kinds. "Added" ones count what came in the last half hour;
 * stars are batched ("Ada and 2 others starred your photos in Lagos weekend").
 */
export function togetherNoticeText(
  n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> },
  t: Tr,
  tp: TrPlural,
): string | null {
  if (!n.type.startsWith('together_')) return null;
  const name = n.actor?.displayName ?? '';
  const title = String(n.data.title ?? '');
  const count = Math.max(1, Number(n.data.count ?? 1) || 1);
  switch (n.type) {
    case 'together_invite':
      return title ? t('together.notif.invite', { name, title }) : t('m.notif.togetherInvite', { name });
    case 'together_added': {
      const videos = Number(n.data.videos ?? 0) || 0;
      if (!videos) return tp('together.notif.addedPhotos', count, { name, title });
      if (videos >= count) return tp('together.notif.addedVideos', count, { name, title });
      return t('together.notif.addedMixed', { name, title, count });
    }
    case 'together_starred':
      return count > 1 ? tp('together.notif.starredOthers', count - 1, { name, title }) : t('together.notif.starred', { name, title });
    case 'together_closing':
      return t('together.notif.closing', { title });
    case 'together_closed':
      return t('together.notif.closed', { title });
    case 'together_request':
      return t('together.notif.request', { name, title });
    case 'together_approved':
      return t('together.notif.approved', { title });
  }
  return null;
}
