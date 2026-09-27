import type { Pool, PoolClient } from 'pg';
import { ADULT_AGE, type PublicUser } from '@yapilapi/shared';
import { AppError } from './errors.ts';

type Q = Pool | PoolClient;

/** `plus` reads a column already on profiles, so the Plus badge costs no join. */
export const PUBLIC_USER_COLS = `pr.user_id AS id, pr.username, pr.display_name, pr.avatar_url, pr.mode, (pr.plus_until > now()) AS plus`;
/** The same Plus flag for queries that select prefixed profile columns: `${plusCol('a_')}` gives `a_plus`. */
export const plusCol = (prefix: string, alias = 'pr') => `(${alias}.plus_until > now()) AS ${prefix}plus`;

export interface PublicUserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  mode: PublicUser['mode'];
  plus?: boolean | null;
}

export function toPublicUser(r: PublicUserRow): PublicUser {
  return { id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, mode: r.mode, ...(r.plus ? { plus: true } : {}) };
}

/** Build a PublicUser from prefixed columns (e.g. author_username) on a joined row. */
export function publicUserFrom(row: Record<string, unknown>, prefix: string): PublicUser {
  return {
    id: row[`${prefix}id`] as string,
    username: row[`${prefix}username`] as string,
    displayName: row[`${prefix}display_name`] as string,
    avatarUrl: (row[`${prefix}avatar_url`] as string | null) ?? null,
    mode: row[`${prefix}mode`] as PublicUser['mode'],
    ...(row[`${prefix}plus`] ? { plus: true } : {}),
  };
}

export async function usersByIds(db: Q, ids: string[]): Promise<Map<string, PublicUser>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<PublicUserRow>(`SELECT ${PUBLIC_USER_COLS} FROM profiles pr WHERE pr.user_id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, toPublicUser(r)]));
}

export async function isBlockedEitherWay(db: Q, a: string, b: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`, [a, b]);
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

/** Age from a birth date that birthDateSchema already checked. */
export function checkBirthDate(birthDate: string): number {
  const age = ageOf(birthDate);
  if (age === null || Number.isNaN(age))
    throw new AppError(400, 'validation_failed', 'Enter a real date of birth.', { fields: { birthDate: 'Enter a real date of birth.' } });
  return age;
}

/** Protections for 13 to 17 year olds that are settings: a private account and no ad personalization. */
export async function applyMinorDefaults(db: Q, userId: string): Promise<void> {
  await db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [userId]);
  await db.query(
    `INSERT INTO consents (user_id, purpose, granted) VALUES ($1, 'advertising', false)
     ON CONFLICT (user_id, purpose) DO UPDATE SET granted = false, updated_at = now()`,
    [userId],
  );
}

/**
 * Selling, paid plans, payouts and receiving tips are for adults (creator and seller terms).
 * `self`: the person asking is the one who would be paid. Otherwise they are paying someone who can't be.
 */
export async function assertAdultForMoney(db: Q, userId: string, self = true): Promise<void> {
  const { rows } = await db.query<{ birth_date: Date | null }>(`SELECT birth_date FROM users WHERE id = $1`, [userId]);
  const age = ageOf(rows[0]?.birth_date ?? null);
  if (age !== null && age >= ADULT_AGE) return;
  if (!self) throw new AppError(403, 'recipient_not_eligible', "This person can't receive payments on YAPILAPI.");
  if (age === null) throw new AppError(403, 'birth_date_required', 'Add your date of birth to sell, get paid or receive tips. You need to be 18 or older.');
  throw new AppError(403, 'adults_only', 'You need to be 18 or older to sell, get paid or receive tips on YAPILAPI.');
}

/**
 * Whether a viewer is known to be 18 or older. Unknown ages (no birth date, or
 * not signed in) count as not adult, like the rule for posts waiting for review.
 */
export async function isAdultViewer(db: Q, viewer: string | null | undefined): Promise<boolean> {
  if (!viewer) return false;
  const { rows } = await db.query<{ adult: boolean }>(
    `SELECT coalesce(birth_date <= current_date - interval '18 years', false) AS adult FROM users WHERE id = $1`,
    [viewer],
  );
  return !!rows[0]?.adult;
}
