import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { CHUNK_SIZE } from '../src/modules/uploads.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key IN ('REAL', 'REAL_TOGETHER')`);
  await t.close();
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const pngOf = (size: number) => Buffer.concat([PNG, randomBytes(size - PNG.length)]);

async function putChunk(app: BuiltApp['app'], u: TestUser, id: string, i: number, data: Buffer) {
  const r = await app.inject({
    method: 'PUT',
    url: `/v1/uploads/${id}/chunks/${i}`,
    payload: data,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream' },
  });
  return { status: r.statusCode, body: r.json() };
}

async function insertMedia(ownerId: string, minutesAgo = 0) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, created_at) VALUES ($1, 'image', 'http://localhost/x.png', 'image/png', now() - make_interval(mins => $2)) RETURNING id`,
    [ownerId, minutesAgo],
  );
  return rows[0].id as string;
}

async function befriend(a: TestUser, b: TestUser) {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  const req = (await as(t.app, b).get('/v1/me/friend-requests')).body.items.find((r: { from: { id: string } }) => r.from.id === a.id);
  await as(t.app, b).post(`/v1/friend-requests/${req.id}/accept`);
}

describe('resumable uploads', () => {
  it('uploads in chunks, resumes, rejects bad chunks, and creates media', async () => {
    const u = await signUp(t.app);
    const file = pngOf(CHUNK_SIZE + 1234);
    const s = await as(t.app, u).post('/v1/uploads', { filename: 'big.png', mime: 'image/png', size: file.length });
    expect(s.body.totalChunks).toBe(2);
    const id = s.body.uploadId;
    expect((await putChunk(t.app, u, id, 1, file.subarray(0, 10))).status).toBe(400);
    expect((await putChunk(t.app, u, id, 1, file.subarray(CHUNK_SIZE))).status).toBe(200);
    // The client reconnects and asks what's missing.
    expect((await as(t.app, u).get(`/v1/uploads/${id}`)).body.missing).toEqual([0]);
    expect((await as(t.app, u).post(`/v1/uploads/${id}/complete`)).status).toBe(400);
    await putChunk(t.app, u, id, 0, file.subarray(0, CHUNK_SIZE));
    await putChunk(t.app, u, id, 0, file.subarray(0, CHUNK_SIZE)); // retries are harmless
    const done = await as(t.app, u).post(`/v1/uploads/${id}/complete`, { altText: 'A test image' });
    expect(done.status).toBe(201);
    expect(done.body.media).toMatchObject({ kind: 'image', altText: 'A test image' });
    const other = await signUp(t.app);
    expect((await as(t.app, other).get(`/v1/uploads/${id}`)).status).toBe(404);
  });

  it('rejects files whose bytes do not match the declared type', async () => {
    const u = await signUp(t.app);
    const s = await as(t.app, u).post('/v1/uploads', { filename: 'fake.png', mime: 'image/png', size: 100 });
    await putChunk(t.app, u, s.body.uploadId, 0, randomBytes(100));
    expect((await as(t.app, u).post(`/v1/uploads/${s.body.uploadId}/complete`)).status).toBe(415);
  });
});

describe('S3 storage', () => {
  it('stores media in the S3-compatible bucket and streams it back with ranges', async () => {
    const cfg = loadConfig({
      ...process.env,
      APP_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_test',
      REDIS_URL: '',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
      S3_BUCKET: 'yapilapi-test-media',
      PUBLIC_API_URL: 'http://api.test',
    });
    const s3app = await buildApp(cfg, { logger: false });
    try {
      const data = pngOf(4096);
      const stored = await s3app.ctx.storage.put(data, 'png', 'image/png');
      expect(stored.url).toBe(`http://api.test/media/${stored.key}`);
      const full = await s3app.app.inject({ url: `/media/${stored.key}` });
      expect(full.statusCode).toBe(200);
      expect(full.rawPayload.equals(data)).toBe(true);
      expect(full.headers['cache-control']).toContain('immutable');
      const part = await s3app.app.inject({ url: `/media/${stored.key}`, headers: { range: 'bytes=0-7' } });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.equals(PNG.subarray(0, 8))).toBe(true);
      expect((await s3app.app.inject({ url: '/media/2026/01/missing.png' })).statusCode).toBe(404);
      expect((await s3app.app.inject({ url: '/media/../etc/passwd' })).statusCode).toBe(404);
    } finally {
      await s3app.close();
    }
  });
});

