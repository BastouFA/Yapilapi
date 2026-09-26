import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, conflict, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { securityEvent } from '../lib/services.ts';
import { CODE_TTL_MS, normalizePhone, SmsError } from '../lib/sms.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Limits on sending codes. Counted in the database, so they hold across API instances and restarts. */
export const SMS_LIMITS = {
  /** Wait this long before asking for another code to the same number. */
  resendAfterSeconds: 30,
  perPhonePerHour: 5,
  perIpPerHour: 10,
  perAccountPerDay: 10,
  /** Wrong guesses allowed per code. */
  attemptsPerCode: 5,
} as const;

const tooMany = (message: string, retryAfterSeconds: number) => new AppError(429, 'rate_limited', message, { retryAfterSeconds });

/**
 * Phone verification: an extra way (besides email) to confirm an account, which
 * unlocks posting publicly, messaging people who aren't friends and going live
 * when REQUIRE_VERIFICATION is on.
 *   PUT    /v1/me/phone         add or change the number (unconfirmed)
 *   POST   /v1/me/phone/code    text a 6-digit code to it
 *   POST   /v1/me/phone/verify  confirm it with the code
 *   DELETE /v1/me/phone         remove it
 *   GET    /v1/me/verification  email and phone status, and whether confirming is required
 */
