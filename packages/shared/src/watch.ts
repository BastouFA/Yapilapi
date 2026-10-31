import { ROOM_REACTIONS, type RoomReaction } from './constants.ts';
import type { MediaItem, Post, PublicUser } from './types.ts';

/**
 * Watch together: people in a chat watch reels and video posts at the same time.
 *
 * The API keeps one shared playback: the item on screen, whether it plays, and its position
 * at a moment of the server's clock. Every change (play, pause, seek, next) gets a higher
 * `seq`, so a player drops updates that arrive late. While it plays, the host's player sends
 * its own position every few seconds (the host clock); everyone else works out where the video
 * should be now and corrects small drift by playing a little faster or slower, and large drift
 * by seeking. Each player estimates how far its clock is from the server's from the round trip
 * of its requests (latency compensation).
 */

/** Everyone in the chat, the person starting included. */
export const WATCH_MAX_MEMBERS = 8;
/** Items waiting in a queue at once. */
export const WATCH_QUEUE_MAX = 50;
/** Players send a heartbeat this often; the host's carries its position. */
export const WATCH_HEARTBEAT_MS = 5_000;
/** Someone not seen for this long has left. */
export const WATCH_PRESENCE_SECONDS = 45;
/** Reactions: names from the design-system icon set, never emoji (the same set as audio rooms). */
export const WATCH_REACTIONS = ROOM_REACTIONS;
export type WatchReaction = RoomReaction;
/** Drift up to this is left alone. */
export const WATCH_DRIFT_OK_MS = 300;
/** Drift past this is fixed by seeking; in between, the player speeds up or slows down a little. */
export const WATCH_DRIFT_SEEK_MS = 2_000;
/** The most the playback rate moves while catching up (0.92 to 1.08). */
export const WATCH_MAX_RATE_NUDGE = 0.08;
/** Players that can't change their rate smoothly (YouTube's) fix drift past this by seeking. */
export const WATCH_DRIFT_SEEK_NO_RATE_MS = 1_200;
/** A photo stays on screen this long while playing, then the queue moves on (pausing keeps it up). */
export const WATCH_PHOTO_MS = 8_000;
/**
 * Starting again in a chat within this many minutes of your own session ending, when nobody else
 * joined it, opens that session again (the same line in the chat, nobody told twice). The line of
 * a session nobody else joined leaves the chat once this time has passed.
 */
export const WATCH_REOPEN_MINUTES = 10;
/** Uploads or links added at once. */
export const WATCH_ADD_MAX = 10;

/** Why an item didn't go in the queue, or was passed over when its turn came. */
export type WatchSkipReason = 'not_visible' | 'unavailable' | 'not_video' | 'already_queued' | 'queue_full';

/** A YouTube video in the queue: its id, and the title and picture YouTube gives for it. */
export interface WatchYouTube {
  /** YouTube's 11-character video id. */
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
}

export interface WatchPlayback {
  /** The queue item on screen, or null before anything is added. */
  itemId: string | null;
  playing: boolean;
  /** Position at `at`. */
  positionMs: number;
  /** When `positionMs` was true, in server time (milliseconds since 1970). */
  at: number;
  /** Goes up by one on every play, pause, seek or change of item. */
  seq: number;
  /** Who made the last change (null for the server, or someone who has since gone). */
  by: string | null;
}

interface WatchQueueBase {
  id: string;
  addedBy: PublicUser | null;
  /** 'playing' is the item on screen (playing or paused). */
  status: 'queued' | 'playing';
}

/**
 * Something in the queue: a reel or video post (as you see it), a photo or video someone in the
 * chat added from their device (never posted; only the chat sees it), or a YouTube video.
 */
export type WatchQueueItem = WatchQueueBase &
  (
    | { kind: 'post'; post: Post }
    | {
        kind: 'upload';
        media: MediaItem;
        /**
         * Checked and ready to show. Uploads are checked (and videos made ready to stream) after
         * they arrive; until then players show "Getting it ready".
         */
        ready: boolean;
      }
    | { kind: 'youtube'; youtube: WatchYouTube }
  );

export interface WatchSession {
  id: string;
  conversationId: string;
  /** The chat's title, or null for one-to-one chats and untitled groups. */
  conversationTitle: string | null;
  status: 'active' | 'ended';
  hostId: string | null;
  startedBy: PublicUser;
  /** People watching now, the host first. */
  watching: PublicUser[];
  /** Everyone in the chat (up to 8), watching or not. */
  members: PublicUser[];
  /** You are watching (joined and haven't left). */
  joined: boolean;
  /** The item on screen and the ones still to come, in order. */
  queue: WatchQueueItem[];
  playback: WatchPlayback;
  /** The server's clock when this was read (milliseconds since 1970), for clock offset estimates. */
  serverTime: number;
  createdAt: string;
}

