import { z } from 'zod';

/**
 * Reels, beyond the video itself: moment comments (anchored to a time), the creator's
 * highlights (named points on the scrubber), playback speeds and "continue where I left off".
 * Shared by the API (validation), the web viewer and the mobile app.
 */

/** The longest reel anyone can post (Plus: 10 minutes). Moment and highlight times stay under it. */
export const REEL_LONGEST_MS = 600_000;
/** A creator marks at most this many highlights in a reel. */
export const REEL_HIGHLIGHTS_MAX = 5;
export const REEL_HIGHLIGHT_LABEL_MAX = 40;
/** Two highlights are at least this far apart, so their ticks never sit on top of each other. */
export const REEL_HIGHLIGHT_GAP_MS = 1000;
/** Playback speeds offered in the viewer. */
export const REEL_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type ReelSpeed = (typeof REEL_SPEEDS)[number];
/**
 * Continue where I left off: a position is kept once someone has watched this far into a reel
 * and hasn't reached the last stretch of it (see resumeWorthKeeping).
 */
export const REEL_RESUME_MIN_MS = 3000;
export const REEL_RESUME_END_MS = 2000;
/** Moment comments shown as bubbles on the scrubber (the most liked first). */
export const REEL_MOMENTS_MAX = 60;

export interface ReelHighlight {
  atMs: number;
  label: string;
}

/** A comment anchored to a time in a reel, for the bubbles on the scrubber. */
export interface ReelMoment {
  id: string;
  atMs: number;
  body: string;
  author: { id: string; username: string; displayName: string; avatarUrl: string | null };
  likes: number;
}

const highlight = z.object({
  atMs: z.number().int().min(0).max(REEL_LONGEST_MS),
  label: z.string().trim().min(1).max(REEL_HIGHLIGHT_LABEL_MAX),
});

/** A reel's highlights: up to five, at least a second apart. Sent in any order; kept in time order. */
export const reelHighlightsSchema = z
  .array(highlight)
  .max(REEL_HIGHLIGHTS_MAX)
  .transform((list) => [...list].sort((a, b) => a.atMs - b.atMs))
  .superRefine((list, ctx) => {
    for (let i = 1; i < list.length; i++)
      if (list[i]!.atMs - list[i - 1]!.atMs < REEL_HIGHLIGHT_GAP_MS)
        ctx.addIssue({ code: 'custom', message: 'Keep highlights at least a second apart.', path: [i, 'atMs'] });
  });

/** Where the viewer is in a reel, sent now and then while watching and when they leave. */
export const reelResumeSchema = z.object({
  positionMs: z.number().int().min(0).max(REEL_LONGEST_MS),
  /** The length the player saw, when it knows it (used when the server doesn't). */
  durationMs: z.number().int().positive().max(REEL_LONGEST_MS).optional(),
});

/** Whether a position is worth keeping: past the first few seconds and not at the very end. */
export function resumeWorthKeeping(positionMs: number, durationMs: number | null | undefined): boolean {
  if (positionMs < REEL_RESUME_MIN_MS) return false;
  if (durationMs && positionMs > durationMs - REEL_RESUME_END_MS) return false;
  return true;
}

/** "0:07", "1:12", "12:03": a time in a reel, as shown on the scrubber and on moment comments. */
export function formatReelTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
