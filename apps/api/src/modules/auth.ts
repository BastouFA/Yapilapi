import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, hashToken, newToken, SESSION_COOKIE, verifyPassword } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema, tokenSchema, type Me } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, conflict, notFound, parse, unauthorized } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, securityEvent, track } from '../lib/services.ts';
import { ageOf } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { registerMfa } from './mfa.ts';
import { registerPasskeys } from './passkeys.ts';

const MIN_AGE = 13;
const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function loadMe(ctx: AppContext, userId: string): Promise<Me> {
  const { rows } = await ctx.db.query(
    `SELECT u.id, u.email, u.email_verified_at, u.role, u.onboarded_at, pr.username, pr.display_name, pr.avatar_url, pr.mode, pr.locale, pr.country
     FROM users u JOIN profiles pr ON pr.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw notFound('Account');
  return {
    id: r.id,
    email: r.email,
    emailVerified: !!r.email_verified_at,
    role: r.role,
    onboarded: !!r.onboarded_at,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    mode: r.mode,
    locale: r.locale,
    country: r.country?.trim() ?? null,
  };
}

export default async function authModule(app: FastifyInstance, ctx: AppContext) {
  const ttlMs = ctx.config.SESSION_TTL_DAYS * 86400_000;

  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
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
      new Date(Date.now() + ttlMs),
    ]);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: ctx.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(ttlMs / 1000),
    });
    return token;
  }

  async function sendVerification(userId: string, email: string) {
    const { token, hash } = newToken();
    await ctx.db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'verify_email',$2, now() + interval '2 days')`, [
      userId,
      hash,
    ]);
    await ctx.email.send({
      to: email,
      subject: 'Confirm your email for YAPILAPI',
      text: `Confirm your email: ${ctx.config.WEB_ORIGIN}/verify-email?token=${token}`,
    });
  }

  app.post('/v1/auth/register', { config: authLimit }, async (req, reply) => {
    const input = parse(registerSchema, req.body);
    if (input.birthDate) {
      const age = ageOf(input.birthDate);
      if (age === null || age < MIN_AGE)
        throw badRequest(`You need to be at least ${MIN_AGE} to join.`, { fields: { birthDate: `You need to be at least ${MIN_AGE}.` } });
    }
    const passwordHash = await hashPassword(input.password);
    const userId = await tx(ctx.db, async (c) => {
      const taken = await c.query(
        `SELECT (SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL) AS email, (SELECT 1 FROM profiles WHERE lower(username) = lower($2)) AS username`,
        [input.email, input.username],
      );
      const t = taken.rows[0];
      if (t.email)
        throw new AppError(409, 'conflict', 'An account with that email already exists. Log in instead.', { fields: { email: 'Already registered.' } });
      if (t.username) throw new AppError(409, 'conflict', 'That username is taken. Try another.', { fields: { username: 'Taken.' } });
      const u = await c.query<{ id: string }>(`INSERT INTO users (email, password_hash, birth_date) VALUES ($1,$2,$3) RETURNING id`, [
        input.email,
        passwordHash,
        input.birthDate ?? null,
      ]);
      const id = u.rows[0]!.id;
      await c.query(`INSERT INTO profiles (user_id, username, display_name) VALUES ($1,$2,$3)`, [id, input.username, input.displayName]);
      await c.query(`INSERT INTO user_preferences (user_id) VALUES ($1)`, [id]);
      // Minors get protective defaults: private account, no personalization for ads.
      const age = ageOf(input.birthDate ?? null);
      if (age !== null && age < 18) await c.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [id]);
      await c.query(
        `INSERT INTO consents (user_id, purpose, granted) VALUES ($1,'personalization',true),($1,'ai_processing',false),($1,'advertising',false),($1,'analytics',true)`,
        [id],
      );
      await securityEvent(c, id, 'account_created', req.ip, req.headers['user-agent']);
      return id;
    });
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

  app.get('/v1/auth/me', { preHandler: requireAuth }, async (req) => {
    // Record the country from a trusted CDN header unless the person chose one themselves.
    const header = ctx.config.TRUSTED_COUNTRY_HEADER;
    const cc = header ? String(req.headers[header.toLowerCase()] ?? '').toUpperCase() : '';
    if (/^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1')
      await ctx.db.query(
        `UPDATE profiles SET country = $2, country_source = 'cdn' WHERE user_id = $1 AND country_source IS DISTINCT FROM 'user' AND country IS DISTINCT FROM $2`,
        [me(req).id, cc],
      );
    return { user: await loadMe(ctx, me(req).id) };
  });

  app.post('/v1/auth/verify-email', { config: authLimit }, async (req) => {
    const { token } = parse(tokenSchema, req.body);
    const { rows } = await ctx.db.query<{ user_id: string }>(
      `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [hashToken(token)],
    );
    if (!rows[0]) throw badRequest('This link has expired or was already used. Request a new one from Settings.');
    await ctx.db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [rows[0].user_id]);
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
      await ctx.email.send({
        to: email,
        subject: 'Reset your YAPILAPI password',
        text: `Reset your password: ${ctx.config.WEB_ORIGIN}/reset-password?token=${token} (valid for 1 hour)`,
      });
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
    const input = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) }), req.body);
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
