import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectMedia } from '../src/lib/media-formats.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let user: TestUser;
const dir = mkdtempSync(path.join(tmpdir(), 'ypl-formats-'));

/** A tiny sample in any format ffmpeg writes. */
function sample(name: string, args: string[]): Buffer {
  const out = path.join(dir, name);
  execFileSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
  return readFileSync(out);
}
const video = (name: string, extra: string[] = []) =>
  sample(name, ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-shortest', ...extra]);
const audio = (name: string, extra: string[] = []) => sample(name, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', ...extra]);
const image = (name: string) => sample(name, ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1', '-frames:v', '1']);

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = `----ypl${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(name: string, data: Buffer, type = 'application/octet-stream') {
  const body = multipart({ name, type, data });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    headers: { ...body.headers, authorization: `Bearer ${user.token}` },
    payload: body.payload,
  });
  const media =
    res.statusCode === 201 ? (await t.ctx.db.query(`SELECT id, kind, mime, duration_ms FROM media WHERE id = $1`, [res.json().media.id])).rows[0] : null;
  // Processing runs explicitly where a test needs it; don't leave jobs queued for other test files' job runners.
  if (media) await t.ctx.db.query(`DELETE FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1`, [media.id]);
  return { status: res.statusCode, media };
}

beforeAll(async () => {
  t = await testApp();
  user = await signUp(t.app, { birthDate: '1990-01-01' });
});
afterAll(async () => {
  await t.close();
});

describe('photo, video and audio formats', () => {
  it('accepts iPhone HEIC photos and stores them as JPEG, whatever the browser calls them', async () => {
    const heic = readFileSync(path.join(__dirname, 'fixtures', 'photo.heic'));
    expect(detectMedia(heic)?.mime).toBe('image/heic');
    expect(await upload('IMG_0001.HEIC', heic)).toMatchObject({ status: 201, media: { kind: 'image', mime: 'image/jpeg' } });
    expect(await upload('IMG_0001.HEIC', heic, 'image/heic')).toMatchObject({ status: 201, media: { mime: 'image/jpeg' } });
  });

  it.each([
    ['photo.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.gif', 'image/gif'],
    ['photo.webp', 'image/webp'],
    ['photo.bmp', 'image/jpeg'],
    ['photo.tiff', 'image/jpeg'],
  ])('accepts %s as a photo', async (name, stored) => {
    expect(await upload(name, image(name))).toMatchObject({ status: 201, media: { kind: 'image', mime: stored } });
  });

  it.each([
    ['clip.mp4', 'video/mp4', []],
    ['clip.mov', 'video/quicktime', []],
    ['clip.webm', 'video/webm', ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']],
    ['clip.mkv', 'video/x-matroska', []],
    ['clip.avi', 'video/x-msvideo', []],
    ['clip.3gp', 'video/3gpp', ['-c:v', 'libx264', '-c:a', 'aac']],
    ['clip.mpg', 'video/mpeg', ['-r', '25']],
  ])('accepts %s as a video', async (name, mime, extra) => {
    const data = video(name, extra as string[]);
    expect(detectMedia(data)?.mime).toBe(mime);
    expect(await upload(name, data)).toMatchObject({ status: 201, media: { kind: 'video', mime } });
  });

  it.each([
    ['voice.m4a', 'audio/mp4', ['-c:a', 'aac']],
    ['song.mp3', 'audio/mpeg', ['-c:a', 'libmp3lame']],
    ['voice.ogg', 'audio/mp4', ['-c:a', 'libopus']],
    ['voice.weba', 'audio/mp4', ['-c:a', 'libopus', '-f', 'webm']],
    ['sound.wav', 'audio/mp4', []],
    ['sound.flac', 'audio/mp4', []],
  ])('accepts %s as audio that plays everywhere, with its length', async (name, stored, extra) => {
    const r = await upload(name, audio(name, extra as string[]), 'audio/whatever');
    expect(r).toMatchObject({ status: 201, media: { kind: 'audio', mime: stored } });
    expect(r.media.duration_ms).toBeGreaterThan(1200);
    expect(r.media.duration_ms).toBeLessThan(1800);
  });

  it('turns MOV, MKV and AVI videos into a web MP4 with a poster', async () => {
    for (const name of ['phone.mov', 'film.mkv', 'old.avi']) {
      const r = await upload(name, video(name));
      await mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage })['media.process']({ mediaId: r.media.id });
      const m = (await t.ctx.db.query(`SELECT variants, poster_url FROM media WHERE id = $1`, [r.media.id])).rows[0];
      expect(m.variants.mp4, name).toMatch(/_web\.mp4$/);
      expect(m.poster_url, name).toMatch(/_poster\.jpg$/);
    }
  });

  it('refuses files that are not photos, videos or audio, whatever they are called', async () => {
    expect((await upload('notes.jpg', Buffer.from('just some text, not a photo'), 'image/jpeg')).status).toBe(415);
    expect((await upload('doc.pdf', Buffer.from('%PDF-1.7 fake'), 'application/pdf')).status).toBe(415);
  });
});