export default async function phoneModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function status(userId: string) {
    const { rows } = await db.query(`SELECT email, email_verified_at, phone_e164, phone_verified_at FROM users WHERE id = $1`, [userId]);
    const r = rows[0];
    const verified = !!r.email_verified_at || !!r.phone_verified_at;
    return {
      email: { address: r.email as string, verified: !!r.email_verified_at },
      phone: r.phone_e164 ? { number: r.phone_e164 as string, verified: !!r.phone_verified_at } : null,
      verified,
      required: ctx.config.REQUIRE_VERIFICATION,
    };
  }

  app.get('/v1/me/verification', { preHandler: requireAuth }, async (req) => status(me(req).id));

  app.put('/v1/me/phone', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const input = parse(z.object({ phone: z.string().trim().min(4).max(32) }), req.body);
    const phone = normalizePhone(input.phone);
    if (!phone)
      throw badRequest('Enter the number with its country code, for example +44 7700 900123.', {
        fields: { phone: 'Include the country code, starting with +.' },
      });
    const taken = await db.query(`SELECT 1 FROM users WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL AND deleted_at IS NULL AND id <> $2`, [
      phone,
      u.id,
    ]);
    if (taken.rowCount) throw new AppError(409, 'conflict', 'That number is already confirmed on another account.', { fields: { phone: 'Already in use.' } });
    // Changing the number means confirming the new one.
    await db.query(
      `UPDATE users SET phone_verified_at = CASE WHEN phone_e164 = $2 THEN phone_verified_at END, phone_e164 = $2, updated_at = now() WHERE id = $1`,
      [u.id, phone],
    );
    return status(u.id);
  });

  app.delete('/v1/me/phone', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const r = await db.query(`UPDATE users SET phone_e164 = NULL, phone_verified_at = NULL, updated_at = now() WHERE id = $1 RETURNING 1`, [u.id]);
    if (r.rowCount) await securityEvent(db, u.id, 'phone_removed', req.ip, req.headers['user-agent']);
    return status(u.id);
  });

  app.post('/v1/me/phone/code', { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(`SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`, [u.id]);
    const phone = rows[0]?.phone_e164 as string | null;
    if (!phone) throw badRequest('Add a phone number first.');
    if (rows[0].phone_verified_at) return { sent: false, alreadyVerified: true, ...(await status(u.id)) };

    const counts = (
      await db.query(
        `SELECT
           (SELECT extract(epoch FROM now() - max(created_at)) FROM phone_verifications WHERE phone_e164 = $1 AND created_at > now() - interval '1 hour') AS since_last,
           (SELECT count(*) FROM phone_verifications WHERE phone_e164 = $1 AND created_at > now() - interval '1 hour')::int AS per_phone,
           (SELECT count(*) FROM phone_verifications WHERE ip = $2::inet AND created_at > now() - interval '1 hour')::int AS per_ip,
           (SELECT count(*) FROM phone_verifications WHERE user_id = $3 AND created_at > now() - interval '1 day')::int AS per_account`,
        [phone, req.ip, u.id],
      )
    ).rows[0];
    const since = counts.since_last === null ? null : Number(counts.since_last);
    if (since !== null && since < SMS_LIMITS.resendAfterSeconds) {
      const wait = Math.ceil(SMS_LIMITS.resendAfterSeconds - since);
      throw tooMany(`We just sent a code. You can ask for another in ${wait} seconds.`, wait);
    }
    if (counts.per_phone >= SMS_LIMITS.perPhonePerHour) throw tooMany('Too many codes were sent to this number. Try again in an hour.', 3600);
    if (counts.per_ip >= SMS_LIMITS.perIpPerHour) throw tooMany('Too many codes were requested from this network. Try again in an hour.', 3600);
    if (counts.per_account >= SMS_LIMITS.perAccountPerDay) throw tooMany('You’ve asked for a lot of codes today. Try again tomorrow.', 86400);

    try {
      await ctx.sms.sendCode(phone);
    } catch (e) {
      if (e instanceof SmsError)
        throw new AppError(
          e.kind === 'rate_limited' ? 429 : e.kind === 'invalid_number' ? 400 : 503,
          e.kind === 'invalid_number' ? 'bad_request' : e.kind,
          e.message,
        );
      throw e;
    }
    await db.query(`INSERT INTO phone_verifications (user_id, phone_e164, ip, provider, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`, [
      u.id,
      phone,
      req.ip,
      ctx.sms.name,
      CODE_TTL_MS / 1000,
    ]);
    return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000, resendAfterSeconds: SMS_LIMITS.resendAfterSeconds };
  });

  app.post('/v1/me/phone/verify', { preHandler: requireAuth, config: { rateLimit: { max: 15, timeWindow: '10 minutes' } } }, async (req) => {
    const u = me(req);
    const { code } = parse(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{4,10}$/, 'Enter the code from the text message.'),
      }),
      req.body,
    );
    const { rows } = await db.query(`SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`, [u.id]);
    const phone = rows[0]?.phone_e164 as string | null;
    if (!phone) throw badRequest('Add a phone number first.');
    if (rows[0].phone_verified_at) return status(u.id);
    // Count the guess before checking it, so parallel requests can't exceed the limit.
    const attempt = await db.query<{ id: string; attempts: number }>(
      `UPDATE phone_verifications SET attempts = attempts + 1
       WHERE id = (SELECT id FROM phone_verifications WHERE user_id = $1 AND phone_e164 = $2 AND verified_at IS NULL AND expires_at > now()
                   ORDER BY created_at DESC LIMIT 1)
       RETURNING id, attempts`,
      [u.id, phone],
    );
    const v = attempt.rows[0];
    if (!v) throw badRequest('That code has expired. Ask for a new one.', { fields: { code: 'Expired.' } });
    if (v.attempts > SMS_LIMITS.attemptsPerCode) throw tooMany('Too many tries with this code. Ask for a new one.', SMS_LIMITS.resendAfterSeconds);
    let result: Awaited<ReturnType<typeof ctx.sms.checkCode>>;
    try {
      result = await ctx.sms.checkCode(phone, code);
    } catch (e) {
      if (e instanceof SmsError) throw new AppError(503, 'unavailable', e.message);
      throw e;
    }
    if (result === 'expired') throw badRequest('That code has expired. Ask for a new one.', { fields: { code: 'Expired.' } });
    if (result === 'invalid') throw badRequest('That code isn’t right. Check the text message and try again.', { fields: { code: 'Incorrect.' } });
    await tx(db, async (c) => {
      await c.query(`UPDATE phone_verifications SET verified_at = now() WHERE id = $1`, [v.id]);
      await c.query(`UPDATE users SET phone_verified_at = now(), updated_at = now() WHERE id = $1 AND phone_e164 = $2`, [u.id, phone]).catch((e) => {
        // Another account confirmed the same number first.
        if (e.code === '23505') throw conflict('That number is already confirmed on another account.');
        throw e;
      });
      await securityEvent(c, u.id, 'phone_verified', req.ip, req.headers['user-agent']);
    });
    return status(u.id);
  });
}
