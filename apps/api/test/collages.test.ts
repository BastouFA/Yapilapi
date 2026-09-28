import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellRect, collageLayout, COLLAGE_SIZES, type CollageShape } from '@yapilapi/shared';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import type { MediaModerator } from '../src/lib/media-moderation.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const key = () => randomUUID().replace(/-/g, '');

type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 230, g: 30, b: 40 };
const BLUE: Rgb = { r: 20, g: 50, b: 220 };
const GREEN: Rgb = { r: 30, g: 190, b: 60 };
const YELLOW: Rgb = { r: 240, g: 220, b: 30 };

const solid = (width: number, height: number, background: Rgb) =>
  sharp({ create: { width, height, channels: 3, background } })
    .jpeg({ quality: 100 })
    .toBuffer();

/** Left half red, right half blue: which half shows says where the crop's focus is. */
const halves = () =>
  sharp({ create: { width: 400, height: 200, channels: 3, background: RED } })
    .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: BLUE } }, left: 200, top: 0 }])
    .jpeg({ quality: 100 })
    .toBuffer();

/** Upload through the real endpoint. */
async function upload(user: TestUser, data: Buffer, name = 'photo.jpg', type = 'image/jpeg') {
  const boundary = `----ypl${Date.now()}${Math.random().toString(36).slice(2)}`;
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
  return res.json().media.id as string;
}

/** Run the media job queued for one item, with the app's automated checks unless another moderator is given. */
async function processMedia(mediaId: string, moderator: MediaModerator = t.ctx.mediaModerator) {
  const job = (await db().query(`SELECT id, payload FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1 AND status = 'queued'`, [mediaId]))
    .rows[0];
  expect(job, `a media job for ${mediaId}`).toBeTruthy();
  await mediaJobHandlers({ db: db(), storage: t.ctx.storage, moderator, realtime: t.ctx.realtime })['media.process'](job.payload);
  await db().query(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [job.id]);
}

/** Upload photos and let the media job finish on each, like the apps wait for before making a collage. */
async function photos(user: TestUser, ...colours: Rgb[]) {
  const ids: string[] = [];
  for (const c of colours) {
    const id = await upload(user, await solid(300, 300, c));
    await processMedia(id);
    ids.push(id);
  }
  return ids;
}

const cells = (ids: string[]) => ids.map((mediaId) => ({ mediaId }));
const stored = async (id: string) => {
  const { rows } = await db().query(`SELECT storage_key FROM media WHERE id = $1`, [id]);
  return t.ctx.storage.read(rows[0].storage_key);
};
async function pixels(id: string) {
  const { data, info } = await sharp(await stored(id))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
    return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
  };
  return { at, width: info.width, height: info.height };
}
const near = (a: Rgb, b: Rgb, tolerance = 24) => Math.abs(a.r - b.r) < tolerance && Math.abs(a.g - b.g) < tolerance && Math.abs(a.b - b.b) < tolerance;
const collages = async (user: TestUser) =>
  (await db().query(`SELECT count(*)::int AS n FROM media_collages WHERE owner_id = $1`, [user.id])).rows[0].n as number;

