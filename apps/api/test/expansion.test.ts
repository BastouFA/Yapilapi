import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totp } from '@yapilapi/auth';
import { processWebhooks } from '../src/lib/webhooks.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  // Leave feature flags at their defaults for other suites.
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key IN ('LIVE', 'MEMORY')`);
  await t.close();
});

const login = (email: string, password: string) => as(t.app, null).post('/v1/auth/login', { email, password });

describe('two-step verification', () => {
  let u: TestUser;
  let secret: Buffer;
  let recovery: string[];

  it('sets up TOTP, requires a valid code to confirm, and returns recovery codes', async () => {
    u = await signUp(t.app);
    const setup = await as(t.app, u).post('/v1/auth/mfa/totp/setup');
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/YAPILAPI/);
    secret = base32Decode(setup.body.secret);
    expect((await as(t.app, u).post('/v1/auth/mfa/totp/confirm', { code: '000000' })).status).toBe(400);
    const ok = await as(t.app, u).post('/v1/auth/mfa/totp/confirm', { code: totp(secret) });
    expect(ok.body.enabled).toBe(true);
    recovery = ok.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await as(t.app, u).get('/v1/auth/mfa')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    // The secret is stored encrypted, never in plain text.
    const row = (await t.ctx.db.query(`SELECT secret_enc FROM mfa_factors WHERE user_id = $1`, [u.id])).rows[0];
    expect(row.secret_enc.includes(secret)).toBe(false);
  });

  it('a password alone only yields a challenge; the code completes sign-in', async () => {
    const first = await login(u.email, u.password);
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.token).toBeUndefined();
    expect((await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: '123456' })).status).toBe(400);
    const done = await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: totp(secret) });
    expect(done.status).toBe(200);
    expect(done.body.token).toBeTruthy();
    // Challenges are single use.
    expect((await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: totp(secret) })).status).toBe(401);
  });

  it('recovery codes work once', async () => {
    const c1 = await login(u.email, u.password);
    expect((await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: c1.body.challengeToken, code: recovery[0] })).status).toBe(200);
    const c2 = await login(u.email, u.password);
    expect((await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: c2.body.challengeToken, code: recovery[0] })).status).toBe(400);
  });

  it('locks a challenge after too many wrong codes', async () => {
    const c = await login(u.email, u.password);
    for (let i = 0; i < 5; i++) await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: c.body.challengeToken, code: '000000' });
    const r = await as(t.app, null).post('/v1/auth/mfa/verify', { challengeToken: c.body.challengeToken, code: totp(secret) });
    expect(r.status).toBe(429);
  });

  it('disabling needs the password and a code', async () => {
    expect((await as(t.app, u).post('/v1/auth/mfa/disable', { password: 'nope', code: totp(secret) })).status).toBe(400);
    expect((await as(t.app, u).post('/v1/auth/mfa/disable', { password: u.password, code: totp(secret) })).body.enabled).toBe(false);
    expect((await login(u.email, u.password)).body.token).toBeTruthy();
  });
});

describe('developer platform', () => {
  let dev: TestUser;
  let appId: string;
  let readKey: string;
  let writeKey: string;
  let server: Server;
  let url: string;
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let failNext = 0;

  beforeAll(async () => {
    dev = await signUp(t.app);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = failNext-- > 0 ? 500 : 204;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('creates an app and keys; the full key is shown once and stored hashed', async () => {
    appId = (await as(t.app, dev).post('/v1/developer/apps', { name: 'Test Integration' })).body.app.id;
    const k1 = await as(t.app, dev).post(`/v1/developer/apps/${appId}/keys`, { name: 'reader', scopes: ['read'] });
    readKey = k1.body.secret;
    writeKey = (await as(t.app, dev).post(`/v1/developer/apps/${appId}/keys`, { name: 'writer', scopes: ['read', 'write'] })).body.secret;
    expect(readKey).toMatch(/^ypl_[0-9a-f]{8}_/);
    const list = await as(t.app, dev).get(`/v1/developer/apps/${appId}/keys`);
    expect(JSON.stringify(list.body)).not.toContain(readKey);
  });

  it('enforces scopes and blocks sensitive endpoints for keys', async () => {
    const reader = { ...dev, token: readKey };
    const writer = { ...dev, token: writeKey };
    expect((await as(t.app, reader).get('/v1/feed')).status).toBe(200);
    expect((await as(t.app, reader).post('/v1/posts', { body: 'via key' })).status).toBe(403);
    expect((await as(t.app, writer).post('/v1/posts', { body: 'Posted from an integration' })).status).toBe(201);
    for (const path of ['/v1/auth/sessions', '/v1/me/export', '/v1/developer/apps', '/v1/admin/audit-logs'])
      expect((await as(t.app, writer).get(path)).status).toBe(403);
    expect((await as(t.app, writer).del('/v1/me', { password: dev.password })).status).toBe(403);
  });

  it('revoked keys stop working immediately', async () => {
    const keys = (await as(t.app, dev).get(`/v1/developer/apps/${appId}/keys`)).body.items;
    const reader = keys.find((k: { name: string }) => k.name === 'reader');
    await as(t.app, dev).del(`/v1/developer/apps/${appId}/keys/${reader.id}`);
    expect((await as(t.app, { ...dev, token: readKey }).get('/v1/feed')).status).toBe(401);
  });

  it('delivers signed webhooks and retries failures', async () => {
    const sub = await as(t.app, dev).post(`/v1/developer/apps/${appId}/webhooks`, { url, events: ['post.created', 'follower.new'] });
    expect(sub.status).toBe(201);
    const secret: string = sub.body.secret;
    expect((await as(t.app, dev).post(`/v1/developer/apps/${appId}/webhooks`, { url: 'http://10.0.0.5/x', events: ['ping'] })).status).toBe(400);

    failNext = 1;
    await as(t.app, dev).post('/v1/posts', { body: 'This should reach the webhook' });
    await processWebhooks(t.ctx.db, { allowLocal: true });
    expect(received).toHaveLength(1);
    const pending = (await as(t.app, dev).get(`/v1/developer/apps/${appId}/webhooks`)).body.deliveries[0];
    expect(pending).toMatchObject({ status: 'pending', attempts: 1, response_code: 500 });

    await t.ctx.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'pending'`);
    await processWebhooks(t.ctx.db, { allowLocal: true });
    const last = received.at(-1)!;
    expect(last.headers['x-yapilapi-event']).toBe('post.created');
    const sig = String(last.headers['x-yapilapi-signature']);
    const [, ts, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
    expect(createHmac('sha256', secret).update(`${ts}.${last.body}`).digest('hex')).toBe(v1);
    expect(JSON.parse(last.body)).toMatchObject({ type: 'post.created', data: { kind: 'text' } });
    expect((await as(t.app, dev).get(`/v1/developer/apps/${appId}/webhooks`)).body.deliveries[0].status).toBe('delivered');
  });
});

