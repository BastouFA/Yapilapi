import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import { liteTrim } from '../src/lib/data-saver.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let alice: TestUser;
let reader: TestUser;

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = `----ypl${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Upload through the real endpoint and run the processing job it queued. */
async function upload(owner: TestUser, name: string, type: string, data: Buffer) {
  const body = multipart({ name, type, data });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${owner.token}` },
  });
  expect(res.statusCode).toBe(201);
  const media = res.json().media as { id: string; url: string; kind: 'image' | 'video' };
  const job = (await t.ctx.db.query(`SELECT id, payload FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1`, [media.id])).rows[0];
  await mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage })['media.process'](job.payload);
  await t.ctx.db.query(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [job.id]);
  return media;
}

/** A photo big enough for every processed size (thumb, medium and large), with detail so the sizes differ. */
async function bigPhoto(): Promise<Buffer> {
  const w = 2400;
  const h = 1600;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function smallVideo(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-datasaver-'));
  const out = path.join(dir, 'clip.mp4');
  execFileSync(ffmpegPath as unknown as string, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=2',
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return readFileSync(out);
}

async function get(user: TestUser, url: string, headers: Record<string, string> = {}) {
  const res = await t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${user.token}`, ...headers } });
  return { status: res.statusCode, body: res.json() as any, bytes: Buffer.byteLength(res.body), vary: String(res.headers.vary ?? '') };
}

let photoPostId: string;
let videoPostId: string;

beforeAll(async () => {
  t = await testApp();
  alice = await signUp(t.app, { birthDate: '1990-01-01' });
  reader = await signUp(t.app, { birthDate: '1990-01-01' });
  const photo = await upload(alice, 'market.jpg', 'image/jpeg', await bigPhoto());
  const p = await as(t.app, alice).post('/v1/posts', { body: 'Morning at the market', media: [{ id: photo.id, url: photo.url, kind: 'image' }] });
  expect(p.status).toBe(201);
  photoPostId = p.body.post.id;
  const video = await upload(alice, 'clip.mp4', 'video/mp4', smallVideo());
  const v = await as(t.app, alice).post('/v1/posts', { body: 'A short clip', media: [{ id: video.id, url: video.url, kind: 'video' }] });
  expect(v.status).toBe(201);
  videoPostId = v.body.post.id;
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe('data saver setting', () => {
  it('is Automatic until changed, and is saved on the account and returned with /v1/auth/me', async () => {
    const u = await signUp(t.app);
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.dataSaver).toBe('auto');
    expect((await as(t.app, u).get('/v1/me/data-saver')).body).toEqual({ mode: 'auto' });

    expect((await as(t.app, u).put('/v1/me/data-saver', { mode: 'on' })).body).toEqual({ mode: 'on' });
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.dataSaver).toBe('on');
    expect((await as(t.app, u).get('/v1/me/preferences')).body.dataSaver).toBe('on');

    await as(t.app, u).put('/v1/me/data-saver', { mode: 'off' });
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.dataSaver).toBe('off');
    // A new sign-in (another device) gets the same setting.
    const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: u.password } });
    expect(login.json().user.dataSaver).toBe('off');
  });

  it('only takes off, on or auto, and only for the signed-in person', async () => {
    const u = await signUp(t.app);
    expect((await as(t.app, u).put('/v1/me/data-saver', { mode: 'sometimes' })).status).toBe(400);
    expect((await as(t.app, null).put('/v1/me/data-saver', { mode: 'on' })).status).toBe(401);
  });

  it('works for accounts without a preferences row', async () => {
    const u = await signUp(t.app);
    await t.ctx.db.query(`DELETE FROM user_preferences WHERE user_id = $1`, [u.id]);
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.dataSaver).toBe('auto');
    expect((await as(t.app, u).put('/v1/me/data-saver', { mode: 'on' })).status).toBe(200);
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.dataSaver).toBe('on');
  });
});

describe('media sizes', () => {
  it('lists every photo size with its bytes, smallest first', async () => {
    const { body } = await get(reader, `/v1/posts/${photoPostId}`);
    const m = body.post.media[0];
    expect(Object.keys(m.variants).sort()).toEqual(['large', 'medium', 'thumb']);
    for (const k of ['thumb', 'medium', 'large', 'original']) expect(m.sizes[k]).toBeGreaterThan(0);
    expect(m.sizes.thumb).toBeLessThan(m.sizes.medium);
    expect(m.sizes.medium).toBeLessThan(m.sizes.large);
    expect(m.placeholder).toMatch(/^data:image\/webp;base64,/);
  });

  it('gives videos a small poster, the lowest MP4 and the 360p stream, with their bytes', async () => {
    const { body } = await get(reader, `/v1/posts/${videoPostId}`);
    const m = body.post.media[0];
    expect(m.variants.mp4).toBeTruthy();
    expect(m.variants.mp4_360).toMatch(/_360\.mp4$/);
    expect(m.variants.hls_360).toMatch(/v0\.m3u8$/);
    expect(m.variants.thumb).toMatch(/_thumb\.webp$/);
    expect(m.hlsUrl).toMatch(/index\.m3u8$/);
    for (const k of ['original', 'mp4', 'mp4_360', 'hls_360', 'hls_720', 'poster', 'thumb']) expect(m.sizes[k]).toBeGreaterThan(0);
    expect(m.sizes.thumb).toBeLessThan(m.sizes.poster);
  });

  it('serves media files with the bytes they report, and lets the web app time them', async () => {
    const { body } = await get(reader, `/v1/posts/${photoPostId}`);
    const m = body.post.media[0];
    const res = await t.app.inject({ method: 'GET', url: new URL(m.variants.thumb).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(m.sizes.thumb);
    expect(res.headers['timing-allow-origin']).toBe('*');
  });

  it('includes sizes on your own media item', async () => {
    const id = (await t.ctx.db.query(`SELECT media_id FROM post_media WHERE post_id = $1`, [photoPostId])).rows[0].media_id;
    const { body } = await get(alice, `/v1/media/${id}`);
    expect(body.media.sizes.thumb).toBeGreaterThan(0);
    expect(body.media.variants.thumb).toBeTruthy();
  });
});

describe('lite responses', () => {
  it('?lite=1 leaves out the large size but keeps what older clients need', async () => {
    const full = await get(reader, `/v1/posts/${photoPostId}`);
    const lite = await get(reader, `/v1/posts/${photoPostId}?lite=1`);
    expect(lite.status).toBe(200);
    const m = lite.body.post.media[0];
    expect(m.variants.large).toBeUndefined();
    expect(m.sizes.large).toBeUndefined();
    expect(m.variants.thumb).toBeTruthy();
    expect(m.variants.medium).toBeTruthy();
    expect(m.sizes.thumb).toBeGreaterThan(0);
    // Same fields otherwise.
    expect(m.url).toBe(full.body.post.media[0].url);
    expect(m.placeholder).toBe(full.body.post.media[0].placeholder);
    expect(lite.body.post.body).toBe(full.body.post.body);
    expect(lite.bytes).toBeLessThan(full.bytes);
  });

  it('respects the Save-Data header and says responses vary with it', async () => {
    const full = await get(reader, `/v1/users/${alice.username}/posts`);
    const lite = await get(reader, `/v1/users/${alice.username}/posts`, { 'save-data': 'on' });
    expect(full.vary).toMatch(/save-data/i);
    expect(lite.body.items.length).toBe(full.body.items.length);
    const photo = lite.body.items.find((p: any) => p.id === photoPostId);
    expect(photo.media[0].variants.large).toBeUndefined();
    expect(lite.bytes).toBeLessThan(full.bytes);
    // Videos keep their web MP4 for older clients; the 720p stream's size is left out.
    const video = lite.body.items.find((p: any) => p.id === videoPostId);
    expect(video.media[0].variants.mp4).toBeTruthy();
    expect(video.media[0].variants.mp4_360).toBeTruthy();
    expect(video.media[0].sizes.hls_720).toBeUndefined();
    // Other values of the header don't count.
    const off = await get(reader, `/v1/users/${alice.username}/posts`, { 'save-data': 'off' });
    expect(off.bytes).toBe(full.bytes);
  });

  it('sends the medium cover photo instead of the large one', async () => {
    const photo = await upload(alice, 'cover.jpg', 'image/jpeg', await bigPhoto());
    expect((await as(t.app, alice).put('/v1/me/cover', { mediaId: photo.id })).status).toBe(200);
    const full = await get(reader, `/v1/users/${alice.username}`);
    const lite = await get(reader, `/v1/users/${alice.username}?lite=1`);
    expect(full.body.profile.coverUrl).toMatch(/_large\.webp$/);
    expect(lite.body.profile.coverUrl).toMatch(/_medium\.webp$/);
  });

  it('trims only media and cover photos, and leaves other values alone', () => {
    const when = new Date();
    const out = liteTrim({
      a: { kind: 'image', url: 'u', variants: { thumb: 't', medium: 'm', large: 'l' }, sizes: { thumb: 1, large: 9 } },
      story: { mediaKind: 'image', mediaUrl: 'u', variants: { thumb: 't', large: 'l' } },
      notMedia: { variants: { large: 'kept' } },
      when,
    }) as any;
    expect(out.a.variants).toEqual({ thumb: 't', medium: 'm' });
    expect(out.a.sizes).toEqual({ thumb: 1 });
    expect(out.story.variants).toEqual({ thumb: 't' });
    expect(out.notMedia.variants.large).toBe('kept');
    expect(out.when).toBe(when);
  });
});
