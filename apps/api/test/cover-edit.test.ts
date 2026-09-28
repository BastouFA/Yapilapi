import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COVER_RATIO, fitCoverCrop, moveCoverCrop, zoomCoverCrop } from '@yapilapi/shared';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { recordVerdict } from '../src/lib/media-moderation.ts';

let t: BuiltApp;
/** 1600 × 1200: red on the left half, blue on the right. */
let photo: Buffer;

beforeAll(async () => {
  t = await testApp();
  const half = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#1f4fd1' } })
    .png()
    .toBuffer();
  photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#d1301f' } })
    .composite([{ input: half, left: 800, top: 0 }])
    .withMetadata({ exif: { IFD0: { Artist: 'Someone', Copyright: 'Test' } } })
    .jpeg()
    .toBuffer();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const W = 1600;
const H = 1200;

async function upload(owner: TestUser, name = 'coast.jpg', data = photo, mime = 'image/jpeg') {
  const boundary = `----ypl${Date.now()}${Math.random()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="altText"\r\n\r\nRed and blue walls\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${owner.token}` },
  });
  expect(res.statusCode).toBe(201);
  const m = res.json().media as { id: string; url: string };
  const job = (await db().query(`SELECT id, payload FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1`, [m.id])).rows[0];
  const handlers = mediaJobHandlers({ db: db(), storage: t.ctx.storage, moderator: t.ctx.mediaModerator, realtime: t.ctx.realtime });
  await handlers['media.process'](job.payload);
  await db().query(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [job.id]);
  return m;
}

async function stored(mediaId: string) {
  const r = (await db().query(`SELECT storage_key, deleted_at FROM media WHERE id = $1`, [mediaId])).rows[0];
  return { data: r.storage_key ? await t.ctx.storage.read(r.storage_key) : null, deletedAt: r.deleted_at as Date | null };
}

const profileRow = async (userId: string) =>
  (await db().query(`SELECT cover_url, cover_media_id, cover_alt, cover_edit, cover_render_media_id FROM profiles WHERE user_id = $1`, [userId])).rows[0];

/** The left (red) third of the picture, zoomed in, with the Mono look. */
const leftMono = () => ({ crop: moveCoverCrop(zoomCoverCrop(fitCoverCrop(W, H), W, H, 2), -1, 0), filter: 'mono' as const });

