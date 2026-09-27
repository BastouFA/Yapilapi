import { ROOM_REACTIONS, type RoomReaction } from './constants.ts';
import type { Post, PublicUser } from './types.ts';

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

/** Why an item didn't go in the queue, or was passed over when its turn came. */
export type WatchSkipReason = 'not_visible' | 'unavailable' | 'not_video' | 'already_queued' | 'queue_full';

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

export interface WatchQueueItem {
  id: string;
  /** The post as you see it. */
  post: Post;
  addedBy: PublicUser | null;
  /** 'playing' is the item on screen (playing or paused). */
  status: 'queued' | 'playing';
}

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
  skipped: { postId: string; reason: WatchSkipReason }[];
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
 * seek when far off. Paused players only ever seek.
 */
export function driftFix(localMs: number, expectedMs: number, playing = true): DriftFix {
  const drift = expectedMs - localMs;
  const size = Math.abs(drift);
  if (size <= WATCH_DRIFT_OK_MS) return { kind: 'none', rate: 1 };
  if (!playing || size >= WATCH_DRIFT_SEEK_MS) return { kind: 'seek', toMs: Math.max(0, Math.round(expectedMs)), rate: 1 };
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
