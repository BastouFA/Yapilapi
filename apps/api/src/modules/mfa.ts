import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  decrypt,
  encrypt,
  hashRecoveryCode,
  hashToken,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  base32Encode,
  verifyPassword,
  verifyTotp,
} from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, conflict, parse, unauthorized } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { notify, securityEvent } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

type StartSession = (req: FastifyRequest, reply: FastifyReply, userId: string) => Promise<unknown>;

const MAX_ATTEMPTS = 5;
const codeSchema = z.object({ code: z.string().trim().min(6).max(12) });

/** Encryption key for TOTP secrets: MFA_ENCRYPTION_KEY, or a fixed key outside production. */
function mfaKey(ctx: AppContext): Buffer {
  const k = Buffer.from(ctx.config.MFA_ENCRYPTION_KEY, 'base64');
  if (k.length === 32) return k;
  if (ctx.config.APP_ENV === 'production') throw new Error('MFA_ENCRYPTION_KEY missing');
  return createHash('sha256').update('yapilapi-development-mfa-key').digest();
}

/**
 * Two-step verification with authenticator apps (TOTP, RFC 6238).
 * Secrets are encrypted with AES-256-GCM; recovery codes are stored as hashes.
 * Passkeys (WebAuthn) plug into the same mfa_factors table later.
 */
