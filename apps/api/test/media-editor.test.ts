import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyColorMatrix, colorMatrix, cssFilter, FILTERS, filterOps, IDENTITY_MATRIX, mediaEditSchema } from '@yapilapi/shared';
import { processJobs } from '../src/lib/jobs.ts';
import { mediaJobHandlers, probe } from '../src/lib/media-processing.ts';
import { editorJobHandlers, planVideo } from '../src/lib/media-edit.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let clip: Buffer;
let photo: Buffer;
const dir = mkdtempSync(path.join(tmpdir(), 'ypl-editor-test-'));

beforeAll(async () => {
  t = await testApp();
  // A tiny 2 second test video with a tone, made with the bundled ffmpeg.
  const src = path.join(dir, 'clip.mp4');
  const r = spawnSync(ffmpegPath as unknown as string, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    src,
  ]);
  expect(r.status).toBe(0);
  clip = readFileSync(src);
  // A 64×48 photo in one colour, so the look can be checked pixel by pixel.
  photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .jpeg({ quality: 100 })
    .toBuffer();
});
afterAll(async () => {
  await t.close();
});

const handlers = () => ({
  ...mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
  ...editorJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
});

async function drain() {
  for (let i = 0; i < 50; i++) if (!(await processJobs(t.ctx.db, handlers()))) return;
}

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = `----ypl${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(user: TestUser, data: Buffer, type: string, name: string) {
  const body = multipart({ name, type, data });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${user.token}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().media.id as string;
}

describe('filter presets', () => {
  it('has twelve looks, each with a CSS preview and a matrix', () => {
    expect(FILTERS).toHaveLength(12);
    expect(new Set(FILTERS.map((f) => f.id)).size).toBe(12);
    expect(cssFilter('original')).toBe('none');
    expect(colorMatrix('original')).toEqual(IDENTITY_MATRIX);
    for (const f of FILTERS.slice(1)) expect(cssFilter(f.id)).toMatch(/^(\w|-)+\(/);
    expect(cssFilter('original', { brightness: 50 })).toBe('brightness(1.2)');
  });

  it('folds the CSS chain into one matrix that matches applying each function in turn', () => {
    for (const f of FILTERS) {
      const folded = Uint8ClampedArray.from([128, 100, 90, 255]);
      applyColorMatrix(folded, colorMatrix(f.id, { warmth: 20, fade: 10 }));
      // One function at a time, on floats, as the CSS spec defines each one.
      let px = [128 / 255, 100 / 255, 90 / 255];
      for (const op of filterOps(f.id, { warmth: 20, fade: 10 })) {
        const single = singleOp(op);
        px = [0, 1, 2].map((r) => single.m[r * 3]! * px[0]! + single.m[r * 3 + 1]! * px[1]! + single.m[r * 3 + 2]! * px[2]! + single.o[r]!);
      }
      const expected = px.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
      for (let i = 0; i < 3; i++) expect(Math.abs(folded[i]! - expected[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('validates edit requests', () => {
    expect(mediaEditSchema.safeParse({ filter: 'lagos', adjustments: { warmth: 30 } }).success).toBe(true);
    expect(mediaEditSchema.safeParse({ filter: 'sepia' }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ adjustments: { brightness: 101 } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ adjustments: { fade: -1 } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ adjustments: { exposure: 10 } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ crop: { x: 0.6, y: 0, w: 0.6, h: 1 } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ rotate: 45 }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ text: { value: '   ' } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ text: { value: 'x'.repeat(101) } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ text: { value: 'Hi', color: '#123456' } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ trim: { startMs: 500, endMs: 1000 } }).success).toBe(false);
    expect(mediaEditSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it('plans the ffmpeg command with the look, vignette and text', () => {
    const p = mediaEditSchema.parse({
      filter: 'noir',
      trim: { startMs: 500, endMs: 1500 },
      muted: true,
      rotate: 90,
      text: { value: "It's 100% Lagos: a:b", font: 'mono', background: true },
    });
    const plan = planVideo(
      p,
      { input: '/in', output: '/out.mp4', vignette: '/v.png', textFile: '/t.txt' },
      { durationMs: 2000, hasAudio: true, width: 320, height: 240 },
    );
    expect(plan.durationMs).toBe(1000);
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('transpose=clock');
    expect(graph).toContain('colorchannelmixer=');
    expect(graph).toContain('scale2ref');
    expect(graph).toContain("textfile='/t.txt'");
    expect(graph).toContain('fontsize=17'); // 7% of the 240 pixel wide turned frame
    expect(graph).toContain('box=1');
    expect(plan.args).toContain('-an');
  });
});

/** One CSS filter function's matrix, written out from the spec independently of the code under test. */
function singleOp([name, v]: readonly [string, number]) {
  const id = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };
  if (name === 'brightness') return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [0, 0, 0] };
  if (name === 'contrast') return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [0.5 - 0.5 * v, 0.5 - 0.5 * v, 0.5 - 0.5 * v] };
  if (name === 'saturate')
    return {
      m: [
        0.213 + 0.787 * v,
        0.715 - 0.715 * v,
        0.072 - 0.072 * v,
        0.213 - 0.213 * v,
        0.715 + 0.285 * v,
        0.072 - 0.072 * v,
        0.213 - 0.213 * v,
        0.715 - 0.715 * v,
        0.072 + 0.928 * v,
      ],
      o: [0, 0, 0],
    };
  if (name === 'grayscale' || name === 'sepia') {
    const a = 1 - v;
    return name === 'grayscale'
      ? {
          m: [
            0.2126 + 0.7874 * a,
            0.7152 - 0.7152 * a,
            0.0722 - 0.0722 * a,
            0.2126 - 0.2126 * a,
            0.7152 + 0.2848 * a,
            0.0722 - 0.0722 * a,
            0.2126 - 0.2126 * a,
            0.7152 - 0.7152 * a,
            0.0722 + 0.9278 * a,
          ],
          o: [0, 0, 0],
        }
      : {
          m: [
            0.393 + 0.607 * a,
            0.769 - 0.769 * a,
            0.189 - 0.189 * a,
            0.349 - 0.349 * a,
            0.686 + 0.314 * a,
            0.168 - 0.168 * a,
            0.272 - 0.272 * a,
            0.534 - 0.534 * a,
            0.131 + 0.869 * a,
          ],
          o: [0, 0, 0],
        };
  }
  if (name === 'hue-rotate') {
    const r = (v * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return {
      m: [
        0.213 + c * 0.787 - s * 0.213,
        0.715 - c * 0.715 - s * 0.715,
        0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143,
        0.715 + c * 0.285 + s * 0.14,
        0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787,
        0.715 - c * 0.715 + s * 0.715,
        0.072 + c * 0.928 + s * 0.072,
      ],
      o: [0, 0, 0],
    };
  }
  return id;
}

describe('POST /v1/media/:id/edit', () => {
  let owner: TestUser;
  let other: TestUser;
  let photoId: string;
  let videoId: string;
  beforeAll(async () => {
    owner = await signUp(t.app);
    other = await signUp(t.app);
    photoId = await upload(owner, photo, 'image/jpeg', 'photo.jpg');
    videoId = await upload(owner, clip, 'video/mp4', 'clip.mp4');
  });

  it('only lets the owner edit, and only the owner can read the result', async () => {
    expect((await as(t.app, null).post(`/v1/media/${photoId}/edit`, { filter: 'warm' })).status).toBe(401);
    const r = await as(t.app, other).post(`/v1/media/${photoId}/edit`, { filter: 'warm' });
    expect(r.status).toBe(404);
    expect((await as(t.app, other).post(`/v1/media/${videoId}/edit`, { muted: true })).status).toBe(404);
    expect((await as(t.app, other).get(`/v1/media/${photoId}`)).status).toBe(404);
    expect((await as(t.app, owner).get(`/v1/media/${photoId}`)).status).toBe(200);
    // Nothing was queued for the stranger's attempts.
    const { rows } = await t.ctx.db.query(`SELECT count(*)::int AS n FROM media_editor_renders WHERE source_media_id = ANY($1)`, [[photoId, videoId]]);
    expect(rows[0].n).toBe(0);
  });

  it('validates the request', async () => {
    const api = as(t.app, owner);
    const bad = async (id: string, body: unknown, field: string) => {
      const r = await api.post(`/v1/media/${id}/edit`, body);
      expect(r.status).toBe(400);
      expect(Object.keys(r.body.error.details.fields)).toContain(field);
    };
    await bad(photoId, { filter: 'nope' }, 'filter');
    await bad(photoId, { adjustments: { contrast: 250 } }, 'adjustments.contrast');
    await bad(photoId, { trim: { startMs: 0, endMs: 1500 } }, 'trim');
    await bad(photoId, { coverMs: 10 }, 'coverMs');
    await bad(videoId, { trim: { startMs: 0, endMs: 9000 } }, 'trim.endMs');
    await bad(videoId, { trim: { startMs: 500, endMs: 1200 } }, 'trim.endMs');
    await bad(videoId, { trim: { startMs: 0, endMs: 1500 }, coverMs: 1800 }, 'coverMs');
    await bad(videoId, { text: { value: 'Hi', font: 'comic' } }, 'text.font');
    expect((await api.post(`/v1/media/00000000-0000-4000-8000-000000000000/edit`, {})).status).toBe(404);
  });

  it('caps edited videos at the reel length, 10 minutes with Plus', async () => {
    const stored = await t.ctx.storage.put(clip, 'mp4', 'video/mp4');
    const long = await t.ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, storage_key, duration_ms) VALUES ($1,'video',$2,'video/mp4',$3,$4) RETURNING id`,
      [owner.id, stored.url, stored.key, 700_000],
    );
    const id = long.rows[0].id;
    const api = as(t.app, owner);
    let r = await api.post(`/v1/media/${id}/edit`, { filter: 'vivid' });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.trim).toMatch(/3 minutes/);
    r = await api.post(`/v1/media/${id}/edit`, { trim: { startMs: 0, endMs: 200_000 } });
    expect(r.status).toBe(400);
    await t.ctx.db.query(`UPDATE profiles SET plus_until = now() + interval '1 day' WHERE user_id = $1`, [owner.id]);
    r = await api.post(`/v1/media/${id}/edit`, { trim: { startMs: 0, endMs: 200_000 } });
    expect(r.status).toBe(202);
    r = await api.post(`/v1/media/${id}/edit`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.trim).toMatch(/10 minutes/);
    await t.ctx.db.query(`UPDATE profiles SET plus_until = NULL WHERE user_id = $1`, [owner.id]);
    // Leave nothing for the real renders below to trip over.
    await t.ctx.db.query(`DELETE FROM jobs WHERE kind = 'media.editor'`);
  });

  it('edits a photo with sharp: turn, crop, look and text', async () => {
    const api = as(t.app, owner);
    const r = await api.post(`/v1/media/${photoId}/edit`, { filter: 'mono', rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(r.status).toBe(202);
    expect(r.body.media.status).toBe('processing');
    const id = r.body.media.id as string;
    expect(id).not.toBe(photoId);
    expect((await api.get(`/v1/media/${id}`)).body.media.status).toBe('processing');
    await drain();
    const m = (await api.get(`/v1/media/${id}`)).body.media;
    expect(m).toMatchObject({ status: 'ready', kind: 'image', width: 24, height: 64, mime: 'image/jpeg', editOf: photoId });
    expect(m.variants.thumb).toBeTruthy();
    const key = (await t.ctx.db.query(`SELECT storage_key FROM media WHERE id = $1`, [id])).rows[0].storage_key;
    const { data } = await sharp(await t.ctx.storage.read(key))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Mono: grey, at the level the shared matrix gives (JPEG may drift a little).
    const expected = Uint8ClampedArray.from([200, 60, 40, 255]);
    applyColorMatrix(expected, colorMatrix('mono'));
    const mid = (32 * 24 + 12) * 3;
    expect(Math.abs(data[mid]! - data[mid + 2]!)).toBeLessThanOrEqual(3);
    expect(Math.abs(data[mid]! - expected[0]!)).toBeLessThanOrEqual(4);
    // The original is untouched.
    const orig = (await api.get(`/v1/media/${photoId}`)).body.media;
    expect(orig.width).toBe(64);

    // Text and a vignette change the pixels where they are drawn.
    const r2 = await api.post(`/v1/media/${photoId}/edit`, {
      filter: 'original',
      adjustments: { vignette: 100 },
      text: { value: 'Hello', font: 'bold', color: '#FFFFFF', x: 0.5, y: 0.5, size: 0.2 },
    });
    expect(r2.status).toBe(202);
    await drain();
    const m2 = (await api.get(`/v1/media/${r2.body.media.id}`)).body.media;
    expect(m2.status).toBe('ready');
    const key2 = (await t.ctx.db.query(`SELECT storage_key FROM media WHERE id = $1`, [m2.id])).rows[0].storage_key;
    const px = await sharp(await t.ctx.storage.read(key2))
      .raw()
      .toBuffer();
    const at = (x: number, y: number) => px[(y * 64 + x) * 3]!;
    // Corner darkened by the vignette, well below the original red of 200.
    expect(at(0, 0)).toBeLessThan(150);
    // Some white text near the middle.
    let white = 0;
    for (let y = 18; y < 30; y++) for (let x = 10; x < 54; x++) if (px[(y * 64 + x) * 3 + 1]! > 200) white++;
    expect(white).toBeGreaterThan(0);
  });

  it('edits a video with ffmpeg: trim, look, text, mute and cover', async () => {
    const api = as(t.app, owner);
    const r = await api.post(`/v1/media/${videoId}/edit`, {
      trim: { startMs: 500, endMs: 1700 },
      filter: 'noir',
      adjustments: { sharpen: 40 },
      muted: true,
      coverMs: 1000,
      text: { value: 'Day one', font: 'mono', color: '#FFD60A', x: 0.5, y: 0.8, background: true },
    });
    expect(r.status).toBe(202);
    const id = r.body.media.id as string;
    await drain();
    const m = (await api.get(`/v1/media/${id}`)).body.media;
    expect(m.error).toBeNull();
    expect(m.status).toBe('ready');
    expect(m.kind).toBe('video');
    expect(m.durationMs).toBeGreaterThan(1050);
    expect(m.durationMs).toBeLessThan(1400);
    expect(m.variants.mp4).toBeTruthy();
    expect(m.hlsUrl).toBeTruthy();
    expect(m.posterUrl).toMatch(/_cover\.jpg$/);
    // Check the stored file itself: length after the trim, no sound.
    const key = (await t.ctx.db.query(`SELECT storage_key FROM media WHERE id = $1`, [id])).rows[0].storage_key;
    const file = path.join(dir, 'out.mp4');
    writeFileSync(file, await t.ctx.storage.read(key));
    const info = await probe(file);
    expect(Math.abs(info.durationMs! - 1200)).toBeLessThan(150);
    expect(info.hasAudio).toBe(false);
    expect(info.width).toBe(320);
    // Noir is black and white: the colour bars come out grey.
    const frame = spawnSync(ffmpegPath as unknown as string, ['-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const rgb = frame.stdout;
    let maxSpread = 0;
    for (let i = 0; i < rgb.length; i += 3 * 97)
      maxSpread = Math.max(maxSpread, Math.max(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) - Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!));
    // Everything grey except the yellow text.
    expect(maxSpread).toBeGreaterThan(0);
    let grey = 0;
    let total = 0;
    for (let i = 0; i < rgb.length / 2; i += 3 * 7) {
      total++;
      if (Math.max(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) - Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) < 12) grey++;
    }
    expect(grey / total).toBeGreaterThan(0.95);
  });

  it('keeps the sound unless muted, and turns and crops the frame', async () => {
    const api = as(t.app, owner);
    const r = await api.post(`/v1/media/${videoId}/edit`, { rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 }, filter: 'lagos' });
    expect(r.status).toBe(202);
    await drain();
    const m = (await api.get(`/v1/media/${r.body.media.id}`)).body.media;
    expect(m.status).toBe('ready');
    const key = (await t.ctx.db.query(`SELECT storage_key FROM media WHERE id = $1`, [m.id])).rows[0].storage_key;
    const file = path.join(dir, 'out2.mp4');
    writeFileSync(file, await t.ctx.storage.read(key));
    const info = await probe(file);
    expect(info.hasAudio).toBe(true);
    expect([info.width, info.height]).toEqual([120, 320]);
    expect(Math.abs(info.durationMs! - 2000)).toBeLessThan(200);
  });
});
