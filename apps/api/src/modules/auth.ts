import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, hashToken, newToken, SESSION_COOKIE, verifyPassword } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import {
  ADULT_AGE,
  birthDateSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  MIN_SIGNUP_AGE,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
  type AccountInfo,
  type Me,
  SUPPORTED_LOCALES,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound, parse, unauthorized } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, securityEvent, track } from '../lib/services.ts';
import { applyMinorDefaults, checkBirthDate } from '../lib/users.ts';
import { announceReferral, applyReferral, inviterByCode, qualifyReferral } from '../lib/invites.ts';
import { recordSignals, scoreSignup } from '../lib/spam.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { registerMfa } from './mfa.ts';
import { registerPasskeys } from './passkeys.ts';

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function loadMe(ctx: AppContext, userId: string): Promise<Me> {
  const { rows } = await ctx.db.query(
    `SELECT u.id, u.email, u.email_verified_at, (u.birth_date IS NULL) AS no_birth_date, u.phone_e164, u.phone_verified_at, u.restricted_at, u.role, u.onboarded_at, pr.username, pr.display_name, pr.avatar_url, pr.mode, pr.locale, pr.country, pr.plus_until,
            coalesce(up.data_saver, 'auto') AS data_saver, coalesce(up.languages, '{}') AS languages, coalesce(up.auto_translate, false) AS auto_translate
     FROM users u JOIN profiles pr ON pr.user_id = u.id LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw notFound('Account');
  return {
    id: r.id,
    email: r.email,
    emailVerified: !!r.email_verified_at,
    phone: r.phone_e164 ?? null,
    phoneVerified: !!r.phone_verified_at,
    needsVerification: ctx.config.REQUIRE_VERIFICATION && !r.email_verified_at && !r.phone_verified_at,
    ...(r.restricted_at ? { limited: true } : {}),
    ...(r.no_birth_date ? { needsBirthDate: true } : {}),
    role: r.role,
    onboarded: !!r.onboarded_at,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    mode: r.mode,
    locale: r.locale,
    country: r.country?.trim() ?? null,
    ...(r.plus_until && r.plus_until > new Date() ? { plus: true } : {}),
    plusUntil: r.plus_until && r.plus_until > new Date() ? r.plus_until.toISOString() : null,
    dataSaver: r.data_saver,
    translation: { languages: r.languages, auto: r.auto_translate },
  };
}

export default async function authModule(app: FastifyInstance, ctx: AppContext) {
  const ttlMs = ctx.config.SESSION_TTL_DAYS * 86400_000;

  /**
   * A new session. "Stay signed in" is the default; a web sign-in that turns it off
   * (`remember: false` in the body) gets a cookie that ends with the browser, and a session
   * that ends after a day at most.
   */
  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
    const remember = (req.body as { remember?: unknown } | undefined)?.remember !== false;
    const lifetime = remember ? ttlMs : Math.min(ttlMs, 86400_000);
    const { token, hash } = newToken();
    const ua = req.headers['user-agent']?.slice(0, 300) ?? null;
    const device = await ctx.db.query<{ id: string }>(`INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, $3) RETURNING id`, [
      userId,
      deviceName(ua),
      req.headers['x-client-platform'] === 'mobile' ? 'mobile' : 'web',
    ]);
    await ctx.db.query(`INSERT INTO sessions (user_id, device_id, token_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      userId,
      device.rows[0]!.id,
      hash,
      ua,
      req.ip,
      new Date(Date.now() + lifetime),
    ]);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: ctx.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      ...(remember ? { maxAge: Math.floor(ttlMs / 1000) } : {}),
    });
    return token;
  }

  // Links in emails open the web app (the first origin when several are allowed).
  const webOrigin = ctx.config.WEB_ORIGIN.split(',')[0]!.replace(/\/+$/, '');

  async function sendVerification(userId: string, email: string) {
    const { token, hash } = newToken();
    await ctx.db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'verify_email',$2, now() + interval '2 days')`, [
      userId,
      hash,
    ]);
    // A mail server that is down must not fail the sign-up: "Send the link again" in Settings retries.
    await ctx.email
      .send({
        to: email,
        subject: 'Confirm your email for YAPILAPI',
        text: `Confirm your email: ${webOrigin}/verify-email?token=${token}`,
      })
      .catch((err: Error) => app.log.error({ err: err.message }, 'verification email not sent'));
  }

  app.post('/v1/auth/register', { config: authLimit }, async (req, reply) => {
    const input = parse(registerSchema, req.body);
    // The web form has a field people never see or fill in; bots that fill every field get a plain refusal.
    if (input.website) {
      await securityEvent(ctx.db, null, 'signup_blocked', req.ip, req.headers['user-agent'], { reason: 'honeypot' });
      throw new AppError(400, 'signup_blocked', 'We couldn’t create your account. Try again, or contact support if this keeps happening.');
    }
    // Everyone gives a birth date; under 13 can't join, 13 to 17 get the protections for minors.
    const age = checkBirthDate(input.birthDate);
    if (age < MIN_SIGNUP_AGE) {
      await securityEvent(ctx.db, null, 'signup_underage', req.ip, req.headers['user-agent']);
      throw new AppError(403, 'under_minimum_age', `You need to be at least ${MIN_SIGNUP_AGE} to join YAPILAPI.`, {
        fields: { birthDate: `You need to be at least ${MIN_SIGNUP_AGE}.` },
      });
    }
    const passwordHash = await hashPassword(input.password);
    // Risk signals (throwaway email, many sign-ups from one network) never block a sign-up; moderators see them.
    const risk = await scoreSignup(ctx.db, ctx.config, { email: input.email, ip: req.ip });
    let inviterId: string | null = null;
    const userId = await tx(ctx.db, async (c) => {
      const taken = await c.query(
        `SELECT (SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL) AS email, (SELECT 1 FROM profiles WHERE lower(username) = lower($2)) AS username`,
        [input.email, input.username],
      );
      const t = taken.rows[0];
      if (t.email)
        throw new AppError(409, 'conflict', 'An account with that email already exists. Log in instead.', { fields: { email: 'Already registered.' } });
      if (t.username) throw new AppError(409, 'conflict', 'That username is taken. Try another.', { fields: { username: 'Taken.' } });
      const inviter = input.inviteCode ? await inviterByCode(c, input.inviteCode) : null;
      if (input.inviteCode && !inviter)
        throw new AppError(400, 'invalid_invite', "That invite code doesn't work. Check it, or leave it empty.", {
          fields: { inviteCode: "That invite code doesn't work." },
        });
      const u = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO users (email, password_hash, birth_date) VALUES ($1,$2,$3) RETURNING id, created_at`,
        [input.email, passwordHash, input.birthDate],
      );
      const id = u.rows[0]!.id;
      // Start in the person's own language when we support it.
      const base = input.locale?.split(/[-_]/)[0]?.toLowerCase() ?? 'en';
      const locale = SUPPORTED_LOCALES.includes(base) ? base : 'en';
      await c.query(`INSERT INTO profiles (user_id, username, display_name, locale) VALUES ($1,$2,$3,$4)`, [id, input.username, input.displayName, locale]);
      await c.query(`INSERT INTO user_preferences (user_id) VALUES ($1)`, [id]);
      await c.query(
        `INSERT INTO consents (user_id, purpose, granted) VALUES ($1,'personalization',true),($1,'ai_processing',false),($1,'advertising',false),($1,'analytics',true)`,
        [id],
      );
      // Minors get protective defaults: private account, no personalization for ads.
      if (age < ADULT_AGE) await applyMinorDefaults(c, id);
      await securityEvent(c, id, 'account_created', req.ip, req.headers['user-agent']);
      await recordSignals(c, id, risk);
      if (inviter) {
        await applyReferral(c, { id, email: input.email, birthDate: input.birthDate, createdAt: u.rows[0]!.created_at }, inviter);
        inviterId = inviter.id;
      }
      return id;
    });
    if (inviterId) await announceReferral(ctx.db, ctx.realtime, userId, inviterId);
    await sendVerification(userId, input.email);
    const token = await startSession(req, reply, userId);
    track(ctx.db, userId, 'signup');
    reply.code(201);
    return { user: await loadMe(ctx, userId), token };
  });

  app.post('/v1/auth/login', { config: authLimit }, async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const { rows } = await ctx.db.query<{ id: string; password_hash: string | null; status: string }>(
      `SELECT id, password_hash, status FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [input.email],
    );
    const u = rows[0];
    const ok = await verifyPassword(input.password, u?.password_hash);
    if (!u || !ok) {
      await securityEvent(ctx.db, u?.id ?? null, 'login_failed', req.ip, req.headers['user-agent'], { email: input.email });
      throw unauthorized('That email and password don’t match. Try again or reset your password.');
    }
    if (u.status !== 'active') throw new AppError(403, 'account_suspended', 'This account is suspended. You can appeal from the email we sent you.');
    // Second factor: the password alone only earns a short-lived challenge.
    const mfa = await ctx.db.query(`SELECT 1 FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL`, [u.id]);
    if (mfa.rowCount) {
      const { token: challengeToken, hash } = newToken();
      await ctx.db.query(`INSERT INTO mfa_challenges (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [u.id, hash]);
      await securityEvent(ctx.db, u.id, 'login_password_ok_mfa_pending', req.ip, req.headers['user-agent']);
      return { mfaRequired: true, challengeToken };
    }
    const token = await startSession(req, reply, u.id);
    await securityEvent(ctx.db, u.id, 'login', req.ip, req.headers['user-agent']);
    return { user: await loadMe(ctx, u.id), token };
  });

  registerMfa(app, ctx, async (req, reply, userId) => {
    const token = await startSession(req, reply, userId);
    await securityEvent(ctx.db, userId, 'login', req.ip, req.headers['user-agent'], { mfa: true });
    return { user: await loadMe(ctx, userId), token };
  });

  registerPasskeys(app, ctx, async (req, reply, userId) => {
    const token = await startSession(req, reply, userId);
    await securityEvent(ctx.db, userId, 'login', req.ip, req.headers['user-agent'], { passkey: true });
    return { user: await loadMe(ctx, userId), token };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    if (req.user) await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [req.user.sessionId]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Log out everywhere: every session of this account ends, this one included. */
  app.post('/v1/auth/logout-all', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const r = await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
    await securityEvent(ctx.db, u.id, 'sessions_revoked', req.ip, req.headers['user-agent'], { count: r.rowCount, everywhere: true });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, revoked: r.rowCount };
  });

  /** Settings > Account: sign-in details and the date of birth (read-only), for the account itself only. */
  app.get('/v1/me/account', { preHandler: requireAuth }, async (req) => {
    const { rows } = await ctx.db.query(
      `SELECT email, email_verified_at, phone_e164, phone_verified_at, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, created_at FROM users WHERE id = $1`,
      [me(req).id],
    );
    const r = rows[0];
    if (!r) throw notFound('Account');
    const account: AccountInfo = {
      email: r.email,
      emailVerified: !!r.email_verified_at,
      phone: r.phone_e164 ?? null,
      phoneVerified: !!r.phone_verified_at,
      birthDate: r.birth_date ?? null,
      createdAt: r.created_at.toISOString(),
    };
    return { account };
  });

  app.get('/v1/auth/me', { preHandler: requireAuth }, async (req) => {
    // Record the country from a trusted CDN header unless the person chose one themselves.
    const header = ctx.config.TRUSTED_COUNTRY_HEADER;
    const cc = header ? String(req.headers[header.toLowerCase()] ?? '').toUpperCase() : '';
    if (/^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1')
      // cdn_country always follows the CDN, so regional rules still apply when someone picks another country.
      await ctx.db.query(
        `UPDATE profiles SET cdn_country = $2,
           country = CASE WHEN country_source IS DISTINCT FROM 'user' THEN $2 ELSE country END,
           country_source = CASE WHEN country_source IS DISTINCT FROM 'user' THEN 'cdn' ELSE country_source END
         WHERE user_id = $1 AND (cdn_country IS DISTINCT FROM $2 OR (country_source IS DISTINCT FROM 'user' AND country IS DISTINCT FROM $2))`,
        [me(req).id, cc],
      );
    return { user: await loadMe(ctx, me(req).id) };
  });

  /**
   * Accounts made before a birth date was required give it once, on their next sign-in. It can
   * only be set while there is none. Under 13: the account is closed to sign-in (suspended, every
   * session revoked) and staff are told through the moderation queue. 13 to 17: the protections
   * for minors apply from now on.
   */
  app.post('/v1/me/birth-date', { preHandler: requireAuth, config: authLimit }, async (req, reply) => {
    const u = me(req);
    const { birthDate } = parse(z.object({ birthDate: birthDateSchema }), req.body);
    const age = checkBirthDate(birthDate);
    const set = await ctx.db.query(`UPDATE users SET birth_date = $2 WHERE id = $1 AND birth_date IS NULL RETURNING id`, [u.id, birthDate]);
    if (!set.rowCount) throw conflict('Your date of birth is already on your account. Contact support to correct it.');
    if (age < MIN_SIGNUP_AGE) {
      await tx(ctx.db, async (c) => {
        await c.query(`UPDATE users SET status = 'suspended' WHERE id = $1 AND role = 'user'`, [u.id]);
        await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('user', $1, $1, 'automated', 'escalate', $2)
           ON CONFLICT (target_type, target_id) WHERE status = 'open' DO NOTHING`,
          [u.id, { reason: 'under_minimum_age' }],
        );
        await securityEvent(c, u.id, 'underage_closed', req.ip, req.headers['user-agent']);
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      throw new AppError(403, 'under_minimum_age', `You need to be at least ${MIN_SIGNUP_AGE} to use YAPILAPI, so this account is now closed.`);
    }
    if (age < ADULT_AGE) await applyMinorDefaults(ctx.db, u.id);
    await audit(ctx.db, { actorId: u.id, action: 'birth_date.set', entityType: 'user', entityId: u.id, ip: req.ip, requestId: req.id });
    return { user: await loadMe(ctx, u.id) };
  });

  app.post('/v1/auth/verify-email', { config: authLimit }, async (req) => {
    const { token } = parse(tokenSchema, req.body);
    const { rows } = await ctx.db.query<{ user_id: string }>(
      `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [hashToken(token)],
    );
    if (!rows[0]) throw badRequest('This link has expired or was already used. Request a new one from Settings.');
    await tx(ctx.db, async (c) => {
      await c.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [rows[0]!.user_id]);
      // A confirmed email makes an invite count toward the inviter's free month.
      await qualifyReferral(c, ctx.realtime, rows[0]!.user_id);
    });
    await securityEvent(ctx.db, rows[0].user_id, 'email_verified', req.ip);
    return { ok: true };
  });

  app.post('/v1/auth/verify-email/resend', { preHandler: requireAuth, config: authLimit }, async (req) => {
    const u = me(req);
    if (u.emailVerified) return { ok: true };
    await sendVerification(u.id, u.email);
    return { ok: true };
  });

  // Always answers the same way so it can't be used to discover accounts.
  app.post('/v1/auth/password/forgot', { config: authLimit }, async (req) => {
    const { email } = parse(forgotPasswordSchema, req.body);
    const { rows } = await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' AND deleted_at IS NULL`, [email]);
    if (rows[0]) {
      const { token, hash } = newToken();
      await ctx.db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'reset_password',$2, now() + interval '1 hour')`, [
        rows[0].id,
        hash,
      ]);
      // The answer stays the same whether or not the email went out, so it can't reveal accounts; failures are logged.
      await ctx.email
        .send({
          to: email,
          subject: 'Reset your YAPILAPI password',
          text: `Reset your password: ${webOrigin}/reset-password?token=${token} (valid for 1 hour). If you didn't ask for this, you can ignore this email.`,
        })
        .catch((err: Error) => req.log.error({ err: err.message }, 'password reset email not sent'));
      await securityEvent(ctx.db, rows[0].id, 'password_reset_requested', req.ip);
    }
    return { ok: true, message: 'If that email has an account, we sent a reset link.' };
  });

  app.post('/v1/auth/password/reset', { config: authLimit }, async (req) => {
    const input = parse(resetPasswordSchema, req.body);
    const hash = await hashPassword(input.password);
    await tx(ctx.db, async (c) => {
      const { rows } = await c.query<{ user_id: string }>(
        `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [hashToken(input.token)],
      );
      if (!rows[0]) throw badRequest('This reset link has expired or was already used. Request a new one.');
      await c.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [rows[0].user_id, hash]);
      // Signing out everywhere protects an account that was taken over.
      await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [rows[0].user_id]);
      await securityEvent(c, rows[0].user_id, 'password_reset', req.ip);
    });
    return { ok: true };
  });

  app.post('/v1/auth/password/change', { preHandler: requireAuth, config: authLimit }, async (req) => {
    const u = me(req);
    const input = parse(changePasswordSchema, req.body);
    const { rows } = await ctx.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [u.id]);
    if (!(await verifyPassword(input.currentPassword, rows[0]?.password_hash)))
      throw badRequest('Your current password is incorrect.', { fields: { currentPassword: 'Incorrect.' } });
    await ctx.db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [u.id, await hashPassword(input.newPassword)]);
    await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [u.id, u.sessionId]);
    await securityEvent(ctx.db, u.id, 'password_changed', req.ip);
    return { ok: true };
  });

  // ── Sessions & devices ──────────────────────────────────────────────
  app.get('/v1/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await ctx.db.query(
      `SELECT s.id, s.user_agent, host(s.ip) AS ip, s.created_at, s.last_seen_at, d.name AS device, d.platform
       FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_seen_at DESC`,
      [u.id],
    );
    return { items: rows.map((r) => ({ ...r, current: r.id === u.sessionId })) };
  });

  app.delete('/v1/auth/sessions/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [id, u.id]);
    if (!r.rowCount) throw notFound('Session');
    await securityEvent(ctx.db, u.id, 'session_revoked', req.ip, undefined, { sessionId: id });
    return { ok: true };
  });

  app.post('/v1/auth/sessions/revoke-others', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const r = await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [u.id, u.sessionId]);
    await securityEvent(ctx.db, u.id, 'sessions_revoked', req.ip, undefined, { count: r.rowCount });
    return { revoked: r.rowCount };
  });

  app.get('/v1/auth/security-events', { preHandler: requireAuth }, async (req) => {
    const { rows } = await ctx.db.query(`SELECT type, host(ip) AS ip, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [
      me(req).id,
    ]);
    return { items: rows };
  });

  app.post('/v1/auth/check-username', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { username } = parse(z.object({ username: z.string().min(1).max(30) }), req.body);
    const r = await ctx.db.query(`SELECT 1 FROM profiles WHERE lower(username) = lower($1)`, [username]);
    return { available: !r.rowCount };
  });

  void conflict;
  void audit;
}

function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'App';
  return `${browser} on ${os}`;
}