describe('editing a cover photo', () => {
  it('renders the edit from the original, keeps the recipe for you only, and shows others just the result', async () => {
    const ada = await adult();
    const bola = await adult();
    const m = await upload(ada);
    const edit = leftMono();

    const res = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, altText: 'The red wall', edit });
    expect(res.status).toBe(200);
    const p = res.body.profile;
    expect(p.coverUrl).toMatch(/_large\.webp$/);
    expect(p.coverAlt).toBe('The red wall');
    expect(p.coverEdit).toMatchObject({ mediaId: m.id, width: W, height: H, altText: 'Red and blue walls' });
    expect(p.coverEdit.url).toMatch(/_(large|medium)\.webp$/);
    expect(p.coverEdit.url).not.toBe(p.coverUrl);
    expect(p.coverEdit.recipe).toEqual({ ...edit, filterStrength: 100, adjustments: {}, rotate: 0, flipH: false, flipV: false, straighten: 0 });

    // The rendered copy: the cover's shape, the look applied (grey, from the red part), no metadata.
    const row = await profileRow(ada.id);
    expect(row.cover_media_id).toBe(m.id);
    const render = await stored(row.cover_render_media_id);
    const meta = await sharp(render.data!).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.width! / meta.height!).toBeCloseTo(COVER_RATIO, 1);
    const { data } = await sharp(render.data!).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[0]! - data[1]!)).toBeLessThan(6);
    expect(Math.abs(data[1]! - data[2]!)).toBeLessThan(6);
    // The original is untouched.
    const original = await stored(m.id);
    expect((await sharp(original.data!).metadata()).width).toBe(W);

    // Everyone else sees the rendered cover and nothing about how it was made.
    for (const viewer of [bola, null]) {
      const seen = (await as(t.app, viewer).get(`/v1/users/${ada.username}`)).body.profile;
      expect(seen.coverUrl).toBe(p.coverUrl);
      expect(seen).not.toHaveProperty('coverEdit');
    }
    // Your own view has it, for "Edit cover".
    expect((await as(t.app, ada).get(`/v1/users/${ada.username}`)).body.profile.coverEdit.recipe.filter).toBe('mono');
  });

  it('edits again from the original, replaces the earlier copy, and does nothing new for the same edit', async () => {
    const ada = await adult();
    const m = await upload(ada);
    const first = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, edit: leftMono() });
    const firstRender = (await profileRow(ada.id)).cover_render_media_id;

    // "Adjust position": only the framing changes, now on the blue side, with a straighten and a weaker look.
    const moved = { ...leftMono(), crop: moveCoverCrop(leftMono().crop, 1, 0), filterStrength: 40, straighten: 4.5, adjustments: { warmth: 20 } };
    const second = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, edit: moved });
    expect(second.status).toBe(200);
    expect(second.body.profile.coverUrl).not.toBe(first.body.profile.coverUrl);
    expect(second.body.profile.coverEdit.recipe).toMatchObject({ filterStrength: 40, straighten: 4.5, adjustments: { warmth: 20 } });
    const row = await profileRow(ada.id);
    expect(row.cover_media_id).toBe(m.id);
    expect((await stored(firstRender)).deletedAt).not.toBeNull();
    // Blue side with only part of the look: still clearly blue.
    const { data } = await sharp((await stored(row.cover_render_media_id)).data!)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mid = (Math.floor(data.length / 3 / 2) - 10) * 3;
    expect(data[mid + 2]!).toBeGreaterThan(data[mid]! + 40);

    // The same edit again: no new copy, only the description changes.
    const count = async () => Number((await db().query(`SELECT count(*) FROM media WHERE owner_id = $1`, [ada.id])).rows[0].count);
    const before = await count();
    const again = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, edit: moved, altText: 'Blue wall' });
    expect(again.status).toBe(200);
    expect(again.body.profile.coverUrl).toBe(second.body.profile.coverUrl);
    expect(again.body.profile.coverAlt).toBe('Blue wall');
    expect(await count()).toBe(before);

    // An edited copy can't be the start of another cover.
    const renderId = (await profileRow(ada.id)).cover_render_media_id;
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: renderId, edit: leftMono() })).status).toBe(400);
    // …nor an earlier one, which is gone.
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: firstRender })).status).toBe(404);

    // Setting it without an edit uses the whole photo and drops the recipe and the copy.
    const plain = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id });
    expect(plain.body.profile.coverEdit).toMatchObject({ mediaId: m.id, recipe: null });
    expect((await stored(renderId)).deletedAt).not.toBeNull();
    expect((await profileRow(ada.id)).cover_edit).toBeNull();
  });

  it('checks the recipe: the cover shape, the editor’s ranges and nothing extra', async () => {
    const ada = await adult();
    const m = await upload(ada);
    const put = (edit: unknown) => as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, edit });
    const fit = fitCoverCrop(W, H);

    // A square crop isn't the cover's shape.
    const square = await put({ crop: { x: 0, y: 0, w: 0.75, h: 1 } });
    expect(square.status).toBe(400);
    expect(square.body.error.details.fields['edit.crop']).toMatch(/8:3/);
    // The shape of the turned picture counts: this crop fits upright, not turned.
    expect((await put({ crop: fit, rotate: 90 })).status).toBe(400);
    // Too far in.
    expect((await put({ crop: { x: 0, y: 0, w: fit.w / 6, h: fit.h / 6 } })).status).toBe(400);
    expect((await put({ crop: fit, straighten: 60 })).status).toBe(400);
    expect((await put({ crop: fit, filter: 'sparkle' })).status).toBe(400);
    expect((await put({ crop: fit, filterStrength: -1 })).status).toBe(400);
    expect((await put({ crop: fit, adjustments: { glow: 3 } })).status).toBe(400);
    expect((await put({ crop: fit, text: { value: 'Hello' } })).status).toBe(400);
    expect((await put({ crop: { ...fit, x: 0.5 } })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    // Nothing was set by any of these.
    expect((await profileRow(ada.id)).cover_url).toBeNull();
    // The widest crop, turned a quarter, is fine once it has the turned picture's shape.
    expect((await put({ crop: fitCoverCrop(H, W), rotate: 90, flipH: true })).status).toBe(200);
  });

  it('uses only your own photos and refuses sensitive, blocked and animated ones', async () => {
    const ada = await adult();
    const bola = await adult();
    const m = await upload(ada);
    // Someone else's photo looks like one that doesn't exist.
    expect((await as(t.app, bola).put('/v1/me/cover', { mediaId: m.id, edit: leftMono() })).status).toBe(404);
    expect((await as(t.app, null).put('/v1/me/cover', { mediaId: m.id, edit: leftMono() })).status).toBe(401);

    const sensitive = await upload(ada, 'sensitive-wall.jpg');
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: sensitive.id, edit: leftMono() })).body.error.code).toBe('media_sensitive');
    const blocked = await upload(ada, 'blocked-wall.jpg');
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: blocked.id, edit: leftMono() })).body.error.code).toBe('media_blocked');

    const gif = await sharp({ create: { width: 800, height: 300, channels: 3, background: '#333' } })
      .gif()
      .toBuffer();
    const g = await upload(ada, 'loop.gif', gif, 'image/gif');
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: g.id, edit: { crop: fitCoverCrop(800, 300) } })).status).toBe(415);
  });

  it('comes down with its original when the automated check later flags it, and when you remove it', async () => {
    const ada = await adult();
    const m = await upload(ada);
    await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, edit: leftMono() });
    const render = (await profileRow(ada.id)).cover_render_media_id;
    await recordVerdict(db(), t.ctx.realtime, { id: m.id, ownerId: ada.id, kind: 'image' }, 'dev', { verdict: 'sensitive', labels: [] });
    const gone = (await as(t.app, ada).get(`/v1/users/${ada.username}`)).body.profile;
    expect(gone.coverUrl).toBeNull();
    expect(gone.coverEdit).toBeNull();
    expect(await profileRow(ada.id)).toMatchObject({ cover_media_id: null, cover_edit: null, cover_render_media_id: null });
    expect((await stored(render)).deletedAt).not.toBeNull();

    const other = await upload(ada, 'other.jpg');
    await as(t.app, ada).put('/v1/me/cover', { mediaId: other.id, edit: leftMono() });
    const render2 = (await profileRow(ada.id)).cover_render_media_id;
    expect((await as(t.app, ada).del('/v1/me/cover')).body.profile).toMatchObject({ coverUrl: null, coverEdit: null });
    expect((await stored(render2)).deletedAt).not.toBeNull();
    expect((await profileRow(ada.id)).cover_edit).toBeNull();
  });

  it('lists your recent photos that can be a cover, and keeps your recipe in your data export', async () => {
    const ada = await adult();
    const bola = await adult();
    const a = await upload(ada, 'one.jpg');
    const b = await upload(ada, 'two.jpg');
    await upload(ada, 'sensitive-three.jpg');
    await upload(bola, 'bolas.jpg');
    await as(t.app, ada).put('/v1/me/cover', { mediaId: a.id, edit: leftMono() });

    const list = await as(t.app, ada).get('/v1/me/cover/photos');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([b.id, a.id]);
    expect(list.body.items[0]).toMatchObject({ width: W, height: H, altText: 'Red and blue walls' });
    expect((await as(t.app, null).get('/v1/me/cover/photos')).status).toBe(401);

    const exported = (await as(t.app, ada).get('/v1/me/export')).body;
    expect(exported.profile.cover_edit.filter).toBe('mono');
    expect(exported.profile.cover_media_id).toBe(a.id);
  });
});