describe('who can make a collage from what', () => {
  it("refuses someone else's photos, and photos that don't exist, as if they weren't there", async () => {
    const me = await adult();
    const other = await adult();
    const [a, b] = await photos(me, RED, BLUE);
    const [theirs] = await photos(other, GREEN);
    const api = as(t.app, me);
    const r = await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([a!, theirs!]) });
    expect(r.status).toBe(404);
    expect(r.body.error.message).not.toContain(other.username);
    expect((await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([a!, randomUUID()]) })).status).toBe(404);
    expect((await as(t.app, null).post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([a!, b!]) })).status).toBe(401);
    // Their photo stays theirs: nothing was made.
    expect(await collages(me)).toBe(0);
    const made = await db().query(`SELECT count(*)::int AS n FROM media WHERE owner_id = $1`, [me.id]);
    expect(made.rows[0].n).toBe(2);
  });

  it('only takes processed photos: not videos, GIFs, blocked photos or photos still being prepared', async () => {
    const me = await adult();
    const [photo] = await photos(me, RED);
    const api = as(t.app, me);
    const { rows } = await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, variants) VALUES ($1,'video','http://localhost:4000/media/v.mp4','video/mp4','ready','v.mp4','{"mp4":"x"}') RETURNING id`,
      [me.id],
    );
    const video = await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([photo!, rows[0].id]) });
    expect(video.status).toBe(400);
    expect(video.body.error.message).toBe('Collages are made from photos.');

    const gif = await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, variants, moderation) VALUES ($1,'image','http://localhost:4000/media/a.gif','image/gif','ready','a.gif','{"thumb":"x"}','ok') RETURNING id`,
      [me.id],
    );
    expect((await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([photo!, gif.rows[0].id]) })).status).toBe(415);

    // Uploaded, but the media job hasn't run yet.
    const fresh = await upload(me, await solid(200, 200, BLUE));
    const early = await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([photo!, fresh]) });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('media_processing');
    await processMedia(fresh);
    const k = key();
    expect((await api.post('/v1/media/collage', { clientKey: k, layout: 'side-by-side', cells: cells([photo!, fresh]) })).status).toBe(201);

    // A photo the automated check blocked can't be put in a collage either.
    const blocked = await upload(me, await solid(200, 200, GREEN), 'blocked.jpg');
    await processMedia(blocked);
    const refused = await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([photo!, blocked]) });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('media_blocked');
    expect(await collages(me)).toBe(1);
  });

  it('checks the layout, shape, colours and cells', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE, GREEN);
    const api = as(t.app, me);
    const bad = [
      { layout: 'side-by-side', cells: cells(ids) },
      { layout: 'grid-12', cells: cells(ids) },
      { layout: 'columns-3', cells: cells([ids[0]!, ids[0]!, ids[1]!]) },
      { layout: 'columns-3', shape: 'landscape', cells: cells(ids) },
      { layout: 'columns-3', background: '#00ff00', cells: cells(ids) },
      { layout: 'columns-3', gap: 'huge', cells: cells(ids) },
      { layout: 'columns-3', radius: 'blob', cells: cells(ids) },
      { layout: 'columns-3', cells: [{ mediaId: ids[0], focusX: 2 }, ...cells(ids.slice(1))] },
      { layout: 'columns-3', cells: [{ mediaId: ids[0], zoom: 9 }, ...cells(ids.slice(1))] },
      { layout: 'grid-9', cells: cells([...ids, ...Array.from({ length: 7 }, () => randomUUID())]) },
    ];
    for (const b of bad) {
      const r = await api.post('/v1/media/collage', { clientKey: key(), ...b });
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.error.code).toBe('validation_failed');
    }
    expect((await api.post('/v1/media/collage', { layout: 'columns-3', cells: cells(ids) })).status).toBe(400);
    expect(await collages(me)).toBe(0);
  });
});

describe('the collage picture', () => {
  it('is the size of the shape, drawn at full quality with no metadata', async () => {
    const me = await adult();
    // A photo with a camera EXIF block: none of it may reach the collage.
    const withExif = await sharp({ create: { width: 300, height: 300, channels: 3, background: RED } })
      .withExif({ IFD0: { Make: 'TestCam', Model: 'Collage 1', Copyright: 'Someone' } })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();
    const a = await upload(me, withExif);
    await processMedia(a);
    const [b] = await photos(me, BLUE);
    const api = as(t.app, me);
    for (const shape of ['square', 'portrait', 'story'] as CollageShape[]) {
      const r = await api.post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', shape, cells: cells([a, b!]) });
      expect(r.status).toBe(201);
      const size = COLLAGE_SIZES[shape];
      expect(r.body.media).toMatchObject({ kind: 'image', width: size.width, height: size.height, collage: true });
      const meta = await sharp(await stored(r.body.media.id)).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: size.width, height: size.height });
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
    expect({ square: [2160, 2160], portrait: [1728, 2160], story: [1215, 2160] }).toEqual(
      Object.fromEntries(Object.entries(COLLAGE_SIZES).map(([k, v]) => [k, [v.width, v.height]])),
    );
  });

  it('puts each photo in its cell, with the gap and background chosen and the crop where it was dragged', async () => {
    const me = await adult();
    const [red, blue, green, yellow] = await photos(me, RED, BLUE, GREEN, YELLOW);
    const api = as(t.app, me);
    const r = await api.post('/v1/media/collage', {
      clientKey: key(),
      layout: 'grid-4',
      shape: 'square',
      gap: 'wide',
      background: 'black',
      cells: cells([red!, blue!, green!, yellow!]),
    });
    expect(r.status).toBe(201);
    const px = await pixels(r.body.media.id);
    const layout = collageLayout('grid-4')!;
    const centre = (i: number) => {
      const c = cellRect(layout, i, px.width, px.height, 'wide', 'none');
      return px.at(c.left + c.width / 2, c.top + c.height / 2);
    };
    expect(near(centre(0), RED)).toBe(true);
    expect(near(centre(1), BLUE)).toBe(true);
    expect(near(centre(2), GREEN)).toBe(true);
    expect(near(centre(3), YELLOW)).toBe(true);
    // The wide gap shows the black background, at the edge and between photos.
    expect(near(px.at(10, 10), { r: 16, g: 17, b: 20 })).toBe(true);
    expect(near(px.at(px.width / 2, px.height / 4), { r: 16, g: 17, b: 20 })).toBe(true);

    // A wide photo in a square cell: the focus decides which half shows.
    const split = await upload(me, await halves());
    await processMedia(split);
    const left = await api.post('/v1/media/collage', {
      clientKey: key(),
      layout: 'side-by-side',
      gap: 'none',
      cells: [{ mediaId: split, focusX: 0 }, { mediaId: green }],
    });
    const right = await api.post('/v1/media/collage', {
      clientKey: key(),
      layout: 'side-by-side',
      gap: 'none',
      cells: [{ mediaId: split, focusX: 1 }, { mediaId: green }],
    });
    const l = await pixels(left.body.media.id);
    const rr = await pixels(right.body.media.id);
    expect(near(l.at(l.width / 4, l.height / 2), RED)).toBe(true);
    expect(near(rr.at(rr.width / 4, rr.height / 2), BLUE)).toBe(true);
  });

  it('draws a scrapbook with turned, white-edged photos on the background', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE, GREEN);
    const r = await as(t.app, me).post('/v1/media/collage', {
      clientKey: key(),
      layout: 'scrapbook-3',
      shape: 'portrait',
      background: 'sage',
      cells: cells(ids),
    });
    expect(r.status).toBe(201);
    const px = await pixels(r.body.media.id);
    expect(px.width).toBe(1728);
    // The corner is background (sage); each photo's centre is its colour.
    expect(near(px.at(3, 3), { r: 0xcc, g: 0xdd, b: 0xc4 })).toBe(true);
    const layout = collageLayout('scrapbook-3')!;
    for (const [i, colour] of [RED, BLUE, GREEN].entries()) {
      const c = cellRect(layout, i, px.width, px.height, 'thin', 'none');
      expect(near(px.at(c.left + c.width / 2, c.top + c.height / 2), colour), `photo ${i}`).toBe(true);
    }
  });
});