describe('calls', () => {
  it('rings, relays signaling only between participants, answers and ends', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const c = await signUp(t.app);
    const conv = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] })).body.conversation.id;
    const started = await as(t.app, a).post(`/v1/conversations/${conv}/calls`, { kind: 'video' });
    expect(started.status).toBe(201);
    expect(started.body.iceServers[0].urls).toContain('stun:');
    const callId = started.body.call.id;
    expect((await as(t.app, a).post(`/v1/conversations/${conv}/calls`, { kind: 'audio' })).status).toBe(409);
    expect((await as(t.app, c).get(`/v1/calls/${callId}`)).status).toBe(404);
    expect((await as(t.app, a).post(`/v1/calls/${callId}/signal`, { toUserId: c.id, type: 'offer', data: { sdp: 'x' } })).status).toBe(404);
    expect((await as(t.app, a).post(`/v1/calls/${callId}/signal`, { toUserId: b.id, type: 'offer', data: { sdp: 'v=0' } })).status).toBe(200);
    expect((await as(t.app, b).post(`/v1/calls/${callId}/answer`)).body.call.status).toBe('active');
    await as(t.app, a).post(`/v1/calls/${callId}/end`);
    const history = await as(t.app, b).get(`/v1/conversations/${conv}/calls`);
    expect(history.body.items[0]).toMatchObject({ id: callId, status: 'ended' });
    // Blocked people can't call each other.
    await as(t.app, b).post(`/v1/users/${a.id}/block`);
    expect((await as(t.app, a).post(`/v1/conversations/${conv}/calls`, {})).status).toBe(403);
  });
});

describe('Real and Real Together', () => {
  let a: TestUser;
  let b: TestUser;
  let stranger: TestUser;
  beforeAll(async () => {
    a = await signUp(t.app);
    b = await signUp(t.app);
    stranger = await signUp(t.app);
    await befriend(a, b);
    await t.ctx.db.query(
      `INSERT INTO feature_flags (key, enabled) VALUES ('REAL', true), ('REAL_TOGETHER', true) ON CONFLICT (key) DO UPDATE SET enabled = true`,
    );
  });

  it('accepts only fresh, unused media and labels the post as Real', async () => {
    expect((await as(t.app, a).post('/v1/real', { mediaIds: [await insertMedia(a.id, 30)] })).status).toBe(422);
    const front = await insertMedia(a.id);
    const back = await insertMedia(a.id);
    const r = await as(t.app, a).post('/v1/real', { mediaIds: [front, back], caption: 'Right now' });
    expect(r.status).toBe(201);
    expect(r.body.post.real).toMatchObject({ dual: true });
    expect(r.body.post.kind).toBe('carousel');
    expect((await as(t.app, a).post('/v1/real', { mediaIds: [front] })).status).toBe(422);
    expect((await as(t.app, b).get('/v1/real')).body.items.map((p: { id: string }) => p.id)).toContain(r.body.post.id);
    expect((await as(t.app, stranger).get('/v1/real')).body.items).toHaveLength(0);
  });

  it('lets friends add perspectives to one shared moment, members only', async () => {
    expect((await as(t.app, a).post('/v1/together', { title: 'Concert', memberIds: [stranger.id] })).status).toBe(403);
    const created = await as(t.app, a).post('/v1/together', { title: 'Concert night', memberIds: [b.id] });
    expect(created.status).toBe(201);
    const id = created.body.together.id;
    await as(t.app, a).post(`/v1/together/${id}/contributions`, { mediaId: await insertMedia(a.id), caption: 'From the front' });
    const r = await as(t.app, b).post(`/v1/together/${id}/contributions`, { mediaId: await insertMedia(b.id), caption: 'From the back' });
    expect(r.body.together.contributions.map((c: { caption: string }) => c.caption)).toEqual(['From the front', 'From the back']);
    expect((await as(t.app, stranger).get(`/v1/together/${id}`)).status).toBe(404);
    expect((await as(t.app, b).post(`/v1/together/${id}/contributions`, { mediaId: await insertMedia(a.id) })).status).toBe(404);
    await as(t.app, a).post(`/v1/together/${id}/close`);
    expect((await as(t.app, b).post(`/v1/together/${id}/contributions`, { mediaId: await insertMedia(b.id) })).status).toBe(400);
  });
});

