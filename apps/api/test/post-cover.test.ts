import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postCoverSchema } from '@yapilapi/shared';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { editorJobHandlers } from '../src/lib/media-edit.ts';
import { videoCoverJobHandlers } from '../src/lib/video-covers.ts';
import { recordVerdict } from '../src/lib/media-moderation.ts';
import { storedKeys } from '../src/lib/chat.ts';
import { as, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let runJobs: JobRunner;
/** 3 seconds of a 180×320 (9:16) picture: red for the first 1.5 seconds, then blue. */
let clip: Buffer;
const dir = mkdtempSync(path.join(tmpdir(), 'ypl-cover-test-'));

beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
  const src = path.join(dir, 'clip.mp4');
  const r = spawnSync(ffmpegPath as unknown as string, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=180x320:d=1.5:r=15',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=180x320:d=1.5:r=15',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    src,
  ]);
  expect(r.status).toBe(0);
  clip = readFileSync(src);
});
afterAll(async () => {
  await t.close();
});

const handlers = () => ({
  ...mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage, moderator: t.ctx.mediaModerator }),
  ...editorJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
  ...videoCoverJobHandlers({ storage: t.ctx.storage }),
});
async function drain() {
  for (let i = 0; i < 50; i++) if (!(await runJobs(handlers()))) return;
}

