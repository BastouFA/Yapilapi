import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport as AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { badRequest, notFound, parse, unauthorized } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { notify, securityEvent } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

type FinishLogin = (req: FastifyRequest, reply: FastifyReply, userId: string) => Promise<unknown>;

/**
 * Passkeys (WebAuthn). Phishing-resistant sign-in bound to this site's origin.
 * A passkey sign-in counts as both factors, so it skips the TOTP step.
 */
export function registerPasskeys(app: FastifyInstance, ctx: AppContext, finishLogin: FinishLogin) {
  const db = ctx.db;
  const rpID = ctx.config.WEBAUTHN_RP_ID || new URL(ctx.config.WEB_ORIGIN.split(',')[0]!).hostname;
  const origin = ctx.config.WEBAUTHN_ORIGIN || ctx.config.WEB_ORIGIN.split(',')[0]!;
  const limit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  async function saveChallenge(purpose: 'register' | 'login', challenge: string, userId: string | null) {
    const { rows } = await db.query(
      `INSERT INTO webauthn_challenges (user_id, purpose, challenge, expires_at) VALUES ($1,$2,$3, now() + interval '5 minutes') RETURNING id`,
      [userId, purpose, challenge],
    );
    return rows[0].id as string;
  }

  async function takeChallenge(id: string, purpose: string, userId: string | null) {
    const { rows } = await db.query(
      `UPDATE webauthn_challenges SET used_at = now() WHERE id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() AND ($3::uuid IS NULL OR user_id = $3) RETURNING challenge`,
      [id, purpose, userId],
    );
    if (!rows[0]) throw badRequest('This request expired. Try again.');
    return rows[0].challenge as string;
  }

  app.get('/v1/auth/passkeys', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT id, label, device_type, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at`, [
      me(req).id,
    ]);
    return { items: rows };
  });

  app.post('/v1/auth/passkeys/register/options', { preHandler: requireAuth, config: limit }, async (req) => {
    const u = me(req);
    const existing = await db.query(`SELECT credential_id, transports FROM passkeys WHERE user_id = $1`, [u.id]);
    const profile = (await db.query(`SELECT username, display_name FROM profiles WHERE user_id = $1`, [u.id])).rows[0];
    const options = await generateRegistrationOptions({
      rpName: 'YAPILAPI',
      rpID,
      userName: profile.username,
      userDisplayName: profile.display_name,
      userID: new TextEncoder().encode(u.id),
      attestationType: 'none',
      excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id, transports: r.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = await saveChallenge('register', options.challenge, u.id);
    return { options, challengeId };
  });

  app.post('/v1/auth/passkeys/register/verify', { preHandler: requireAuth, config: limit }, async (req) => {
    const u = me(req);
    const input = parse(z.object({ challengeId: z.string().uuid(), response: z.any(), label: z.string().trim().max(60).default('Passkey') }), req.body);
    const expectedChallenge = await takeChallenge(input.challengeId, 'register', u.id);
    let result;
    try {
      result = await verifyRegistrationResponse({ response: input.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
    } catch (e) {
      throw badRequest(`This passkey couldn't be verified: ${(e as Error).message}`);
    }
    if (!result.verified || !result.registrationInfo) throw badRequest("This passkey couldn't be verified.");
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    await db.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        u.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports ?? [],
        credentialDeviceType,
        credentialBackedUp,
        input.label,
      ],
    );
    await securityEvent(db, u.id, 'passkey_added', req.ip);
    await notify(db, ctx.realtime, { userId: u.id, category: 'security', type: 'passkey_added' });
    return { ok: true };
  });

  app.delete('/v1/auth/passkeys/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await db.query(`DELETE FROM passkeys WHERE id = $1 AND user_id = $2`, [id, u.id]);
    if (!r.rowCount) throw notFound('Passkey');
    await securityEvent(db, u.id, 'passkey_removed', req.ip);
    return { ok: true };
  });

  /** Usernameless sign-in: the browser offers the passkeys it holds for this site. */
  app.post('/v1/auth/passkeys/login/options', { config: limit }, async () => {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const challengeId = await saveChallenge('login', options.challenge, null);
    return { options, challengeId };
  });

  app.post('/v1/auth/passkeys/login/verify', { config: limit }, async (req, reply) => {
    const input = parse(z.object({ challengeId: z.string().uuid(), response: z.object({ id: z.string() }).passthrough() }), req.body);
    const expectedChallenge = await takeChallenge(input.challengeId, 'login', null);
    const { rows } = await db.query(`SELECT p.*, u.status FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = $1`, [input.response.id]);
    const pk = rows[0];
    if (!pk || pk.status !== 'active') throw unauthorized("That passkey isn't registered here. Sign in with your password.");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: input.response as never,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
      });
    } catch {
      await securityEvent(db, pk.user_id, 'passkey_failed', req.ip);
      throw unauthorized("That passkey couldn't be verified.");
    }
    if (!result.verified) throw unauthorized("That passkey couldn't be verified.");
    await db.query(`UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1`, [pk.id, result.authenticationInfo.newCounter]);
    return finishLogin(req, reply, pk.user_id);
  });
}
