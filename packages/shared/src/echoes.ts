import type { MessageKey, PluralKey } from './i18n.ts';
import type { MediaItem, PublicUser } from './types.ts';

/**
 * Echoes: a reply to someone's reel with your own video, shown together in one new reel.
 *
 * You record (or pick) a video, choose how the two sit together (side by side, top and bottom, or
 * theirs small in a corner) and, if you like, a cut of up to 15 seconds of theirs that plays first
 * ("Echo after"). The API makes the combined video with ffmpeg from the frame below, so what the
 * preview shows is what gets posted; it's then processed and checked like any upload and posted
 * as a reel linked to the original, with a small "Echo of @name" in the corner.
 *
 * These are the pure parts both apps and the API share (no zod: the phone imports this file directly).
 */

/** 'side': side by side (theirs first). 'stack': top and bottom (theirs on top). 'corner': yours full, theirs small in a corner. */
export const ECHO_LAYOUTS = ['side', 'stack', 'corner'] as const;
export type EchoLayout = (typeof ECHO_LAYOUTS)[number];

/** Who may echo a reel: everyone who can see it, people the author follows, or nobody. */
export const ECHO_PERMISSIONS = ['everyone', 'following', 'nobody'] as const;
export type EchoPermission = (typeof ECHO_PERMISSIONS)[number];

/** "Echo after": the cut of their reel that plays first is 1 to 15 seconds long. */
export const ECHO_CUT_MIN_MS = 1_000;
export const ECHO_CUT_MAX_MS = 15_000;
/** Your video is at least this long. */
export const ECHO_MIN_MS = 1_000;
/** The whole echo (the cut, then both together) is at most as long as a reel: 3 minutes. */
export const ECHO_MAX_MS = 180_000;
/** 0 is only their sound, 100 only yours; 50 is both as loud. */
export const ECHO_BALANCE_DEFAULT = 50;

/**
 * What is heard of their reel in an echo:
 * - 'mixed': their audio, with yours, at the balance you chose;
 * - 'muted': you turned their sound off;
 * - 'song': their catalogue song plays with your echo (its licence allows it);
 * - 'dropped': their song's licence doesn't allow it, so the echo keeps only your audio (and says so);
 * - 'none': their reel has no sound to use.
 */
export type EchoTheirAudio = 'mixed' | 'muted' | 'song' | 'dropped' | 'none';

/** The default for a reel whose author never chose: everyone for public accounts, nobody for private and under-18 accounts. */
export function defaultEchoPermission(author: { isPrivate: boolean; minor: boolean }): EchoPermission {
  return author.isPrivate || author.minor ? 'nobody' : 'everyone';
}

/** How loud each side is (0 to 1) for a balance of 0 (only theirs) to 100 (only yours). */
export function echoVolumes(balance: number, theirsMuted = false): { theirs: number; yours: number } {
  const b = Math.min(100, Math.max(0, Math.round(Number.isFinite(balance) ? balance : ECHO_BALANCE_DEFAULT)));
  return { theirs: theirsMuted ? 0 : Math.min(1, (100 - b) / 50), yours: Math.min(1, b / 50) };
}