describe('OAuth (authorization code + PKCE)', () => {
  it('runs the full flow, enforces PKCE, rotates refresh tokens and supports revocation', async () => {
    const dev = await signUp(t.app);
    const user = await signUp(t.app);
    const appId = (await as(t.app, dev).post('/v1/developer/apps', { name: 'Photo Printer' })).body.app.id;
    const redirect = 'https://printer.example/callback';
    expect((await as(t.app, dev).put(`/v1/developer/apps/${appId}/redirect-uris`, { redirectUris: ['http://evil.example/cb'] })).status).toBe(400);
    await as(t.app, dev).put(`/v1/developer/apps/${appId}/redirect-uris`, { redirectUris: [redirect] });

    const verifier = randomBytes(40).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = {
      response_type: 'code',
      client_id: appId,
      redirect_uri: redirect,
      scope: 'read',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const consent = await as(t.app, user).get(`/v1/oauth/authorize?${new URLSearchParams(q)}`);
    expect(consent.body.app.name).toBe('Photo Printer');
    expect((await as(t.app, user).get(`/v1/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/cb' })}`)).status).toBe(400);

    const denied = await as(t.app, user).post('/v1/oauth/authorize', { ...q, approve: false });
    expect(denied.body.redirectTo).toContain('error=access_denied');
    const approved = await as(t.app, user).post('/v1/oauth/authorize', { ...q, approve: true });
    const url = new URL(approved.body.redirectTo);
    expect(url.searchParams.get('state')).toBe('xyz');
    const code = url.searchParams.get('code')!;

    const token = (form: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/oauth/token',
        payload: new URLSearchParams(form).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    expect(
      (await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: appId, code_verifier: 'x'.repeat(43) })).json().error,
    ).toBe('invalid_grant');
    // The code was consumed by the failed attempt: codes are single-use.
    const approved2 = new URL((await as(t.app, user).post('/v1/oauth/authorize', { ...q, approve: true })).body.redirectTo).searchParams.get('code')!;
    const ok = (await token({ grant_type: 'authorization_code', code: approved2, redirect_uri: redirect, client_id: appId, code_verifier: verifier })).json();
    expect(ok.access_token).toMatch(/^ypo_/);
    expect(ok.scope).toBe('read');

    const asApp = { ...user, token: ok.access_token };
    expect((await as(t.app, asApp).get('/v1/auth/me')).status).toBe(403);
    expect((await as(t.app, asApp).get('/v1/feed')).status).toBe(200);
    expect((await as(t.app, asApp).post('/v1/posts', { body: 'no write scope' })).status).toBe(403);

    const refreshed = (await token({ grant_type: 'refresh_token', refresh_token: ok.refresh_token, client_id: appId })).json();
    expect(refreshed.access_token).toMatch(/^ypo_/);
    expect((await token({ grant_type: 'refresh_token', refresh_token: ok.refresh_token, client_id: appId })).json().error).toBe('invalid_grant');

    expect((await as(t.app, user).get('/v1/me/connected-apps')).body.items[0].name).toBe('Photo Printer');
    await as(t.app, user).del(`/v1/me/connected-apps/${appId}`);
    expect((await as(t.app, { ...user, token: refreshed.access_token }).get('/v1/feed')).status).toBe(401);
  });
});
