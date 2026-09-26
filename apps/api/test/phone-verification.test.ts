import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { normalizePhone, SmsError, twilioSmsProvider, type DevSms } from '../src/lib/sms.ts';

let t: BuiltApp;
let gated: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  // The same API with the production rule on: reaching people beyond your friends needs a confirmed email or phone.
  gated = await testApp({ REQUIRE_VERIFICATION: 'true' });
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'LIVE'`);
  await t.close();
  await gated.close();
});

let phoneN = 0;
/** A number no other test uses (+44 7700 9xxxxx is reserved for drama; fine for tests). */
const freshPhone = () => `+4477009${String(Date.now() % 100000).padStart(5, '0')}${++phoneN}`.slice(0, 16);

/** Requests from a given address (the API trusts X-Forwarded-For, as it does behind the load balancer). */
function from(app: BuiltApp, user: TestUser, ip: string) {
  return async (method: 'POST' | 'PUT', url: string, payload: unknown = {}) => {
    const res = await app.app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${user.token}`, 'x-forwarded-for': ip } });
    return { status: res.statusCode, body: res.json() as any };
  };
}

const outbox = (app: BuiltApp) => (app.ctx.sms as unknown as { outbox: DevSms[] }).outbox;
const lastCode = (app: BuiltApp, phone: string) =>
  outbox(app)
    .filter((m) => m.to === phone)
    .at(-1)?.code;
/** Let the next code be sent without waiting out the 30-second resend gap. */
const skipResendWait = (app: BuiltApp, userId: string) =>
  app.ctx.db.query(`UPDATE phone_verifications SET created_at = created_at - interval '1 minute' WHERE user_id = $1`, [userId]);

describe('phone numbers', () => {
  it('normalizes what people type into E.164', () => {
    expect(normalizePhone('+44 7700 900-123')).toBe('+447700900123');
    expect(normalizePhone('0044 (7700) 900123')).toBe('+447700900123');
    expect(normalizePhone('07700 900123')).toBeNull();
    expect(normalizePhone('+0 123')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
  });

  it('adds a number, texts a code with the dev provider and confirms it', async () => {
    const u = await signUp(t.app);
    const api = as(t.app, u);
    expect((await api.put('/v1/me/phone', { phone: '12345' })).status).toBe(400);
    const phone = freshPhone();
    const added = await api.put('/v1/me/phone', { phone: phone.replace(/^\+44/, '+44 ') });
    expect(added.status).toBe(200);
    expect(added.body.phone).toEqual({ number: phone, verified: false });

    // Nothing to check before a code is sent.
    expect((await api.post('/v1/me/phone/verify', { code: '123456' })).status).toBe(400);
    const sent = await api.post('/v1/me/phone/code');
    expect(sent.body).toMatchObject({ sent: true, expiresInSeconds: 600 });
    const code = lastCode(t, phone)!;
    expect(code).toMatch(/^\d{6}$/);
    // The dev outbox route shows the same message to the web app in development.
    const dev = await t.app.inject({ method: 'GET', url: '/dev/sms-outbox' });
    expect(dev.json().items.some((m: DevSms) => m.to === phone && m.body.includes(code))).toBe(true);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    const bad = await api.post('/v1/me/phone/verify', { code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/isn’t right/);
    const ok = await api.post('/v1/me/phone/verify', { code });
    expect(ok.status).toBe(200);
    expect(ok.body.phone).toEqual({ number: phone, verified: true });
    const me = (await api.get('/v1/auth/me')).body.user;
    expect(me).toMatchObject({ phone, phoneVerified: true, needsVerification: false });

    // Changing the number needs a new confirmation; removing it clears it.
    const other = freshPhone();
    expect((await api.put('/v1/me/phone', { phone: other })).body.phone).toEqual({ number: other, verified: false });
    expect((await api.del('/v1/me/phone')).body.phone).toBeNull();
  });

  it('keeps a confirmed number on one account', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const phone = freshPhone();
    await as(t.app, a).put('/v1/me/phone', { phone });
    await as(t.app, a).post('/v1/me/phone/code');
    await as(t.app, a).post('/v1/me/phone/verify', { code: lastCode(t, phone) });
    const taken = await as(t.app, b).put('/v1/me/phone', { phone });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toMatch(/already confirmed on another account/);
  });

  it('limits guesses per code', async () => {
    const u = await signUp(t.app);
    const api = as(t.app, u);
    const phone = freshPhone();
    await api.put('/v1/me/phone', { phone });
    await api.post('/v1/me/phone/code');
    const code = lastCode(t, phone)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await api.post('/v1/me/phone/verify', { code: wrong })).status).toBe(400);
    const locked = await api.post('/v1/me/phone/verify', { code });
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toMatch(/Ask for a new one/);
  });

  it('rate limits codes per number and per network', async () => {
    const u = await signUp(t.app);
    const phone = freshPhone();
    const call = from(t, u, '192.0.2.10');
    await call('PUT', '/v1/me/phone', { phone });
    expect((await call('POST', '/v1/me/phone/code')).status).toBe(200);
    // Right away again: wait a little.
    const soon = await call('POST', '/v1/me/phone/code');
    expect(soon.status).toBe(429);
    expect(soon.body.error.message).toMatch(/seconds/);
    for (let i = 0; i < 4; i++) {
      await skipResendWait(t, u.id);
      expect((await call('POST', '/v1/me/phone/code')).status).toBe(200);
    }
    await skipResendWait(t, u.id);
    const perPhone = await call('POST', '/v1/me/phone/code');
    expect(perPhone.status).toBe(429);
    expect(perPhone.body.error.message).toMatch(/this number/);

    // Ten accounts on one network, one code each: the eleventh request waits.
    const ip = '192.0.2.77';
    for (let i = 0; i < 10; i++) {
      const v = await signUp(t.app);
      const c = from(t, v, ip);
      await c('PUT', '/v1/me/phone', { phone: freshPhone() });
      expect((await c('POST', '/v1/me/phone/code')).status).toBe(200);
    }
    const last = await signUp(t.app);
    const c = from(t, last, ip);
    await c('PUT', '/v1/me/phone', { phone: freshPhone() });
    const perIp = await c('POST', '/v1/me/phone/code');
    expect(perIp.status).toBe(429);
    expect(perIp.body.error.message).toMatch(/this network/);
  });
});

