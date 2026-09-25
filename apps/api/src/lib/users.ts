import type { Pool, PoolClient } from 'pg';
import type { PublicUser } from '@yapilapi/shared';

type Q = Pool | PoolClient;

export const PUBLIC_USER_COLS = `pr.user_id AS id, pr.username, pr.display_name, pr.avatar_url, pr.mode`;

export interface PublicUserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  mode: PublicUser['mode'];
}

export function toPublicUser(r: PublicUserRow): PublicUser {
  return { id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, mode: r.mode };
}

/** Build a PublicUser from prefixed columns (e.g. author_username) on a joined row. */
export function publicUserFrom(row: Record<string, unknown>, prefix: string): PublicUser {
  return {
    id: row[`${prefix}id`] as string,
    username: row[`${prefix}username`] as string,
    displayName: row[`${prefix}display_name`] as string,
    avatarUrl: (row[`${prefix}avatar_url`] as string | null) ?? null,
    mode: row[`${prefix}mode`] as PublicUser['mode'],
  };
}

export async function usersByIds(db: Q, ids: string[]): Promise<Map<string, PublicUser>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<PublicUserRow>(`SELECT ${PUBLIC_USER_COLS} FROM profiles pr WHERE pr.user_id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, toPublicUser(r)]));
}

export async function isBlockedEitherWay(db: Q, a: string, b: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b],
  );
  return !!r.rowCount;
}

export async function areFriends(db: Q, a: string, b: string): Promise<boolean> {
  const [x, y] = [a, b].sort();
  return !!(await db.query(`SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y])).rowCount;
}

/** Age in whole years, or null when unknown. */
export function ageOf(birthDate: Date | string | null, now = new Date()): number | null {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}
