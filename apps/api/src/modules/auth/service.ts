import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { randomToken, sha256Hex, hashPassword, verifyPassword } from '@yapilapi/security';
import { AppError, ADULT_AGE_YEARS } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { securityEvent } from '../../lib/audit.js';

export const VERIFY_TTL_HOURS = 48;
export const RESET_TTL_MINUTES = 60;
export const MFA_CHALLENGE_TTL_MINUTES = 10;
export const DELETION_GRACE_DAYS = 14;

// A valid hash of a random value, used to equalize timing when the account does not exist.
let dummyHash: Promise<string> | undefined;
export const timingDummy = () => (dummyHash ??= hashPassword(randomToken(16)));

export const ageBandFor = (age: number): 'teen' | 'adult' =>
  age >= ADULT_AGE_YEARS ? 'adult' : 'teen';

export async function issueOneTimeToken(
  ctx: AppContext,
  userId: string,
  purpose: 'verify_email' | 'reset_password' | 'cancel_deletion',
  ttlMs: number,
  db: Pick<PoolClient, 'query'> = ctx.db,
): Promise<string> {
  const token = randomToken(32);
  // Only the newest token of a purpose is valid.
  await db.query(
    `UPDATE one_time_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  await db.query(
    `INSERT INTO one_time_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' milliseconds')::interval)`,
    [userId, purpose, sha256Hex(token), String(ttlMs)],
  );
  return token;
}

/** Atomically consume a token; returns the user id or throws. Single use, expiry enforced in SQL. */
export async function consumeOneTimeToken(
  ctx: AppContext,
  token: string,
  purpose: 'verify_email' | 'reset_password' | 'cancel_deletion',
  db: Pick<PoolClient, 'query'> = ctx.db,
): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE one_time_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256Hex(token), purpose],
  );
  if (!rows[0]) throw new AppError('validation_failed', 'This link is invalid or has expired');
  return rows[0].user_id;
}

export async function sendVerificationEmail(
  ctx: AppContext,
  userId: string,
  email: string,
): Promise<void> {
  const token = await issueOneTimeToken(ctx, userId, 'verify_email', VERIFY_TTL_HOURS * 3_600_000);
  await ctx.email.send({
    to: email,
    subject: 'Verify your YAPILAPI email',
    text: `Welcome to YAPILAPI.\n\nVerify your email: ${ctx.config.WEB_PUBLIC_URL}/verify-email?token=${token}\n\nThis link expires in ${VERIFY_TTL_HOURS} hours. If you did not sign up, ignore this message.`,
  });
}

export async function sendResetEmail(
  ctx: AppContext,
  userId: string,
  email: string,
): Promise<void> {
  const token = await issueOneTimeToken(ctx, userId, 'reset_password', RESET_TTL_MINUTES * 60_000);
  await ctx.email.send({
    to: email,
    subject: 'Reset your YAPILAPI password',
    text: `Reset your password: ${ctx.config.WEB_PUBLIC_URL}/reset-password?token=${token}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes. If you did not request it, you can ignore this email; your password will not change.`,
  });
}

export async function revokeSessions(
  ctx: AppContext,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const r = await ctx.db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
    [userId, exceptSessionId ?? null],
  );
  return r.rowCount ?? 0;
}

/** Record a failed login and apply escalating lockout (15m, 30m, 1h... capped at 24h). */
export async function recordFailedLogin(
  ctx: AppContext,
  userId: string,
  req: FastifyRequest,
): Promise<void> {
  const { rows } = await ctx.db.query<{ failed_login_count: number }>(
    `UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1 RETURNING failed_login_count`,
    [userId],
  );
  const count = rows[0]?.failed_login_count ?? 0;
  await securityEvent(ctx, userId, 'login_failed', req, { count });
  if (count >= 5 && count % 5 === 0) {
    const minutes = Math.min(15 * 2 ** (count / 5 - 1), 1440);
    await ctx.db.query(
      `UPDATE users SET locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
      [userId, String(minutes)],
    );
    await securityEvent(ctx, userId, 'account_locked', req, { minutes });
  }
}

export async function verifyUserPassword(
  ctx: AppContext,
  userId: string,
  password: string,
): Promise<boolean> {
  const { rows } = await ctx.db.query<{ password_hash: string | null }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  const hash = rows[0]?.password_hash;
  if (!hash) {
    await verifyPassword(password, await timingDummy());
    return false;
  }
  return verifyPassword(password, hash);
}