/** What a player shows in a chat while a session runs. */
export interface WatchSummary {
  id: string;
  conversationId: string;
  hostId: string | null;
  startedBy: PublicUser;
  watching: PublicUser[];
  joined: boolean;
  createdAt: string;
}

/** The result of adding to the queue: what went in, and what was skipped and why. */
export interface WatchQueueResult {
  session: WatchSession;
  added: string[];
  skipped: { postId?: string; mediaId?: string; videoId?: string; reason: WatchSkipReason }[];
}

// ─── Clock and drift ────────────────────────────────────────────────────

/**
 * How far the server's clock is ahead of this device's, from one request: sent at `sentAt`, the
 * answer (carrying `serverTime`) back at `receivedAt`, both on this device's clock. Assumes the
 * way there and back took as long.
 */
export function clockSample(sentAt: number, receivedAt: number, serverTime: number): { offset: number; rtt: number } {
  const rtt = Math.max(0, receivedAt - sentAt);
  return { offset: serverTime - (sentAt + rtt / 2), rtt };
}

/**
 * Keeps the best estimate: the sample with the shortest round trip is the least uncertain.
 * Older samples slowly lose their advantage so a clock that moved is picked up again.
 */
export function betterClock(
  current: { offset: number; rtt: number } | null,
  sample: { offset: number; rtt: number },
  agedBy = 0,
): { offset: number; rtt: number } {
  if (!current) return sample;
  return sample.rtt <= current.rtt + agedBy ? sample : current;
}

/** Where the video should be at server time `serverNow`, kept within its length when known. */
export function expectedPositionMs(p: Pick<WatchPlayback, 'playing' | 'positionMs' | 'at'>, serverNow: number, durationMs?: number | null): number {
  const pos = p.playing ? p.positionMs + Math.max(0, serverNow - p.at) : p.positionMs;
  const max = durationMs && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(pos, max));
}

export type DriftFix = { kind: 'none'; rate: 1 } | { kind: 'nudge'; rate: number } | { kind: 'seek'; toMs: number; rate: 1 };

/**
 * What a player does about the difference between where it is (`localMs`) and where it should
 * be (`expectedMs`): nothing when close, a slightly faster or slower rate when a little off, a
 * seek when far off. Paused players only ever seek. A player that can't change its rate
 * (`canNudge` false: YouTube's) seeks once the drift passes WATCH_DRIFT_SEEK_NO_RATE_MS.
 */
export function driftFix(localMs: number, expectedMs: number, playing = true, canNudge = true): DriftFix {
  const drift = expectedMs - localMs;
  const size = Math.abs(drift);
  if (size <= WATCH_DRIFT_OK_MS) return { kind: 'none', rate: 1 };
  if (!playing || size >= (canNudge ? WATCH_DRIFT_SEEK_MS : WATCH_DRIFT_SEEK_NO_RATE_MS))
    return { kind: 'seek', toMs: Math.max(0, Math.round(expectedMs)), rate: 1 };
  if (!canNudge) return { kind: 'none', rate: 1 };
  // Catch up over about four seconds, never faster or slower than the nudge limit.
  const nudge = Math.max(-WATCH_MAX_RATE_NUDGE, Math.min(WATCH_MAX_RATE_NUDGE, drift / 4_000));
  return { kind: 'nudge', rate: Math.round((1 + nudge) * 100) / 100 };
}

/**
 * Whether an incoming playback should replace the one a player has: a higher `seq` always does;
 * the same `seq` does when it's a newer reading of the same state (a host heartbeat).
 */
export function isNewerPlayback(incoming: Pick<WatchPlayback, 'seq' | 'at'>, current: Pick<WatchPlayback, 'seq' | 'at'> | null): boolean {
  if (!current) return true;
  return incoming.seq > current.seq || (incoming.seq === current.seq && incoming.at > current.at);
}

// ─── Links ──────────────────────────────────────────────────────────────

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/**
 * The YouTube video in a pasted link, or null: youtube.com/watch?v=…, youtu.be/…,
 * youtube.com/shorts/…, /live/… and /embed/… (with or without https://). Only YouTube's own
 * hosts and a well-formed 11-character id; anything else is not a YouTube link.
 */
export function youtubeIdFrom(text: string): string | null {
  const s = text.trim();
  if (!s || s.length > 500) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (YOUTUBE_HOSTS.has(host)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch' && parts.length === 1) id = u.searchParams.get('v');
    else if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') id = parts[1] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/** The address of a YouTube video on YouTube itself. */
export const youtubeWatchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

/** What a queue item is called: the post's author, the video's title, or who added the upload. */
export function watchItemName(item: WatchQueueItem, fallback: { youtube: string; upload: string }): string {
  if (item.kind === 'post') return item.post.author.displayName;
  if (item.kind === 'youtube') return item.youtube.title || fallback.youtube;
  return item.addedBy?.displayName || fallback.upload;
}