describe('Twilio Verify adapter', () => {
  it('starts and checks verifications over the REST API', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let reply: { status: number; body: unknown } = { status: 201, body: { sid: 'VE1', status: 'pending' } };
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    const sms = twilioSmsProvider({ accountSid: 'AC123', authToken: 'secret', serviceSid: 'VA456', fetch: fakeFetch });

    await sms.sendCode('+447700900123');
    expect(calls[0]!.url).toBe('https://verify.twilio.com/v2/Services/VA456/Verifications');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('AC123:secret').toString('base64')}`);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ To: '+447700900123', Channel: 'sms' });

    reply = { status: 200, body: { status: 'approved', valid: true } };
    expect(await sms.checkCode('+447700900123', '123456')).toBe('approved');
    expect(calls[1]!.url).toBe('https://verify.twilio.com/v2/Services/VA456/VerificationCheck');
    expect(Object.fromEntries(new URLSearchParams(String(calls[1]!.init.body)))).toEqual({ To: '+447700900123', Code: '123456' });

    reply = { status: 200, body: { status: 'pending', valid: false } };
    expect(await sms.checkCode('+447700900123', '000000')).toBe('invalid');
    reply = { status: 404, body: { code: 20404 } };
    expect(await sms.checkCode('+447700900123', '000000')).toBe('expired');

    reply = { status: 400, body: { code: 60200, message: 'Invalid parameter `To`' } };
    await expect(sms.sendCode('+10000000000')).rejects.toMatchObject({ kind: 'invalid_number' });
    reply = { status: 429, body: { code: 60203 } };
    await expect(sms.sendCode('+447700900123')).rejects.toBeInstanceOf(SmsError);
  });
});

describe('verification requirement', () => {
  it('is off by default outside production', async () => {
    const u = await signUp(t.app);
    const me = (await as(t.app, u).get('/v1/auth/me')).body.user;
    expect(me.needsVerification).toBe(false);
    expect((await as(t.app, u).post('/v1/posts', { body: 'Hello everyone', visibility: 'public' })).status).toBe(201);
  });

  it('asks for a confirmed email or phone before posting publicly, messaging non-friends or going live', async () => {
    const u = await signUp(gated.app, { birthDate: '1990-01-01' });
    const stranger = await signUp(gated.app, { birthDate: '1990-01-01' });
    const friend = await signUp(gated.app, { birthDate: '1990-01-01' });
    const [a, b] = [u.id, friend.id].sort();
    await gated.ctx.db.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2)`, [a, b]);
    const api = as(gated.app, u);

    expect((await api.get('/v1/auth/me')).body.user.needsVerification).toBe(true);
    expect((await api.get('/v1/me/verification')).body).toMatchObject({ verified: false, required: true, phone: null });

    const pub = await api.post('/v1/posts', { body: 'Hello everyone', visibility: 'public' });
    expect(pub.status).toBe(403);
    expect(pub.body.error.code).toBe('verification_required');
    expect(pub.body.error.message).toMatch(/Confirm your email or phone number to post publicly/);
    // Friends-only posts and messages to friends still work.
    expect((await api.post('/v1/posts', { body: 'Hello friends', visibility: 'friends' })).status).toBe(201);
    expect((await api.post('/v1/conversations', { memberIds: [friend.id] })).status).toBe(201);
    const dm = await api.post('/v1/conversations', { memberIds: [stranger.id] });
    expect(dm.status).toBe(403);
    expect(dm.body.error.code).toBe('verification_required');
    const live = await api.post('/v1/live', { title: 'Evening chat' });
    expect(live.status).toBe(403);
    expect(live.body.error.code).toBe('verification_required');

    // Confirming a phone number unlocks all three.
    const phone = freshPhone();
    await api.put('/v1/me/phone', { phone });
    await api.post('/v1/me/phone/code');
    await api.post('/v1/me/phone/verify', { code: lastCode(gated, phone) });
    expect((await api.get('/v1/auth/me')).body.user.needsVerification).toBe(false);
    expect((await api.post('/v1/posts', { body: 'Hello everyone', visibility: 'public' })).status).toBe(201);
    expect((await api.post('/v1/conversations', { memberIds: [stranger.id] })).status).toBe(201);
    expect((await api.post('/v1/live', { title: 'Evening chat' })).status).toBe(201);
  });

  it('accepts a confirmed email instead', async () => {
    const u = await signUp(gated.app);
    const mail = gated.ctx.email.outbox!.filter((e) => e.to === u.email).at(-1)!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    expect((await as(gated.app, null).post('/v1/auth/verify-email', { token })).status).toBe(200);
    expect((await as(gated.app, u).post('/v1/posts', { body: 'Hello everyone', visibility: 'public' })).status).toBe(201);
  });
});
