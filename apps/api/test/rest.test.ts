import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJobs } from '../src/lib/jobs.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { createPushSender } from '../src/lib/push.ts';
import { signDevWebhook } from '../src/lib/payments.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key IN ('LIVE', 'MINI_APPS')`);
  await t.close();
});

async function storedMedia(owner: string, kind: 'image' | 'video', data: Buffer, ext: string, mime: string) {
  const stored = await t.ctx.storage.put(data, ext, mime);
  const { rows } = await t.ctx.db.query(`INSERT INTO media (owner_id, kind, url, mime, storage_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
    owner,
    kind,
    stored.url,
    mime,
    stored.key,
  ]);
  await t.ctx.db.query(`INSERT INTO jobs (kind, payload) VALUES ('media.process', $1)`, [{ mediaId: rows[0].id }]);
  return rows[0].id as string;
}

async function pay(orderId: string, amountCents: number) {
  const ref = (await t.ctx.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [orderId])).rows[0].provider_ref;
  const payload = JSON.stringify({ id: `evt_${orderId}`, type: 'payment.succeeded', providerRef: ref, amountCents });
  const sig = signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload);
  return t.app.inject({ method: 'POST', url: '/v1/payments/webhook/dev', payload, headers: { 'content-type': 'application/json', 'x-signature': sig } });
}

describe('media processing', () => {
  it('makes resized webp variants and strips location metadata from photos', async () => {
    const u = await signUp(t.app);
    const photo = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#0f6b5c' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 43/1 0/1' } })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeTruthy();
    const id = await storedMedia(u.id, 'image', photo, 'jpg', 'image/jpeg');
    await processJobs(t.ctx.db, mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }));
    const m = (await t.ctx.db.query(`SELECT variants, width, blurhash, status FROM media WHERE id = $1`, [id])).rows[0];
    expect(Object.keys(m.variants).sort()).toEqual(['large', 'medium', 'thumb']);
    expect(m.width).toBe(2400);
    expect(m.blurhash).toMatch(/^data:image\/webp;base64,/);
    const key = new URL(m.variants.medium).pathname.replace('/media/', '');
    const medium = await t.ctx.storage.read(key);
    const meta = await sharp(medium).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
  });

  it('transcodes video to a poster, a web MP4 and an adaptive HLS stream', async () => {
    const u = await signUp(t.app);
    const dir = mkdtempSync(path.join(tmpdir(), 'ypl-vt-'));
    const src = path.join(dir, 'clip.mp4');
    const r = spawnSync(ffmpegPath as unknown as string, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x480:rate=24:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      src,
    ]);
    expect(r.status).toBe(0);
    const id = await storedMedia(u.id, 'video', readFileSync(src), 'mp4', 'video/mp4');
    await processJobs(t.ctx.db, mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }));
    const m = (await t.ctx.db.query(`SELECT variants, poster_url, hls_url FROM media WHERE id = $1`, [id])).rows[0];
    expect(m.poster_url).toMatch(/_poster\.jpg$/);
    expect(m.variants.mp4).toMatch(/_web\.mp4$/);
    expect(m.hls_url).toMatch(/_hls\/index\.m3u8$/);
    const master = (await t.ctx.storage.read(new URL(m.hls_url).pathname.replace('/media/', ''))).toString();
    expect(master).toContain('#EXT-X-STREAM-INF');
    expect(master.match(/RESOLUTION=\d+x(\d+)/g)?.length).toBe(2);
  }, 120_000);

  it('posts can reference uploaded media and return processed versions', async () => {
    const u = await signUp(t.app);
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#e0a020' } })
      .png()
      .toBuffer();
    const id = await storedMedia(u.id, 'image', img, 'png', 'image/png');
    await processJobs(t.ctx.db, mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }));
    const post = await as(t.app, u).post('/v1/posts', {
      body: 'With a photo',
      media: [{ id, url: 'http://x.test/ignored.png', kind: 'image', altText: 'Orange square' }],
    });
    expect(post.status).toBe(201);
    expect(post.body.post.media[0]).toMatchObject({ id, altText: 'Orange square' });
    expect(post.body.post.media[0].variants.thumb).toMatch(/_thumb\.webp$/);
    const other = await signUp(t.app);
    expect((await as(t.app, other).post('/v1/posts', { body: 'steal', media: [{ id, url: 'http://x.test/a.png', kind: 'image' }] })).status).toBe(404);
  });
});

describe('live video hook and call relay credentials', () => {
  it('authorizes publishing with the stream key and viewing with a signed token', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const host = await signUp(t.app);
    const fan = await signUp(t.app);
    const created = await as(t.app, host).post('/v1/live', { title: 'Hook test' });
    const id = created.body.live.id;
    const [, key] = created.body.ingest.streamKey.split('?key=');
    const secret = t.ctx.config.LIVE_HOOK_SECRET;
    const hook = (body: object, s = secret) => t.app.inject({ method: 'POST', url: `/v1/live/hooks/auth?secret=${s}`, payload: body });
    expect((await hook({ action: 'publish', path: `live/${id}`, query: `key=${key}` }, 'wrong')).statusCode).toBe(401);
    expect((await hook({ action: 'publish', path: `live/${id}`, query: 'key=nope' })).statusCode).toBe(401);
    expect((await hook({ action: 'publish', path: `live/${id}`, query: `key=${key}` })).statusCode).toBe(200);
    await as(t.app, host).post(`/v1/live/${id}/start`);
    const view = await as(t.app, fan).post(`/v1/live/${id}/join`);
    const token = new URL(view.body.live.playbackUrl).searchParams.get('token')!;
    expect((await hook({ action: 'read', path: `live/${id}`, query: `token=${encodeURIComponent(token)}` })).statusCode).toBe(200);
    expect((await hook({ action: 'read', path: `live/${id}`, query: 'token=a.b.c' })).statusCode).toBe(401);
    await as(t.app, host).post(`/v1/live/${id}/end`);
    expect((await hook({ action: 'read', path: `live/${id}`, query: `token=${encodeURIComponent(token)}` })).statusCode).toBe(401);
    expect((await hook({ action: 'publish', path: `live/${id}`, query: `key=${key}` })).statusCode).toBe(401);
  });

  it('issues time-limited TURN credentials when a relay is configured', async () => {
    const cfgApp = await (await import('./helpers.ts')).testApp();
    try {
      Object.assign(cfgApp.ctx.config, { TURN_URLS: 'turn:turn.test:3478', TURN_SECRET: 's3cret' });
      const u = await signUp(cfgApp.app);
      const r = await as(cfgApp.app, u).get('/v1/calls/ice-servers');
      const turn = r.body.iceServers.find((s: { urls: unknown }) => JSON.stringify(s.urls).includes('turn:'));
      expect(turn.username).toMatch(new RegExp(`^\\d+:${u.id}$`));
      const { createHmac } = await import('node:crypto');
      expect(turn.credential).toBe(createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
    } finally {
      await cfgApp.close();
    }
  });
});

describe('push notifications', () => {
  it('registers devices and sends to Expo, removing dead tokens', async () => {
    const u = await signUp(t.app);
    const token = 'ExponentPushToken[abc123]';
    expect((await as(t.app, u).post('/v1/push/subscriptions', { kind: 'expo', endpoint: 'not-a-token' })).status).toBe(400);
    expect((await as(t.app, u).post('/v1/push/subscriptions', { kind: 'expo', endpoint: token })).status).toBe(201);
    const sent: unknown[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: sent.length > 1 ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' } }));
    }) as typeof fetch;
    const push = createPushSender(t.ctx.db, t.ctx.config, fakeFetch);
    await push(u.id, { title: 'YAPILAPI', body: 'Ada liked your post' });
    expect(sent[0]).toMatchObject({ to: token, body: 'Ada liked your post' });
    await push(u.id, { title: 'YAPILAPI', body: 'again' });
    expect((await t.ctx.db.query(`SELECT 1 FROM push_subscriptions WHERE user_id = $1`, [u.id])).rowCount).toBe(0);
  });
});

describe('Mini Apps', () => {
  it('requires review, installs only where allowed, and issues verifiable scoped context', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('MINI_APPS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const dev = await signUp(t.app);
    const admin = await signUp(t.app);
    await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const outsider = await signUp(t.app);
    const appId = (await as(t.app, dev).post('/v1/developer/apps', { name: 'Polls+' })).body.app.id;
    expect(
      (await as(t.app, dev).post(`/v1/developer/apps/${appId}/mini-apps`, { name: 'Polls+', entryUrl: 'http://insecure.test', surfaces: ['conversation'] }))
        .status,
    ).toBe(400);
    const mini = (
      await as(t.app, dev).post(`/v1/developer/apps/${appId}/mini-apps`, {
        name: 'Polls+',
        entryUrl: 'https://polls.example/app',
        permissions: ['profile'],
        surfaces: ['conversation'],
      })
    ).body.miniApp;
    const conv = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] })).body.conversation.id;
    expect((await as(t.app, a).post(`/v1/mini-apps/${mini.id}/install`, { surface: 'conversation', surfaceId: conv })).status).toBe(404);
    await as(t.app, admin).post(`/v1/admin/mini-apps/${mini.id}/decide`, { approve: true });
    expect((await as(t.app, outsider).post(`/v1/mini-apps/${mini.id}/install`, { surface: 'conversation', surfaceId: conv })).status).toBe(403);
    expect((await as(t.app, a).post(`/v1/mini-apps/${mini.id}/install`, { surface: 'conversation', surfaceId: conv })).status).toBe(201);
    expect((await as(t.app, b).get(`/v1/mini-apps/installed?surface=conversation&surfaceId=${conv}`)).body.items[0].entryUrl).toBe('https://polls.example/app');
    const ctxToken = (await as(t.app, b).post(`/v1/mini-apps/${mini.id}/context`, { surface: 'conversation', surfaceId: conv })).body.token;
    const verified = (await as(t.app, null).post('/v1/mini-apps/verify', { token: ctxToken })).body;
    expect(verified.claims.user.username).toBe(b.username);
    expect(verified.claims.members).toBeUndefined();
    expect(verified.claims.sub).not.toContain(b.id);
    expect((await as(t.app, null).post('/v1/mini-apps/verify', { token: ctxToken.slice(0, -2) + 'xx' })).status).toBe(401);
    expect((await as(t.app, outsider).post(`/v1/mini-apps/${mini.id}/context`, { surface: 'conversation', surfaceId: conv })).status).toBe(404);
  });
});

describe('creator economy, reviews and bookings', () => {
  let creator: TestUser;
  let fan: TestUser;
  beforeAll(async () => {
    creator = await signUp(t.app);
    fan = await signUp(t.app);
  });

  it('activates a subscription only after payment, and counts it in earnings', async () => {
    const plan = (await as(t.app, creator).post('/v1/creator/plans', { name: 'Supporter', priceCents: 500, currency: 'eur' })).body.plan;
    expect((await as(t.app, creator).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: 'self-sub-001' })).status).toBe(400);
    const sub = await as(t.app, fan).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: 'fan-sub-0001' });
    expect(sub.body.subscription.status).toBe('pending');
    await pay(sub.body.payment.orderId, 500);
    const mine = (await as(t.app, fan).get('/v1/me/subscriptions')).body.items[0];
    expect(mine.status).toBe('active');
    expect(new Date(mine.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    const tip = await as(t.app, fan).post(`/v1/users/${creator.id}/tips`, {
      amountCents: 300,
      currency: 'EUR',
      message: 'Great stream',
      idempotencyKey: 'tip-000001',
    });
    await pay(tip.body.payment.orderId, 300);
    const earnings = (await as(t.app, creator).get('/v1/me/earnings')).body.balances.find((b: { currency: string }) => b.currency === 'EUR');
    expect(earnings).toMatchObject({ grossCents: 800, feeCents: 40, availableCents: 760 });
    const notes = (await as(t.app, creator).get('/v1/notifications')).body.items.map((n: { type: string }) => n.type);
    expect(notes).toEqual(expect.arrayContaining(['subscription_started', 'tip_received']));
    expect((await as(t.app, fan).post(`/v1/creator/subscriptions/${mine.id}/cancel`)).body.status).toBe('cancelled');
  });

  it('reviews and books a place with capacity limits and owner decisions', async () => {
    const owner = await signUp(t.app);
    const biz = (await as(t.app, owner).post('/v1/businesses', { name: 'Test Diner', slug: `diner-${Date.now().toString(36)}` })).body.business;
    const place = (await as(t.app, owner).post('/v1/places', { name: 'Test Diner', category: 'restaurant', businessId: biz.id })).body.place;
    await t.ctx.db.query(`UPDATE places SET booking_capacity = 8 WHERE id = $1`, [place.id]);
    expect((await as(t.app, owner).put(`/v1/places/${place.id}/reviews`, { rating: 5 })).status).toBe(403);
    await as(t.app, fan).put(`/v1/places/${place.id}/reviews`, { rating: 4, body: 'Great jollof' });
    await as(t.app, creator).put(`/v1/places/${place.id}/reviews`, { rating: 5 });
    await as(t.app, fan).put(`/v1/places/${place.id}/reviews`, { rating: 3, body: 'Changed my mind' });
    const reviews = (await as(t.app, null).get(`/v1/places/${place.id}/reviews`)).body;
    expect(reviews).toMatchObject({ average: 4, count: 2 });

    const at = new Date(Date.now() + 2 * 86400_000).toISOString();
    const b1 = await as(t.app, fan).post(`/v1/places/${place.id}/bookings`, { partySize: 6, startsAt: at });
    expect(b1.status).toBe(201);
    expect((await as(t.app, creator).post(`/v1/places/${place.id}/bookings`, { partySize: 4, startsAt: at })).status).toBe(409);
    expect((await as(t.app, fan).post(`/v1/bookings/${b1.body.booking.id}/decide`, { confirm: true })).status).toBe(404);
    expect((await as(t.app, owner).post(`/v1/bookings/${b1.body.booking.id}/decide`, { confirm: true })).body.status).toBe('confirmed');
    expect((await as(t.app, fan).get('/v1/me/bookings')).body.items[0].status).toBe('confirmed');
  });
});

describe('passkeys', () => {
  it('issues registration and sign-in challenges and rejects bogus responses', async () => {
    const u = await signUp(t.app);
    const reg = await as(t.app, u).post('/v1/auth/passkeys/register/options');
    expect(reg.body.options.rp).toMatchObject({ name: 'YAPILAPI', id: 'localhost' });
    expect(reg.body.options.authenticatorSelection.residentKey).toBe('required');
    const bad = await as(t.app, u).post('/v1/auth/passkeys/register/verify', {
      challengeId: reg.body.challengeId,
      response: { id: 'x', rawId: 'x', type: 'public-key', response: {} },
    });
    expect(bad.status).toBe(400);
    // Challenges are single use.
    expect((await as(t.app, u).post('/v1/auth/passkeys/register/verify', { challengeId: reg.body.challengeId, response: {} })).status).toBe(400);
    const login = await as(t.app, null).post('/v1/auth/passkeys/login/options');
    expect(login.body.options.challenge).toBeTruthy();
    expect(
      (await as(t.app, null).post('/v1/auth/passkeys/login/verify', { challengeId: login.body.challengeId, response: { id: 'unknown-credential' } })).status,
    ).toBe(401);
  });
});