describe('memory', () => {
  let a: TestUser;
  let b: TestUser;
  beforeAll(async () => {
    a = await signUp(t.app);
    b = await signUp(t.app);
  });

  it('is off until the MEMORY flag is on', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('MEMORY', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    expect((await as(t.app, a).get('/v1/memories')).status).toBe(404);
    await t.ctx.db.query(`UPDATE feature_flags SET enabled = true WHERE key = 'MEMORY'`);
    expect((await as(t.app, a).get('/v1/memories')).status).toBe(200);
  });

  it('builds a memory from an event, recaps it, and shares only with friends', async () => {
    const startsAt = new Date(Date.now() - 5 * 3600_000).toISOString();
    const endsAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const ev = (await as(t.app, a).post('/v1/events', { title: 'Beach cleanup', startsAt, endsAt })).body.event;
    await as(t.app, a).post('/v1/posts', { body: 'We filled 30 bags of rubbish at the beach', eventId: ev.id });
    const secret = (await as(t.app, b).post('/v1/posts', { body: 'Only me', visibility: 'private', eventId: ev.id })).body.post;

    const sugg = await as(t.app, a).get('/v1/memories/suggestions');
    expect(sugg.body.events.some((e: { id: string }) => e.id === ev.id)).toBe(true);

    const { memoryId } = (await as(t.app, a).post(`/v1/memories/from-event/${ev.id}`)).body;
    const m = await as(t.app, a).get(`/v1/memories/${memoryId}`);
    expect(m.body.posts.map((p: { body: string }) => p.body)).toEqual(['We filled 30 bags of rubbish at the beach']);
    expect(m.body.events[0].id).toBe(ev.id);
    // Someone else's private post can't be added.
    expect((await as(t.app, a).post(`/v1/memories/${memoryId}/items`, { itemType: 'post', itemId: secret.id })).status).toBe(404);

    const recap = await as(t.app, a).post(`/v1/memories/${memoryId}/recap`);
    expect(recap.body.recap).toContain('30 bags');

    expect((await as(t.app, b).get(`/v1/memories/${memoryId}`)).status).toBe(404);
    expect((await as(t.app, a).put(`/v1/memories/${memoryId}/shares`, { userIds: [b.id] })).status).toBe(403);
    await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
    const req = (await as(t.app, b).get('/v1/me/friend-requests')).body.items[0];
    await as(t.app, b).post(`/v1/friend-requests/${req.id}/accept`);
    expect((await as(t.app, a).put(`/v1/memories/${memoryId}/shares`, { userIds: [b.id] })).body.visibility).toBe('selected');
    expect((await as(t.app, b).get(`/v1/memories/${memoryId}`)).status).toBe(200);
    expect((await as(t.app, b).post(`/v1/memories/${memoryId}/recap`)).status).toBe(404);
  });
});

