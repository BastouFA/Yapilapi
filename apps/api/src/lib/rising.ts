import type { Pool, PoolClient } from 'pg';
import { trendSql } from './post-stats.ts';

type Q = Pool | PoolClient;

/**
 * "Rising" (docs/product/post-stats.md): a post or reel whose momentum right now (post_stats.trend,
 * faded to now: likes, comments, saves, shares and finished watches of about the last six hours) is
 * in the top RISING.topShare of every post with momentum in the last RISING.windowHours, is at least
 * RISING.minMomentum, and has been seen by at least RISING.minViewers people (its view count).
 *
 * The cut-off (that percentile) is worked out at most once every RISING.refreshMs per API
 * instance, from the posts with momentum in the window (post_stats_trend_idx), so a feed page only
 * compares numbers it already reads.
 */
export const RISING = {
  topShare: 0.05,
  windowHours: 48,
  minMomentum: 5,
  minViewers: 20,
  refreshMs: 5 * 60_000,
} as const;

let cached: { value: number; at: number } | null = null;
let pending: Promise<number> | null = null;

/** The momentum a post needs right now to be Rising (never below RISING.minMomentum). */
export async function risingCutoff(db: Q): Promise<number> {
  if (cached && Date.now() - cached.at < RISING.refreshMs) return cached.value;
  pending ??= db
    .query<{ cutoff: number | null }>(
      `SELECT percentile_cont($1::float8) WITHIN GROUP (ORDER BY ${trendSql('now()')}) AS cutoff
       FROM post_stats ps WHERE ps.trend > 0 AND ps.trend_at > now() - make_interval(hours => $2)`,
      [1 - RISING.topShare, RISING.windowHours],
    )
    .then((r) => {
      const value = Math.max(RISING.minMomentum, Number(r.rows[0]?.cutoff ?? 0));
      cached = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Forget the cut-off, so the next feed works it out again (tests, and after big changes). */
export function resetRisingCutoff() {
  cached = null;
}

/** Whether a post with this momentum and these viewers is Rising, given the cut-off. */
export function isRising(momentum: number, viewers: number, cutoff: number): boolean {
  return momentum >= cutoff && viewers >= RISING.minViewers;
}
