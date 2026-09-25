import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import {
  decrypt,
  encrypt,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hmacSha256Hex,
  needsRehash,
  otpauthUri,
  randomToken,
  sha256Hex,
  verifyPassword,
  verifyTotp,
} from '@yapilapi/security';
import { withTransaction } from '@yapilapi/database';
import {
  AppError,
  RESERVED_USERNAMES,
  ageInYears,
  conflict,
  forbidden,
  invalid,
  MIN_AGE_YEARS,
  notFound,
  passwordProblem,
} from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { clearSessionCookie, createSession, setSessionCookie } from '../../lib/session.js';
import { audit, securityEvent } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import {
  changePasswordBody,
  deleteAccountBody,
  forgotBody,
  idParams,
  loginBody,
  mfaDisableBody,
  mfaEnableBody,
  mfaVerifyBody,
  registerBody,
  resetBody,
  tokenBody,
} from './schemas.js';
import {
  DELETION_GRACE_DAYS,
  MFA_CHALLENGE_TTL_MINUTES,
  ageBandFor,
  consumeOneTimeToken,
  recordFailedLogin,
  revokeSessions,
  sendResetEmail,
  sendVerificationEmail,
  timingDummy,
  verifyUserPassword,
} from './service.js';

const INVALID_CREDENTIALS = () =>
  new AppError(
    'unauthenticated',
    'Invalid email or password, or the account is temporarily locked',
  );

interface UserRow {
  id: string;
  email: string;
  email_verified_at: Date | null;
  password_hash: string | null;
  status: string;
  platform_role: string;
  age_band: string;
  locale: string;
  timezone: string;
  mfa_enabled: boolean;
  locked_until: Date | null;
  deletion_scheduled_for: Date | null;
}

const recoveryHash = (ctx: AppContext, code: string) =>
  hmacSha256Hex(
    ctx.config.dataEncryptionKey.toString('base64'),
    code.toLowerCase().replace(/\s/g, ''),
  );

async function selfView(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT u.id, u.email, u.email_verified_at IS NOT NULL AS email_verified, u.status, u.platform_role, u.age_band,
            u.locale, u.timezone, u.mfa_enabled, u.deletion_scheduled_for,
            p.username, p.display_name, p.avatar_url, p.mode, p.onboarding_completed_at IS NOT NULL AS onboarding_completed
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw notFound('User');
  return {
    id: r.id as string,
    email: r.email as string,
    emailVerified: r.email_verified as boolean,
    status: r.status as string,
    platformRole: r.platform_role as string,
    ageBand: r.age_band as string,
    locale: r.locale as string,
    timezone: r.timezone as string,
    mfaEnabled: r.mfa_enabled as boolean,
    deletionScheduledFor: (r.deletion_scheduled_for as Date | null)?.toISOString() ?? null,
    profile: {
      username: r.username as string,
      displayName: r.display_name as string,
      avatarUrl: r.avatar_url as string | null,
      mode: r.mode as string,
      onboardingCompleted: r.onboarding_completed as boolean,
    },
  };
}

