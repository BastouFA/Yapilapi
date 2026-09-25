import { decodeCursor, encodeCursor, invalid } from '@yapilapi/shared';
import { z } from 'zod';

/** Tiny bind-parameter collector: every value goes through `$n`, nothing user-supplied is ever interpolated. */
export class P {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export interface ScoreCursor {
  s: number;
  id: string;
  snap: string;
}

/** Decode + validate a (score, id, snapshot) keyset cursor. */
export function readScoreCursor(raw: string | undefined): ScoreCursor | null {
  const c = decodeCursor<{ s: number; id: string; snap: string }>(raw);
  if (!c) return null;
  if (
    typeof c.s !== 'number' ||
    !Number.isFinite(c.s) ||
    typeof c.id !== 'string' ||
    !z.uuid().safeParse(c.id).success ||
    typeof c.snap !== 'string' ||
    Number.isNaN(Date.parse(c.snap))
  ) {
    throw invalid('Invalid cursor');
  }
  return c;
}

export function scoreCursorFor(
  last: { id: string; score: number } | undefined,
  snapshot: Date,
  hasMore: boolean,
): string | null {
  return hasMore && last
    ? encodeCursor({ s: last.score, id: last.id, snap: snapshot.toISOString() })
    : null;
}

/** Wrap an inner query that yields (id, score) with keyset paging. `p` must already hold the inner query's params. */
export function keysetScore(
  p: P,
  inner: string,
  cursor: ScoreCursor | null,
  limit: number,
  cols = 't.*',
): string {
  const cur = cursor
    ? `WHERE (t.score, t.id) < (${p.add(cursor.s)}::float8, ${p.add(cursor.id)}::uuid)`
    : '';
  return `SELECT ${cols} FROM (${inner}) t ${cur} ORDER BY t.score DESC, t.id DESC LIMIT ${p.add(limit + 1)}`;
}

export const roundScore = (expr: string) => `round((${expr})::numeric, 6)::float8`;

export const clip = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? '');

/** Things a viewer never wants suggested: muted users, hidden creators. Blocks are part of the visibility guards. */
export const notMutedOrHiddenSql = (V: string, userExpr: string) =>
  `NOT (${V} IS NOT NULL AND (
     EXISTS (SELECT 1 FROM user_mutes umx WHERE umx.muter_id = ${V} AND umx.muted_id = ${userExpr})
     OR EXISTS (SELECT 1 FROM recommendation_feedback rfx WHERE rfx.user_id = ${V} AND rfx.signal = 'hide_creator' AND rfx.creator_id = ${userExpr})))`;

/** Already connected to the viewer in any way that makes a "suggested" card pointless (follow in any state, friendship in any state). */
export const alreadyConnectedSql = (V: string, userExpr: string) =>
  `(${V} IS NOT NULL AND (
     EXISTS (SELECT 1 FROM follows fcx WHERE fcx.follower_id = ${V} AND fcx.followee_id = ${userExpr})
     OR EXISTS (SELECT 1 FROM friendships frx WHERE frx.user_low = LEAST(${V}, ${userExpr}) AND frx.user_high = GREATEST(${V}, ${userExpr}))))`;

export const listNames = (names: string[] | null | undefined, max = 3) => {
  const n = (names ?? []).filter(Boolean);
  return n.slice(0, max).join(', ') + (n.length > max ? ` and ${n.length - max} more` : '');
};