describe('sending the same collage again', () => {
  it('gives back the same collage for the same key, and refuses the key for a different one', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE);
    const api = as(t.app, me);
    const k = key();
    const body = {
      clientKey: k,
      layout: 'stacked',
      shape: 'story',
      radius: 'soft',
      background: 'plum',
      cells: [{ mediaId: ids[0], focusX: 0.25 }, { mediaId: ids[1] }],
    };
    const first = await api.post('/v1/media/collage', body);
    expect(first.status).toBe(201);
    const second = await api.post('/v1/media/collage', body);
    expect(second.status).toBe(200);
    expect(second.body.media).toEqual(first.body.media);
    // Defaults written out are the same request.
    const spelled = await api.post('/v1/media/collage', {
      ...body,
      gap: 'thin',
      cells: [{ mediaId: ids[0], focusX: 0.25, focusY: 0.5, zoom: 1 }, { mediaId: ids[1] }],
    });
    expect(spelled.body.media.id).toBe(first.body.media.id);
    const media = await db().query(`SELECT count(*)::int AS n FROM media WHERE owner_id = $1`, [me.id]);
    expect(media.rows[0].n).toBe(3);
    const jobs = await db().query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1`, [first.body.media.id]);
    expect(jobs.rows[0].n).toBe(1);

    const changed = await api.post('/v1/media/collage', { ...body, background: 'white' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('idempotency_mismatch');
    // Keys are per person: someone else's key doesn't reach this collage.
    const other = await adult();
    const theirs = await photos(other, GREEN, YELLOW);
    const r = await as(t.app, other).post('/v1/media/collage', { ...body, cells: cells(theirs) });
    expect(r.status).toBe(201);
    expect(r.body.media.id).not.toBe(first.body.media.id);
  });

  it('sends two copies of one request at once and still makes one collage', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE);
    const body = { clientKey: key(), layout: 'side-by-side', cells: cells(ids) };
    const results = await Promise.all([as(t.app, me).post('/v1/media/collage', body), as(t.app, me).post('/v1/media/collage', body)]);
    const ok = results.filter((r) => r.status === 200 || r.status === 201);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect(new Set(ok.map((r) => r.body.media.id)).size).toBe(1);
    const made = await db().query(`SELECT count(*)::int AS n FROM media WHERE owner_id = $1`, [me.id]);
    expect(made.rows[0].n).toBe(3);
  });
});

describe('processing and checks', () => {
  it('goes through the media job like an upload: sizes, blurred preview and the automated check', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE);
    const r = await as(t.app, me).post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells(ids) });
    const id = r.body.media.id as string;
    const before = await as(t.app, me).get(`/v1/media/${id}`);
    expect(before.body.media).toMatchObject({ status: 'ready', processed: false });
    await processMedia(id);
    const after = await as(t.app, me).get(`/v1/media/${id}`);
    expect(after.body.media).toMatchObject({ status: 'ready', processed: true, width: 2160, height: 2160 });
    expect(after.body.media.variants.thumb).toBeTruthy();
    expect(after.body.media.variants.large).toBeTruthy();
    expect(after.body.media.blurhash).toMatch(/^data:image\/webp;base64,/);
    const { rows } = await db().query(`SELECT moderation, moderation_provider FROM media WHERE id = $1`, [id]);
    expect(rows[0]).toMatchObject({ moderation: 'ok', moderation_provider: 'dev' });

    // Used like any photo: in a post and in a story.
    const post = await as(t.app, me).post('/v1/posts', { body: 'Weekend', media: [{ id, url: r.body.media.url, kind: 'image' }] });
    expect(post.status).toBe(201);
    expect(post.body.post.media[0].id).toBe(id);
    expect((await as(t.app, me).post('/v1/moments', { mediaId: id, visibility: 'friends' })).status).toBe(201);
    // Nobody else can look it up.
    expect((await as(t.app, await adult()).get(`/v1/media/${id}`)).status).toBe(404);
  });

  it('is blocked by the automated check like an upload would be', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE);
    const r = await as(t.app, me).post('/v1/media/collage', { clientKey: key(), layout: 'stacked', cells: cells(ids) });
    const id = r.body.media.id as string;
    const post = await as(t.app, me).post('/v1/posts', { body: 'Look', media: [{ id, url: r.body.media.url, kind: 'image' }] });
    expect(post.status).toBe(201);
    const seen: string[] = [];
    const strict: MediaModerator = {
      name: 'strict',
      async moderate(frames, hints) {
        seen.push(`${hints.mediaId}:${frames.length}`);
        return { verdict: 'blocked', labels: [{ name: 'Test: blocked', confidence: 99 }] };
      },
    };
    await processMedia(id, strict);
    expect(seen).toEqual([`${id}:1`]);
    const { rows } = await db().query(`SELECT moderation FROM media WHERE id = $1`, [id]);
    expect(rows[0].moderation).toBe('blocked');
    const kase = await db().query(`SELECT status FROM moderation_cases WHERE target_type = 'media' AND target_id = $1`, [id]);
    expect(kase.rows[0]?.status).toBe('open');
    const p = await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [post.body.post.id]);
    expect(p.rows[0].moderation_status).toBe('removed');
  });

  it('is at least as sensitive as the photos in it, and never shown to people under 18', async () => {
    const me = await adult();
    const [plain] = await photos(me, RED);
    const sensitive = await upload(me, await solid(300, 300, BLUE), 'beach-sensitive.jpg');
    await processMedia(sensitive);
    const r = await as(t.app, me).post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', cells: cells([plain!, sensitive]) });
    expect(r.status).toBe(201);
    const id = r.body.media.id as string;
    const moderation = async () => (await db().query(`SELECT moderation FROM media WHERE id = $1`, [id])).rows[0].moderation;
    expect(await moderation()).toBe('sensitive');
    // The check on the collage itself finds nothing, but it keeps the verdict of the photo in it.
    await processMedia(id);
    expect(await moderation()).toBe('sensitive');
    const post = (await as(t.app, me).post('/v1/posts', { body: 'Beach day', media: [{ id, url: r.body.media.url, kind: 'image' }] })).body.post;
    expect(post.media[0]).toMatchObject({ id, sensitive: true });
    const teen = await signUp(t.app, { birthDate: '2012-06-01' });
    const seen = await as(t.app, teen).get(`/v1/posts/${post.id}`);
    expect(seen.body.post?.media ?? []).toEqual([]);
  });
});

describe('your data', () => {
  it('lists your collages in your export, and removes them with your account', async () => {
    const me = await adult();
    const ids = await photos(me, RED, BLUE);
    const r = await as(t.app, me).post('/v1/media/collage', { clientKey: key(), layout: 'side-by-side', background: 'sky', cells: cells(ids) });
    const exported = await as(t.app, me).get('/v1/me/export');
    expect(exported.body.collages).toHaveLength(1);
    expect(exported.body.collages[0]).toMatchObject({ media_id: r.body.media.id, source_ids: ids, spec: { layout: 'side-by-side', background: 'sky' } });
    expect((await as(t.app, me).del('/v1/me', { password: me.password })).status).toBe(200);
    expect(await collages(me)).toBe(0);
    expect((await db().query(`SELECT count(*)::int AS n FROM media WHERE owner_id = $1`, [me.id])).rows[0].n).toBe(0);
  });
});