export interface EchoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EchoFrame {
  width: number;
  height: number;
  /** Where their reel goes (in the corner layout: inside a white edge `border` wide). */
  theirs: EchoRect;
  yours: EchoRect;
  border: number;
  /** The top left of the "Echo of @name" credit, and its text size. */
  credit: { x: number; y: number; size: number };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The echo's frame for a layout, in pixels. Side by side is 720 × 640 (two 9:16 halves); top and
 * bottom and the corner are 720 × 1280. Each video fills its place (cropped to fit, never stretched).
 * Previews use the same numbers as fractions of the frame.
 */
export function echoFrame(layout: EchoLayout): EchoFrame {
  const width = 720;
  const height = layout === 'side' ? 640 : 1280;
  const margin = even(width * 0.04);
  const credit = { x: margin, y: even(height * 0.09), size: even(width * 0.034) };
  if (layout === 'side') {
    const half = width / 2;
    return { width, height, theirs: { x: 0, y: 0, width: half, height }, yours: { x: half, y: 0, width: half, height }, border: 0, credit };
  }
  if (layout === 'stack') {
    const half = height / 2;
    return { width, height, theirs: { x: 0, y: 0, width, height: half }, yours: { x: 0, y: half, width, height: half }, border: 0, credit };
  }
  const w = even(width * 0.34);
  const h = even((w * 16) / 9);
  return {
    width,
    height,
    yours: { x: 0, y: 0, width, height },
    theirs: { x: width - margin - w, y: even(height * 0.1), width: w, height: h },
    border: 4,
    credit,
  };
}

/** A rectangle as shares of the frame (0 to 1), for previews drawn with percentages. */
export function echoShare(r: EchoRect, frame: { width: number; height: number }) {
  return { left: r.x / frame.width, top: r.y / frame.height, width: r.width / frame.width, height: r.height / frame.height };
}

/** Why a reel can't be echoed by you. */
export type EchoBlock =
  /** Only reels can be echoed. */
  | 'not_reel'
  /** Echoes can't be echoed. */
  | 'echo'
  /** Only reels shared publicly, with followers or with friends. */
  | 'audience'
  /** Subscriber-only reels. */
  | 'subscribers'
  /** Reels marked sensitive, or waiting for a moderator. */
  | 'sensitive'
  /** The video is still being checked. */
  | 'processing'
  /** The creator allows echoes from nobody (or not from you). */
  | 'nobody'
  /** Only people the creator follows. */
  | 'following'
  /** The video file can't be used. */
  | 'unavailable';

export const ECHO_BLOCK_KEYS: Record<EchoBlock, MessageKey> = {
  not_reel: 'echo.block.not_reel',
  echo: 'echo.block.echo',
  audience: 'echo.block.audience',
  subscribers: 'echo.block.subscribers',
  sensitive: 'echo.block.sensitive',
  processing: 'echo.block.processing',
  nobody: 'echo.block.nobody',
  following: 'echo.block.following',
  unavailable: 'echo.block.unavailable',
};

/** What the Echo screen needs to know about the reel you're answering (GET /v1/posts/:id/echo). */
export interface EchoOptions {
  canEcho: boolean;
  reason: EchoBlock | null;
  original: {
    id: string;
    author: PublicUser;
    body: string;
    /** Their video, for the preview and for picking the cut. */
    media: MediaItem | null;
    durationMs: number | null;
  };
  /** What would be heard of their reel ('muted' is your choice, made when you echo). */
  theirAudio: Exclude<EchoTheirAudio, 'muted'>;
  /** Their catalogue song, when there is one. */
  song: { title: string; artist: string } | null;
}

/** An echo video you asked for (POST /v1/posts/:id/echoes), while it's made and once it's ready to post. */
export interface EchoRender {
  id: string;
  status: 'queued' | 'rendering' | 'ready' | 'failed';
  error: string | null;
  layout: EchoLayout;
  theirAudio: EchoTheirAudio;
  originalId: string | null;
  /** The combined video (ready once status is 'ready'): post it with posts.create({ format: 'reel', echo: id, media: [it] }). */
  media: { id: string; url: string; posterUrl: string | null; width: number | null; height: number | null; durationMs: number | null } | null;
  /** Set once it was posted. */
  postId: string | null;
  createdAt: string;
}

/** On an echo reel: the reel it answers, while the viewer can see it (always shown to the echo's author, as `post: null` once it's gone). */
export interface EchoRef {
  post: { id: string; author: PublicUser } | null;
  layout: EchoLayout;
  theirAudio: EchoTheirAudio;
}

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;
type TrPlural = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

/** "Ada echoed your reel", or "Ada and 3 others echoed your reel" (echoes of one reel are batched), or null for other kinds. */
export function echoNoticeText(n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> }, t: Tr, tp: TrPlural): string | null {
  if (n.type !== 'reel_echo') return null;
  const name = n.actor?.displayName ?? '';
  const others = Math.max(0, (Number(n.data.count ?? 1) || 1) - 1);
  return others ? tp('echo.notif.others', others, { name }) : t('echo.notif', { name });
}
