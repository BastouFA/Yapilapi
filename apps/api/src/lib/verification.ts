import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.ts';
import { AppError } from './errors.ts';

type Q = Pool | PoolClient;

export type GatedAction = 'post' | 'message' | 'live';

const WHY: Record<GatedAction, string> = {
  post: 'Confirm your email or phone number to post publicly. You can do it in Settings, under Security. Posts for friends or only you work without it.',
  message: 'Confirm your email or phone number to message people you aren’t friends with yet. You can do it in Settings, under Security.',
  live: 'Confirm your email or phone number to go live. You can do it in Settings, under Security.',
};

/** A confirmed email or a confirmed phone number. */
export async function isVerified(db: Q, userId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT email_verified_at IS NOT NULL OR phone_verified_at IS NOT NULL AS ok FROM users WHERE id = $1`, [userId]);
  return !!rows[0]?.ok;
}

/**
 * Reaching people beyond your friends (public posts, messages to non-friends,
 * going live) needs a confirmed email or phone number when REQUIRE_VERIFICATION
 * is on. The error carries code `verification_required` so apps can show the prompt.
 */
export async function requireVerified(db: Q, config: Config, userId: string, action: GatedAction): Promise<void> {
  if (!config.REQUIRE_VERIFICATION) return;
  if (await isVerified(db, userId)) return;
  throw new AppError(403, 'verification_required', WHY[action], { action });
}