async function startSession(
  ctx: AppContext,
  req: FastifyRequest,
  reply: Parameters<typeof setSessionCookie>[1],
  userId: string,
  opts: {
    mfaVerified: boolean;
    deliver: 'cookie' | 'token';
    deviceLabel?: string | undefined;
    firstSession?: boolean;
  },
) {
  const ua = req.headers['user-agent'] ?? '';
  const fingerprint = createHash('sha256').update(ua).digest('hex').slice(0, 32);
  const dev = await ctx.db.query<{ id: string; is_new: boolean }>(
    `INSERT INTO devices (user_id, fingerprint, label, platform) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen_at = now(), revoked_at = NULL
     RETURNING id, (xmax = 0) AS is_new`,
    [
      userId,
      fingerprint,
      opts.deviceLabel ?? ua.slice(0, 80),
      /iPhone|iPad|iOS/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'web',
    ],
  );
  const session = await createSession(ctx, {
    userId,
    mfaVerified: opts.mfaVerified,
    ip: req.clientIp,
    userAgent: ua,
    deviceId: dev.rows[0]!.id,
  });
  if (opts.deliver === 'cookie') setSessionCookie(ctx, reply, session.token, session.expiresAt);
  await ctx.db.query(
    'UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1',
    [userId],
  );
  await securityEvent(ctx, userId, 'login_success', req, { newDevice: dev.rows[0]!.is_new });
  if (dev.rows[0]!.is_new && !opts.firstSession) {
    const { rows } = await ctx.db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [userId],
    );
    void ctx.email
      .send({
        to: rows[0]!.email,
        subject: 'New sign-in to YAPILAPI',
        text: `We noticed a sign-in from a new device (${ua.slice(0, 80) || 'unknown'}). If this was not you, change your password and review your sessions in Settings > Security.`,
      })
      .catch(() => undefined);
  }
  return {
    token: opts.deliver === 'token' ? session.token : undefined,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export const authModule: ApiModule = {
  name: 'auth',
  register(app, ctx) {
    // ------------------------------------------------------------ register
    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/register',
      summary: 'Create an account',
      tags: ['auth'],
      auth: 'public',
      body: registerBody,
      rateLimit: { limit: 10, windowSec: 3600 },
      handler: async ({ req, reply, body }) => {
        const age = ageInYears(new Date(body.birthDate));
        if (age < MIN_AGE_YEARS)
          throw new AppError(
            'unprocessable',
            `You must be at least ${MIN_AGE_YEARS} to use YAPILAPI`,
          );
        if (age > 120) throw invalid('Invalid birth date');
        if (RESERVED_USERNAMES.has(body.username)) throw conflict('That username is not available');
        const problem = passwordProblem(body.password, [
          body.email.split('@')[0]!,
          body.username,
          body.displayName,
        ]);
        if (problem) throw invalid(problem);

        const band = ageBandFor(age);
        const hash = await hashPassword(body.password);
        let userId: string;
        try {
          userId = await withTransaction(ctx.db, async (tx) => {
            const u = await tx.query<{ id: string }>(
              `INSERT INTO users (email, password_hash, birth_date, age_band, locale, timezone)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
              [body.email, hash, body.birthDate, band, body.locale, body.timezone],
            );
            const id = u.rows[0]!.id;
            await tx.query(
              `INSERT INTO profiles (user_id, username, display_name, is_private) VALUES ($1,$2,$3,$4)`,
              [id, body.username, body.displayName, band === 'teen'],
            );
            // Safer defaults for teens: followers-only posts, messages from friends, not discoverable.
            await tx.query(
              `INSERT INTO user_preferences (user_id, locale, timezone, default_post_visibility, who_can_message, discoverable, sensitive_content)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                id,
                body.locale,
                body.timezone,
                band === 'teen' ? 'followers' : 'public',
                band === 'teen' ? 'friends' : 'everyone',
                band !== 'teen',
                band === 'teen' ? 'hide' : 'limit',
              ],
            );
            await tx.query(
              `INSERT INTO consents (user_id, purpose, granted, source) VALUES ($1,'terms_of_service',true,'signup'),($1,'privacy_policy',true,'signup')`,
              [id],
            );
            return id;
          });
        } catch (err) {
          const e = err as { code?: string; constraint?: string };
          if (e.code === '23505') {
            if (e.constraint === 'profiles_username_unique')
              throw conflict('That username is already taken');
            throw conflict('An account with this email already exists');
          }
          throw err;
        }
        await audit(ctx, { actorId: userId, action: 'user.registered' }, req);
        ctx.metrics.events.inc({ name: 'signup' });
        await sendVerificationEmail(ctx, userId, body.email);
        const session = await startSession(ctx, req, reply, userId, {
          mfaVerified: false,
          deliver: body.deliver,
          firstSession: true,
        });
        void reply.code(201);
        return { user: await selfView(ctx, userId), ...session };
      },
    });

    // ------------------------------------------------------------ login
    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/login',
      summary: 'Sign in with email and password',
      tags: ['auth'],
      auth: 'public',
      body: loginBody,
      rateLimit: { limit: 30, windowSec: 600 },
      handler: async ({ req, reply, body }) => {
        const perAccount = ctx.config.RATE_LIMIT_ENABLED
          ? await ctx.limiter.hit(`login:${body.email}`, 10, 600)
          : { allowed: true };
        if (!perAccount.allowed)
          throw new AppError('rate_limited', 'Too many attempts. Try again later.');

        const { rows } = await ctx.db.query<UserRow>(
          `SELECT id, email, email_verified_at, password_hash, status, platform_role, age_band, locale, timezone, mfa_enabled, locked_until, deletion_scheduled_for
             FROM users WHERE email = $1 AND deleted_at IS NULL`,
          [body.email],
        );
        const user = rows[0];
        if (!user || !user.password_hash) {
          await verifyPassword(body.password, await timingDummy());
          throw INVALID_CREDENTIALS();
        }
        if (user.locked_until && user.locked_until > new Date()) {
          await verifyPassword(body.password, await timingDummy());
          throw INVALID_CREDENTIALS();
        }
        if (!(await verifyPassword(body.password, user.password_hash))) {
          await recordFailedLogin(ctx, user.id, req);
          throw INVALID_CREDENTIALS();
        }
        if (user.status === 'suspended')
          throw forbidden('This account is suspended. Contact support to appeal.');
        if (user.status === 'deleted') throw INVALID_CREDENTIALS();
        if (needsRehash(user.password_hash)) {
          await ctx.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
            user.id,
            await hashPassword(body.password),
          ]);
        }
        if (user.status === 'deactivated') {
          await ctx.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [user.id]);
          await securityEvent(ctx, user.id, 'account_reactivated', req);
        }

        if (user.mfa_enabled) {
          const challenge = randomToken(32);
          await ctx.db.query(
            `INSERT INTO mfa_challenges (user_id, token_hash, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
            [
              user.id,
              sha256Hex(challenge),
              req.clientIp,
              req.headers['user-agent']?.slice(0, 300) ?? null,
              String(MFA_CHALLENGE_TTL_MINUTES),
            ],
          );
          return { mfaRequired: true, challengeToken: challenge };
        }
        const session = await startSession(ctx, req, reply, user.id, {
          mfaVerified: false,
          deliver: body.deliver,
          deviceLabel: body.deviceLabel,
        });
        return { mfaRequired: false, user: await selfView(ctx, user.id), ...session };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      summary: 'Complete a sign-in that requires MFA',
      tags: ['auth'],
      auth: 'public',
      body: mfaVerifyBody,
      rateLimit: { limit: 30, windowSec: 600 },
      handler: async ({ req, reply, body }) => {
        const tokenHash = sha256Hex(body.challengeToken);
        // Count the attempt atomically before checking anything, so guesses can't race past the limit.
        const { rows } = await ctx.db.query<{ id: string; user_id: string }>(
          `UPDATE mfa_challenges SET attempts = attempts + 1
            WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
            RETURNING id, user_id`,
          [tokenHash],
        );
        const ch = rows[0];
        if (!ch)
          throw new AppError('unauthenticated', 'This verification has expired. Sign in again.');

        let ok = false;
        if (body.code) {
          const f = await ctx.db.query<{
            id: string;
            secret_enc: string;
            last_used_step: number | null;
          }>(
            `SELECT id, secret_enc, last_used_step FROM mfa_factors WHERE user_id = $1 AND verified_at IS NOT NULL`,
            [ch.user_id],
          );
          for (const factor of f.rows) {
            const secret = decrypt(
              factor.secret_enc,
              ctx.config.dataEncryptionKey,
              `mfa:${ch.user_id}`,
            );
            const step = verifyTotp(secret, body.code);
            if (step !== null && (factor.last_used_step === null || step > factor.last_used_step)) {
              const upd = await ctx.db.query(
                `UPDATE mfa_factors SET last_used_step = $2 WHERE id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
                [factor.id, step],
              );
              ok = (upd.rowCount ?? 0) === 1; // replay-protected
              if (ok) break;
            }
          }
        } else if (body.recoveryCode) {
          const upd = await ctx.db.query(
            `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
            [ch.user_id, recoveryHash(ctx, body.recoveryCode)],
          );
          ok = (upd.rowCount ?? 0) === 1;
          if (ok) await securityEvent(ctx, ch.user_id, 'mfa_recovery_code_used', req);
        }
        if (!ok) {
          await securityEvent(ctx, ch.user_id, 'mfa_failed', req);
          throw new AppError('unauthenticated', 'That code is not valid');
        }
        await ctx.db.query('UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
        const session = await startSession(ctx, req, reply, ch.user_id, {
          mfaVerified: true,
          deliver: body.deliver,
        });
        return { user: await selfView(ctx, ch.user_id), ...session };
      },
    });

    // ------------------------------------------------------------ session management
    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/logout',
      summary: 'Sign out this session',
      tags: ['auth'],
      auth: 'user',
      handler: async ({ auth, reply }) => {
        await ctx.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [
          auth.sessionId,
        ]);
        clearSessionCookie(ctx, reply);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/logout-all',
      summary: 'Sign out everywhere',
      tags: ['auth'],
      auth: 'user',
      handler: async ({ auth, req, reply }) => {
        const n = await revokeSessions(ctx, auth.userId);
        await securityEvent(ctx, auth.userId, 'logout_all', req, { revoked: n });
        clearSessionCookie(ctx, reply);
        return { revoked: n };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/auth/me',
      summary: 'Current user',
      tags: ['auth'],
      auth: 'user',
      handler: async ({ auth }) => ({
        user: await selfView(ctx, auth.userId),
        flags: await ctx.flags.all(auth.userId),
      }),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/auth/sessions',
      summary: 'List active sessions and devices',
      tags: ['auth'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT s.id, s.created_at, s.last_seen_at, s.user_agent, host(s.ip) AS ip, d.label AS device_label
             FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
            WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_seen_at DESC`,
          [auth.userId],
        );
        return {
          items: rows.map((r) => ({
            id: r.id as string,
            current: r.id === auth.sessionId,
            createdAt: (r.created_at as Date).toISOString(),
            lastSeenAt: (r.last_seen_at as Date).toISOString(),
            userAgent: r.user_agent as string | null,
            deviceLabel: r.device_label as string | null,
            ipHint: maskIp(r.ip as string | null),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/auth/sessions/:id',
      summary: 'Revoke one of your sessions',
      tags: ['auth'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query(
          'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
          [params.id, auth.userId],
        );
        if (!r.rowCount) throw notFound('Session');
      },
    });

    // ------------------------------------------------------------ email verification
    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/email/verify',
      summary: 'Verify email address with a token',
      tags: ['auth'],
      auth: 'public',
      body: tokenBody,
      rateLimit: { limit: 20, windowSec: 600 },
      handler: async ({ body }) => {
        const userId = await consumeOneTimeToken(ctx, body.token, 'verify_email');
        await ctx.db.query(
          'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
          [userId],
        );
        return { verified: true };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/email/resend',
      summary: 'Resend the verification email',
      tags: ['auth'],
      auth: 'user',
      rateLimit: { limit: 3, windowSec: 3600, by: 'user' },
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query<{ email: string; email_verified_at: Date | null }>(
          'SELECT email, email_verified_at FROM users WHERE id = $1',
          [auth.userId],
        );
        if (rows[0]!.email_verified_at) return { alreadyVerified: true };
        await sendVerificationEmail(ctx, auth.userId, rows[0]!.email);
        return { sent: true };
      },
    });

    // ------------------------------------------------------------ passwords
    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/password/forgot',
      summary: 'Request a password reset email',
      tags: ['auth'],
      auth: 'public',
      body: forgotBody,
      rateLimit: { limit: 5, windowSec: 3600 },
      handler: async ({ reply, body }) => {
        const { rows } = await ctx.db.query<{ id: string; email: string }>(
          `SELECT id, email FROM users WHERE email = $1 AND deleted_at IS NULL AND status <> 'suspended'`,
          [body.email],
        );
        if (rows[0]) await sendResetEmail(ctx, rows[0].id, rows[0].email);
        void reply.code(202);
        // Identical response whether or not the account exists (no enumeration).
        return { message: 'If an account exists for that email, a reset link has been sent.' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/password/reset',
      summary: 'Set a new password using a reset token',
      tags: ['auth'],
      auth: 'public',
      body: resetBody,
      rateLimit: { limit: 10, windowSec: 3600 },
      handler: async ({ req, body }) => {
        const problem = passwordProblem(body.newPassword);
        if (problem) throw invalid(problem);
        const userId = await consumeOneTimeToken(ctx, body.token, 'reset_password');
        await ctx.db.query(
          `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`,
          [userId, await hashPassword(body.newPassword)],
        );
        await revokeSessions(ctx, userId);
        await securityEvent(ctx, userId, 'password_reset', req);
        await audit(ctx, { actorId: userId, action: 'user.password_reset' }, req);
        return { reset: true };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/password/change',
      summary: 'Change password (requires current password)',
      tags: ['auth'],
      auth: 'user',
      body: changePasswordBody,
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        if (!(await verifyUserPassword(ctx, auth.userId, body.currentPassword)))
          throw new AppError('unauthenticated', 'Current password is incorrect');
        const problem = passwordProblem(body.newPassword);
        if (problem) throw invalid(problem);
        await ctx.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          auth.userId,
          await hashPassword(body.newPassword),
        ]);
        const revoked = await revokeSessions(ctx, auth.userId, auth.sessionId);
        await securityEvent(ctx, auth.userId, 'password_changed', req, {
          otherSessionsRevoked: revoked,
        });
        return { changed: true, otherSessionsRevoked: revoked };
      },
    });

    // ------------------------------------------------------------ MFA (TOTP)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/mfa/setup',
      summary: 'Begin TOTP enrolment',
      tags: ['auth', 'mfa'],
      auth: 'user',
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth }) => {
        const { rows: u } = await ctx.db.query<{ email: string; mfa_enabled: boolean }>(
          'SELECT email, mfa_enabled FROM users WHERE id = $1',
          [auth.userId],
        );
        if (u[0]!.mfa_enabled) throw conflict('Multi-factor authentication is already enabled');
        const secret = generateTotpSecret();
        await ctx.db.query('DELETE FROM mfa_factors WHERE user_id = $1 AND verified_at IS NULL', [
          auth.userId,
        ]);
        await ctx.db.query(
          `INSERT INTO mfa_factors (user_id, type, secret_enc) VALUES ($1,'totp',$2)`,
          [
            auth.userId,
            encrypt(
              secret,
              ctx.config.dataEncryptionKey,
              ctx.config.DATA_ENCRYPTION_KEY_ID,
              `mfa:${auth.userId}`,
            ),
          ],
        );
        return { secret, otpauthUri: otpauthUri(secret, u[0]!.email) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/mfa/enable',
      summary: 'Confirm TOTP enrolment and receive recovery codes',
      tags: ['auth', 'mfa'],
      auth: 'user',
      body: mfaEnableBody,
      rateLimit: { limit: 10, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        const { rows } = await ctx.db.query<{ id: string; secret_enc: string }>(
          `SELECT id, secret_enc FROM mfa_factors WHERE user_id = $1 AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [auth.userId],
        );
        if (!rows[0]) throw invalid('Start MFA setup first');
        const step = verifyTotp(
          decrypt(rows[0].secret_enc, ctx.config.dataEncryptionKey, `mfa:${auth.userId}`),
          body.code,
        );
        if (step === null) throw invalid('That code is not valid');
        const codes = generateRecoveryCodes(10);
        await withTransaction(ctx.db, async (tx) => {
          await tx.query(
            'UPDATE mfa_factors SET verified_at = now(), last_used_step = $2 WHERE id = $1',
            [rows[0]!.id, step],
          );
          await tx.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [auth.userId]);
          await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [auth.userId]);
          for (const c of codes)
            await tx.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [
              auth.userId,
              recoveryHash(ctx, c),
            ]);
          await tx.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [auth.sessionId]);
        });
        await securityEvent(ctx, auth.userId, 'mfa_enabled', req);
        return { enabled: true, recoveryCodes: codes };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      summary: 'Disable MFA (requires password and a current code)',
      tags: ['auth', 'mfa'],
      auth: 'user',
      body: mfaDisableBody,
      rateLimit: { limit: 5, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        if (!(await verifyUserPassword(ctx, auth.userId, body.password)))
          throw new AppError('unauthenticated', 'Password is incorrect');
        const { rows } = await ctx.db.query<{ secret_enc: string }>(
          `SELECT secret_enc FROM mfa_factors WHERE user_id = $1 AND verified_at IS NOT NULL`,
          [auth.userId],
        );
        const okCode = rows.some(
          (f) =>
            verifyTotp(
              decrypt(f.secret_enc, ctx.config.dataEncryptionKey, `mfa:${auth.userId}`),
              body.code,
            ) !== null,
        );
        if (!okCode) throw new AppError('unauthenticated', 'That code is not valid');
        await withTransaction(ctx.db, async (tx) => {
          await tx.query('DELETE FROM mfa_factors WHERE user_id = $1', [auth.userId]);
          await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [auth.userId]);
          await tx.query('UPDATE users SET mfa_enabled = false WHERE id = $1', [auth.userId]);
        });
        await securityEvent(ctx, auth.userId, 'mfa_disabled', req);
        return { enabled: false };
      },
    });

    // ------------------------------------------------------------ account lifecycle
    route(app, ctx, {
      method: 'POST',
      url: '/v1/account/deactivate',
      summary: 'Temporarily deactivate the account',
      tags: ['account'],
      auth: 'user',
      body: deleteAccountBody,
      rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        if (!(await verifyUserPassword(ctx, auth.userId, body.password)))
          throw new AppError('unauthenticated', 'Password is incorrect');
        await ctx.db.query(
          `UPDATE users SET status = 'deactivated' WHERE id = $1 AND status = 'active'`,
          [auth.userId],
        );
        await revokeSessions(ctx, auth.userId);
        await audit(ctx, { actorId: auth.userId, action: 'account.deactivated' }, req);
        clearSessionCookie(ctx, reply);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/account/deletion',
      summary: `Schedule account deletion (${DELETION_GRACE_DAYS}-day grace period)`,
      tags: ['account'],
      auth: 'user',
      body: deleteAccountBody,
      rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        if (!(await verifyUserPassword(ctx, auth.userId, body.password)))
          throw new AppError('unauthenticated', 'Password is incorrect');
        const { rows } = await ctx.db.query<{ deletion_scheduled_for: Date }>(
          `UPDATE users SET status = 'pending_deletion', deletion_scheduled_for = now() + ($2 || ' days')::interval WHERE id = $1 AND status IN ('active','pending_deletion') RETURNING deletion_scheduled_for`,
          [auth.userId, String(DELETION_GRACE_DAYS)],
        );
        if (!rows[0]) throw forbidden('This account cannot be deleted right now');
        await ctx.db.query(
          `INSERT INTO privacy_requests (user_id, kind, status) VALUES ($1,'delete','pending')`,
          [auth.userId],
        );
        await revokeSessions(ctx, auth.userId, auth.sessionId);
        await audit(ctx, { actorId: auth.userId, action: 'account.deletion_scheduled' }, req);
        return { scheduledFor: rows[0].deletion_scheduled_for.toISOString() };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/account/deletion/cancel',
      summary: 'Cancel a scheduled account deletion',
      tags: ['account'],
      auth: 'user',
      handler: async ({ auth, req }) => {
        const r = await ctx.db.query(
          `UPDATE users SET status = 'active', deletion_scheduled_for = NULL WHERE id = $1 AND status = 'pending_deletion'`,
          [auth.userId],
        );
        if (!r.rowCount) throw conflict('No deletion is scheduled');
        await ctx.db.query(
          `UPDATE privacy_requests SET status = 'cancelled', completed_at = now() WHERE user_id = $1 AND kind = 'delete' AND status = 'pending'`,
          [auth.userId],
        );
        await audit(ctx, { actorId: auth.userId, action: 'account.deletion_cancelled' }, req);
        return { cancelled: true };
      },
    });

    void z; // schemas imported for typing only
  },
};

function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.*.*` : null;
}