async function upload(user: TestUser, data: Buffer, type: string, name: string) {
  const boundary = `----ypl${Date.now()}${Math.random()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${user.token}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().media as { id: string; url: string };
}

const photo = (r: number, g: number, b: number, width = 64, height = 48) =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 95 })
    .toBuffer();

const keyOf = (url: string) => storedKeys({ url, poster_url: null, hls_url: null, variants: null, storage_key: null })[0]!;
const stored = (url: string) => t.ctx.storage.read(keyOf(url));
const gone = async (url: string) =>
  (await t.ctx.storage.read(keyOf(url)).then(
    () => false,
    () => true,
  )) as boolean;
/** The colour in the middle of a stored picture. */
async function middle(url: string) {
  const { data, info } = await sharp(await stored(url))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, width: info.width, height: info.height };
}

async function reel(user: TestUser, visibility = 'public') {
  const v = await upload(user, clip, 'video/mp4', 'clip.mp4');
  await drain();
  const r = await as(t.app, user).post('/v1/posts', {
    body: '[Dev data] A reel',
    format: 'reel',
    visibility,
    media: [{ id: v.id, url: v.url, kind: 'video' }],
  });
  expect(r.status).toBe(201);
  return r.body.post as { id: string; media: any[] };
}

describe('the cover request', () => {
  it('takes exactly one kind of cover', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(postCoverSchema.safeParse({ mediaId: id, atMs: 1000 }).success).toBe(true);
    expect(postCoverSchema.safeParse({ mediaId: id, imageMediaId: id, crop: { x: 0, y: 0, w: 0.5, h: 1 } }).success).toBe(true);
    expect(postCoverSchema.safeParse({ mediaId: id, reset: true }).success).toBe(true);
    expect(postCoverSchema.safeParse({ coverMediaId: id }).success).toBe(true);
    expect(postCoverSchema.safeParse({ mediaId: id }).success).toBe(false);
    expect(postCoverSchema.safeParse({ mediaId: id, atMs: 1000, reset: true }).success).toBe(false);
    expect(postCoverSchema.safeParse({ mediaId: id, atMs: 1000, crop: { x: 0, y: 0, w: 1, h: 1 } }).success).toBe(false);
    expect(postCoverSchema.safeParse({ coverMediaId: id, mediaId: id }).success).toBe(false);
    expect(postCoverSchema.safeParse({ atMs: 1000 }).success).toBe(false);
    expect(postCoverSchema.safeParse({ mediaId: id, atMs: -1 }).success).toBe(false);
  });
});

describe('video covers', () => {
  let owner: TestUser;
  let other: TestUser;
  let post: { id: string; media: any[] };
  let defaults: { posterUrl: string; thumb: string; placeholder: string };

  beforeAll(async () => {
    owner = await signUp(t.app);
    other = await signUp(t.app);
    post = await reel(owner);
    const m = post.media[0];
    expect(m.posterUrl).toMatch(/_poster\.jpg$/);
    expect(m.variants.thumb).toMatch(/_thumb\.webp$/);
    defaults = { posterUrl: m.posterUrl, thumb: m.variants.thumb, placeholder: m.placeholder };
    expect(m.customCover).toBeUndefined();
    // The default is a second in: still red.
    expect((await middle(m.posterUrl)).r).toBeGreaterThan(200);
  });

  it('is changed only by the person who shared the post', async () => {
    const body = { mediaId: post.media[0].id, atMs: 2500 };
    expect((await as(t.app, other).put(`/v1/posts/${post.id}/cover`, body)).status).toBe(403);
    expect((await as(t.app, null).put(`/v1/posts/${post.id}/cover`, body)).status).toBe(401);
    // A post someone can't see doesn't exist for them.
    const hidden = await reel(owner, 'private');
    expect((await as(t.app, other).put(`/v1/posts/${hidden.id}/cover`, { mediaId: hidden.media[0].id, atMs: 2500 })).status).toBe(404);
    expect((await as(t.app, owner).put(`/v1/posts/00000000-0000-4000-8000-000000000000/cover`, body)).status).toBe(404);
    // A video of another post isn't this post's.
    expect((await as(t.app, owner).put(`/v1/posts/${post.id}/cover`, { mediaId: hidden.media[0].id, atMs: 2500 })).status).toBe(404);
    const after = await as(t.app, owner).get(`/v1/posts/${post.id}`);
    expect(after.body.post.media[0].posterUrl).toBe(defaults.posterUrl);
  });

  it('uses a moment of the video, under a new file name, with a new thumb and preview', async () => {
    const api = as(t.app, owner);
    const tooLate = await api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, atMs: 9000 });
    expect(tooLate.status).toBe(400);
    expect(tooLate.body.error.details.fields.atMs).toBeTruthy();

    const r = await api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, atMs: 2500 });
    expect(r.status).toBe(200);
    const m = r.body.post.media[0];
    expect(m.posterUrl).not.toBe(defaults.posterUrl);
    expect(m.posterUrl).toMatch(/_cover_[0-9a-f]{8}\.jpg$/);
    expect(m.variants.thumb).toMatch(/_cover_[0-9a-f]{8}_thumb\.webp$/);
    expect(m.placeholder).toMatch(/^data:image\/webp;base64,/);
    expect(m.placeholder).not.toBe(defaults.placeholder);
    expect(m.customCover).toBe(true);
    expect(m.coverMs).toBe(2500);
    expect(m.sizes.poster).toBe((await stored(m.posterUrl)).length);
    expect(m.sizes.thumb).toBe((await stored(m.variants.thumb)).length);
    // 2.5 seconds in is blue, in the poster and in the Data saver thumb.
    expect((await middle(m.posterUrl)).b).toBeGreaterThan(200);
    expect((await middle(m.variants.thumb)).b).toBeGreaterThan(200);
    // The default stays stored, to go back to.
    expect(await gone(defaults.posterUrl)).toBe(false);

    // Their reels on their profile show it.
    const grid = await as(t.app, other).get(`/v1/users/${owner.username}/posts?format=reel`);
    expect(grid.body.items.find((p: any) => p.id === post.id).media[0].posterUrl).toBe(m.posterUrl);

    // Another moment: new names again, and the first cover's files are gone.
    const again = await api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, atMs: 500 });
    expect(again.status).toBe(200);
    const n = again.body.post.media[0];
    expect(n.posterUrl).not.toBe(m.posterUrl);
    expect(await gone(m.posterUrl)).toBe(true);
    expect(await gone(m.variants.thumb)).toBe(true);
    expect((await middle(n.posterUrl)).r).toBeGreaterThan(200);
  });

  it('uses one of your own photos, fitted to the video’s shape', async () => {
    const api = as(t.app, owner);
    const before = (await api.get(`/v1/posts/${post.id}`)).body.post.media[0];
    const theirs = await upload(other, await photo(0, 200, 0), 'image/jpeg', 'theirs.jpg');
    const green = await upload(owner, await photo(0, 200, 0), 'image/jpeg', 'green.jpg');
    await drain();
    const set = (imageMediaId: string, crop?: object) => api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, imageMediaId, crop });
    expect((await set(theirs.id)).status).toBe(404);
    // A video can't be the photo.
    expect((await set(post.media[0].id)).status).toBe(400);
    await t.ctx.db.query(`UPDATE media SET moderation = 'sensitive' WHERE id = $1`, [green.id]);
    let r = await set(green.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('media_sensitive');
    await t.ctx.db.query(`UPDATE media SET moderation = 'blocked' WHERE id = $1`, [green.id]);
    r = await set(green.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('media_blocked');
    await t.ctx.db.query(`UPDATE media SET moderation = 'ok' WHERE id = $1`, [green.id]);
    // Nothing changed meanwhile.
    expect((await api.get(`/v1/posts/${post.id}`)).body.post.media[0].posterUrl).toBe(before.posterUrl);

    r = await set(green.id);
    expect(r.status).toBe(200);
    const m = r.body.post.media[0];
    expect(m.customCover).toBe(true);
    expect(m.coverMs).toBeUndefined();
    const px = await middle(m.posterUrl);
    expect(px.g).toBeGreaterThan(150);
    expect(px.r).toBeLessThan(60);
    // A 64×48 photo, cut to the 9:16 of the video.
    expect(Math.abs(px.width / px.height - 180 / 320)).toBeLessThan(0.05);
    expect(await gone(before.posterUrl)).toBe(true);

    // With a crop: only the part chosen (the right half of a photo that is red on the left and blue on the right).
    const halves = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 220, g: 0, b: 0 } } })
      .composite([{ input: await photo(0, 0, 220, 100, 100), left: 100, top: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer();
    const both = await upload(owner, halves, 'image/jpeg', 'halves.jpg');
    await drain();
    r = await set(both.id, { x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(r.status).toBe(200);
    expect((await middle(r.body.post.media[0].posterUrl)).b).toBeGreaterThan(180);
  });

  it('goes back to the default poster, and removes the cover’s files', async () => {
    const api = as(t.app, owner);
    const before = (await api.get(`/v1/posts/${post.id}`)).body.post.media[0];
    expect(before.customCover).toBe(true);
    const r = await api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, reset: true });
    expect(r.status).toBe(200);
    const m = r.body.post.media[0];
    expect(m.posterUrl).toBe(defaults.posterUrl);
    expect(m.variants.thumb).toBe(defaults.thumb);
    expect(m.placeholder).toBe(defaults.placeholder);
    expect(m.customCover).toBeUndefined();
    expect(await gone(before.posterUrl)).toBe(true);
    expect(await gone(before.variants.thumb)).toBe(true);
    expect(await gone(defaults.posterUrl)).toBe(false);
    // Nothing to go back from: still fine.
    expect((await api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, reset: true })).status).toBe(200);
  });

  it('comes off when the photo it was made from is marked sensitive', async () => {
    const api = as(t.app, owner);
    const pic = await upload(owner, await photo(0, 200, 0), 'image/jpeg', 'later.jpg');
    await drain();
    const r = await api.put(`/v1/posts/${post.id}/cover`, { mediaId: post.media[0].id, imageMediaId: pic.id });
    expect(r.status).toBe(200);
    const cover = r.body.post.media[0];
    await recordVerdict(t.ctx.db, undefined, { id: pic.id, ownerId: owner.id, kind: 'image' }, 'test', { verdict: 'sensitive', labels: [] });
    const after = (await api.get(`/v1/posts/${post.id}`)).body.post.media[0];
    expect(after.posterUrl).toBe(defaults.posterUrl);
    expect(after.customCover).toBeUndefined();
    await drain();
    expect(await gone(cover.posterUrl)).toBe(true);
  });

  it('can’t be changed on a removed post', async () => {
    const p = await reel(owner);
    await t.ctx.db.query(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [p.id]);
    expect((await as(t.app, owner).put(`/v1/posts/${p.id}/cover`, { mediaId: p.media[0].id, atMs: 2500 })).status).toBe(403);
  });

  it('chosen in the editor before posting, updates the thumb and preview too, and can be reset', async () => {
    const api = as(t.app, owner);
    const v = await upload(owner, clip, 'video/mp4', 'edit.mp4');
    await drain();
    const e = await api.post(`/v1/media/${v.id}/edit`, { coverMs: 2500 });
    expect(e.status).toBe(202);
    await drain();
    const edited = (await api.get(`/v1/media/${e.body.media.id}`)).body.media;
    expect(edited.status).toBe('ready');
    expect(edited.posterUrl).toMatch(/_cover_[0-9a-f]{8}\.jpg$/);
    expect(edited.variants.thumb).toMatch(/_cover_[0-9a-f]{8}_thumb\.webp$/);
    expect((await middle(edited.posterUrl)).b).toBeGreaterThan(200);
    expect((await middle(edited.variants.thumb)).b).toBeGreaterThan(200);
    expect(edited.sizes.poster).toBe((await stored(edited.posterUrl)).length);
    const p = await api.post('/v1/posts', { body: '[Dev data] Edited', format: 'reel', media: [{ id: edited.id, url: edited.url, kind: 'video' }] });
    expect(p.status).toBe(201);
    expect(p.body.post.media[0]).toMatchObject({ customCover: true, coverMs: 2500, posterUrl: edited.posterUrl });
    // The placeholder is made from the cover (blue), not from the default frame.
    const reset = await api.put(`/v1/posts/${p.body.post.id}/cover`, { mediaId: edited.id, reset: true });
    expect(reset.body.post.media[0].posterUrl).toMatch(/_poster\.jpg$/);
    expect(reset.body.post.media[0].placeholder).not.toBe(p.body.post.media[0].placeholder);
    expect((await middle(reset.body.post.media[0].posterUrl)).r).toBeGreaterThan(200);
  });
});

describe('photo post covers', () => {
  it('moves the chosen photo first, keeping the others in order', async () => {
    const owner = await signUp(t.app);
    const other = await signUp(t.app);
    const pics = [];
    for (const [i, c] of [
      [220, 0, 0],
      [0, 220, 0],
      [0, 0, 220],
    ].entries())
      pics.push(await upload(owner, await photo(c[0]!, c[1]!, c[2]!), 'image/jpeg', `p${i}.jpg`));
    await drain();
    const api = as(t.app, owner);
    const r = await api.post('/v1/posts', { body: '[Dev data] Three', media: pics.map((p) => ({ id: p.id, url: p.url, kind: 'image' })) });
    expect(r.status).toBe(201);
    const id = r.body.post.id as string;
    expect(r.body.post.media.map((m: any) => m.id)).toEqual(pics.map((p) => p.id));

    expect((await as(t.app, other).put(`/v1/posts/${id}/cover`, { coverMediaId: pics[2]!.id })).status).toBe(403);
    const lone = await upload(owner, await photo(9, 9, 9), 'image/jpeg', 'lone.jpg');
    await drain();
    expect((await api.put(`/v1/posts/${id}/cover`, { coverMediaId: lone.id })).status).toBe(404);
    // A video's options don't apply to a photo.
    expect((await api.put(`/v1/posts/${id}/cover`, { mediaId: pics[0]!.id, atMs: 0 })).status).toBe(400);

    const set = await api.put(`/v1/posts/${id}/cover`, { coverMediaId: pics[2]!.id });
    expect(set.status).toBe(200);
    expect(set.body.post.media.map((m: any) => m.id)).toEqual([pics[2]!.id, pics[0]!.id, pics[1]!.id]);
    // Their profile and the post itself show it first, for everyone.
    const grid = await as(t.app, other).get(`/v1/users/${owner.username}/posts`);
    expect(grid.body.items.find((p: any) => p.id === id).media[0].id).toBe(pics[2]!.id);
    expect((await as(t.app, other).get(`/v1/posts/${id}`)).body.post.media[0].id).toBe(pics[2]!.id);
    // Not an edit of the text.
    expect(set.body.post.editedAt ?? null).toBeNull();
    await api.put(`/v1/posts/${id}/cover`, { coverMediaId: pics[1]!.id });
    expect((await api.get(`/v1/posts/${id}`)).body.post.media.map((m: any) => m.id)).toEqual([pics[1]!.id, pics[2]!.id, pics[0]!.id]);

    // A sensitive photo can't be the cover.
    await t.ctx.db.query(`UPDATE media SET moderation = 'sensitive' WHERE id = $1`, [pics[0]!.id]);
    expect((await api.put(`/v1/posts/${id}/cover`, { coverMediaId: pics[0]!.id })).body.error.code).toBe('media_sensitive');

    // A post with one photo has nothing to choose.
    const single = await api.post('/v1/posts', { body: '[Dev data] One', media: [{ id: lone.id, url: lone.url, kind: 'image' }] });
    expect((await api.put(`/v1/posts/${single.body.post.id}/cover`, { coverMediaId: lone.id })).status).toBe(400);
  });
});