describe('live', () => {
  let host: TestUser;
  let fan: TestUser;
  let troll: TestUser;
  beforeAll(async () => {
    host = await signUp(t.app);
    fan = await signUp(t.app);
    troll = await signUp(t.app);
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
  });

  it('runs a live session with chat, Q&A, moderation and ending', async () => {
    const created = await as(t.app, host).post('/v1/live', { title: 'Friday Q&A' });
    expect(created.status).toBe(201);
    expect(created.body.ingest.streamKey).toMatch(/^[0-9a-f-]{36}\?key=sk_/);
    const id = created.body.live.id;
    expect((await as(t.app, fan).post(`/v1/live/${id}/join`)).status).toBe(400);
    expect((await as(t.app, fan).post(`/v1/live/${id}/start`)).status).toBe(400);
    expect((await as(t.app, host).post(`/v1/live/${id}/start`)).body.live.status).toBe('live');

    expect((await as(t.app, fan).post(`/v1/live/${id}/join`)).body.live.viewers).toBe(1);
    expect((await as(t.app, fan).post(`/v1/live/${id}/chat`, { body: 'Hello from the audience' })).status).toBe(201);
    expect((await as(t.app, fan).post(`/v1/live/${id}/chat`, { body: 'How do you start?', kind: 'question' })).status).toBe(201);
    expect((await as(t.app, troll).post(`/v1/live/${id}/chat`, { body: 'hi' })).status).toBe(403);
    await as(t.app, troll).post(`/v1/live/${id}/join`);
    await as(t.app, host).post(`/v1/live/${id}/ban`, { userId: troll.id });
    expect((await as(t.app, troll).post(`/v1/live/${id}/join`)).status).toBe(403);

    const chat = await as(t.app, host).get(`/v1/live/${id}/chat`);
    expect(chat.body.items.map((m: { kind: string }) => m.kind)).toEqual(['chat', 'question']);

    expect((await as(t.app, host).post(`/v1/live/${id}/end`)).body.live.status).toBe('ended');
    expect((await as(t.app, fan).post(`/v1/live/${id}/chat`, { body: 'late' })).status).toBe(400);
    const notes = await as(t.app, fan).get('/v1/notifications');
    void notes;
  });
});