export function registerMfa(app: FastifyInstance, ctx: AppContext, finishLogin: StartSession) {
  const db = ctx.db;
  const key = () => mfaKey(ctx);
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  async function confirmedSecret(userId: string): Promise<{ id: string; secret: Buffer } | null> {
    const { rows } = await db.query<{ id: string; secret_enc: Buffer }>(
      `SELECT id, secret_enc FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL`,
      [userId],
    );
    return rows[0] ? { id: rows[0].id, secret: decrypt(key(), rows[0].secret_enc) } : null;
  }

  /** Accepts a TOTP code or an unused recovery code (consumed on use). */
  async function checkSecondFactor(userId: string, code: string): Promise<'totp' | 'recovery' | null> {
    const f = await confirmedSecret(userId);
    if (f && verifyTotp(f.secret, code)) {
      await db.query(`UPDATE mfa_factors SET last_used_at = now() WHERE id = $1`, [f.id]);
      return 'totp';
    }
    const r = await db.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`, [
      userId,
      hashRecoveryCode(code),
    ]);
    return r.rowCount ? 'recovery' : null;
  }

  app.get('/v1/auth/mfa', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, kind, label, created_at, last_used_at, confirmed_at IS NOT NULL AS confirmed FROM mfa_factors WHERE user_id = $1 ORDER BY created_at`,
      [me(req).id],
    );
    const codes = await db.query(`SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [me(req).id]);
    return { enabled: rows.some((r) => r.kind === 'totp' && r.confirmed), factors: rows.filter((r) => r.confirmed), recoveryCodesLeft: codes.rows[0].n };
  });

  /** Step 1: create a pending secret and show it (QR / manual key). */
  app.post('/v1/auth/mfa/totp/setup', { preHandler: requireAuth, config: limit }, async (req) => {
    const u = me(req);
    if (await confirmedSecret(u.id)) throw conflict('Two-step verification is already on.');
    const secret = newTotpSecret();
    await db.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NULL`, [u.id]);
    const { rows } = await db.query(`INSERT INTO mfa_factors (user_id, kind, label, secret_enc) VALUES ($1, 'totp', 'Authenticator app', $2) RETURNING id`, [
      u.id,
      encrypt(key(), secret),
    ]);
    return { factorId: rows[0].id, secret: base32Encode(secret), otpauthUri: otpauthUri(secret, u.email) };
  });

  /** Step 2: prove the app works; turn MFA on and hand out recovery codes once. */
  app.post('/v1/auth/mfa/totp/confirm', { preHandler: requireAuth, config: limit }, async (req) => {
    const u = me(req);
    const { code } = parse(codeSchema, req.body);
    const { rows } = await db.query<{ id: string; secret_enc: Buffer }>(
      `SELECT id, secret_enc FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [u.id],
    );
    if (!rows[0]) throw badRequest('Start setup first.');
    if (!verifyTotp(decrypt(key(), rows[0].secret_enc), code))
      throw badRequest("That code didn't match. Check your phone's clock and try the newest code.", { fields: { code: 'Incorrect code.' } });
    const { codes, hashes } = newRecoveryCodes();
    await tx(db, async (c) => {
      await c.query(`UPDATE mfa_factors SET confirmed_at = now() WHERE id = $1`, [rows[0]!.id]);
      await c.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [u.id]);
      await c.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [u.id]);
      await c.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])`, [u.id, hashes]);
      await securityEvent(c, u.id, 'mfa_enabled', req.ip);
      await notify(c, ctx.realtime, { userId: u.id, category: 'security', type: 'mfa_enabled' });
    });
    return { enabled: true, recoveryCodes: codes };
  });

  app.post('/v1/auth/mfa/recovery-codes', { preHandler: requireAuth, config: limit }, async (req) => {
    const u = me(req);
    const { code } = parse(codeSchema, req.body);
    const f = await confirmedSecret(u.id);
    if (!f || !verifyTotp(f.secret, code)) throw badRequest('Enter a current code from your authenticator app.');
    const { codes, hashes } = newRecoveryCodes();
    await tx(db, async (c) => {
      await c.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [u.id]);
      await c.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])`, [u.id, hashes]);
      await securityEvent(c, u.id, 'mfa_recovery_codes_regenerated', req.ip);
    });
    return { recoveryCodes: codes };
  });

  /** Turning MFA off needs the password and a second factor. */
  app.post('/v1/auth/mfa/disable', { preHandler: requireAuth, config: limit }, async (req) => {
    const u = me(req);
    const input = parse(z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(12) }), req.body);
    const pw = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [u.id]);
    if (!(await verifyPassword(input.password, pw.rows[0]?.password_hash)))
      throw badRequest('Your password is incorrect.', { fields: { password: 'Incorrect.' } });
    if (!(await checkSecondFactor(u.id, input.code))) throw badRequest("That code didn't match.", { fields: { code: 'Incorrect code.' } });
    await tx(db, async (c) => {
      await c.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND kind = 'totp'`, [u.id]);
      await c.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [u.id]);
      await c.query(`UPDATE users SET mfa_enabled = false WHERE id = $1`, [u.id]);
      await securityEvent(c, u.id, 'mfa_disabled', req.ip);
      await notify(c, ctx.realtime, { userId: u.id, category: 'security', type: 'mfa_disabled' });
    });
    return { enabled: false };
  });

  /** Login step 2: exchange the challenge + code for a session. */
  app.post('/v1/auth/mfa/verify', { config: limit }, async (req, reply) => {
    const input = parse(z.object({ challengeToken: z.string().min(20).max(200), code: z.string().trim().min(6).max(12) }), req.body);
    const { rows } = await db.query<{ id: string; user_id: string; attempts: number }>(
      `UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, user_id, attempts`,
      [hashToken(input.challengeToken)],
    );
    const ch = rows[0];
    if (!ch) throw unauthorized('This sign-in expired. Enter your email and password again.');
    if (ch.attempts > MAX_ATTEMPTS) {
      await db.query(`UPDATE mfa_challenges SET used_at = now() WHERE id = $1`, [ch.id]);
      await securityEvent(db, ch.user_id, 'mfa_locked', req.ip);
      throw new AppError(429, 'too_many_attempts', 'Too many wrong codes. Sign in again.');
    }
    const via = await checkSecondFactor(ch.user_id, input.code);
    if (!via) {
      await securityEvent(db, ch.user_id, 'mfa_failed', req.ip);
      throw badRequest("That code didn't match. Try the newest code, or a recovery code.", { fields: { code: 'Incorrect code.' } });
    }
    await db.query(`UPDATE mfa_challenges SET used_at = now() WHERE id = $1`, [ch.id]);
    if (via === 'recovery') await notify(db, ctx.realtime, { userId: ch.user_id, category: 'security', type: 'mfa_recovery_code_used' });
    return finishLogin(req, reply, ch.user_id);
  });
}
