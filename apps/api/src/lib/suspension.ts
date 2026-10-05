import type { Pool, PoolClient } from 'pg';
import { hashToken, newToken } from '@yapilapi/auth';
import { t } from '@yapilapi/shared/i18n';
import { AppError } from './errors.ts';
import { deliverable, linkOrigin, userLocale, type EmailSender } from './email.ts';

type Q = Pool | PoolClient;

/**
 * Suspended accounts. A suspended person can't sign in, so they can't see the decision in the app
 * or appeal it from Settings like any other decision. Instead they get an email, and signing in
 * with the right password gives them a short-lived token that can only send an appeal against
 * the suspension (POST /v1/appeals/suspension). A different moderator reviews it, as always.
 */

/** How long the appeal token from the sign-in page lasts. */
const APPEAL_TOKEN_MINUTES = 30;

/** The latest suspension decided about this person, if any. */
async function suspensionCase(db: Q, userId: string) {
  const { rows } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM moderation_cases WHERE subject_user_id = $1 AND decision = 'suspend_user' AND status IN ('decided', 'appealed', 'final')
     ORDER BY decided_at DESC NULLS LAST LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * The error a suspended account gets when it signs in with the right password: with a token to
 * appeal when the suspension can still be appealed, or saying the appeal is waiting.
 */
export async function suspendedError(db: Q, userId: string): Promise<AppError> {
  const mc = await suspensionCase(db, userId);
  if (mc?.status === 'decided') {
    const { token, hash } = newToken();
    await db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'appeal', $2, now() + make_interval(mins => $3::int))`, [
      userId,
      hash,
      APPEAL_TOKEN_MINUTES,
    ]);
    return new AppError(403, 'account_suspended', 'This account is suspended. If you think we got this wrong, you can appeal.', {
      appeal: { token, status: 'none' },
    });
  }
  if (mc?.status === 'appealed')
    return new AppError(403, 'account_suspended', 'This account is suspended. Your appeal is waiting for a different moderator.', {
      appeal: { status: 'open' },
    });
  return new AppError(403, 'account_suspended', 'This account is suspended.');
}

/** The account a sign-in page appeal token belongs to (the token works once). */
export async function redeemAppealToken(c: Q, token: string): Promise<string | null> {
  const { rows } = await c.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = 'appeal' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [hashToken(token)],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * Email someone about their suspension, or the answer to their appeal against it, in their
 * language. A mail server that is down doesn't undo the decision.
 */
export async function emailSuspension(
  db: Q,
  email: EmailSender,
  webOrigin: string,
  userId: string,
  kind: 'suspended' | 'upheld' | 'overturned',
  onError: (err: Error) => void,
): Promise<void> {
  const { rows } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const to = rows[0]?.email;
  if (!deliverable(to)) return;
  const locale = await userLocale(db, userId);
  const url = `${linkOrigin(webOrigin)}/login`;
  await email.send({ to, subject: t(`email.suspension.${kind}.subject`, locale), text: t(`email.suspension.${kind}.body`, locale, { url }) }).catch(onError);
}
