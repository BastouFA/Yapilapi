import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { MediaStorage } from './storage.ts';
import { run, storePoster } from './media-processing.ts';
import type { StoredCover } from './video-covers.ts';

/** Covers are stored at the size of the default poster: at most 1280 pixels wide. */
const COVER_WIDTH = 1280;

/** One frame of a video file on disk, `atMs` from the start, as a poster-sized JPEG (as processing makes the default one). */
export async function frameOf(file: string, dir: string, atMs: number): Promise<Buffer> {
  const out = path.join(dir, `cover-${atMs}.jpg`);
  await run(['-ss', (atMs / 1000).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${COVER_WIDTH}:-2`, '-q:v', '3', out]);
  // Past the last frame ffmpeg writes nothing, without failing.
  if (!(await stat(out).catch(() => null))?.size) throw new Error('No frame at that moment.');
  return readFile(out);
}

/** A frame of a stored video (its original upload), a little before the end at most. */
export async function frameAt(storage: MediaStorage, key: string, atMs: number, durationMs: number | null): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-cover-'));
  try {
    const input = path.join(dir, 'input');
    await storage.download(key, input);
    const at = durationMs ? Math.max(0, Math.min(atMs, durationMs - 50)) : atMs;
    return await frameOf(input, dir, at).catch(() => frameOf(input, dir, Math.max(0, at - 500)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Width over height of a video's picture, read from its default poster (which is the right way up), else from its size. */
export async function videoAspect(storage: MediaStorage, posterKey: string | undefined, width: number | null, height: number | null): Promise<number> {
  if (posterKey) {
    const meta = await storage
      .read(posterKey)
      .then((b) => sharp(b).metadata())
      .catch(() => null);
    if (meta?.width && meta.height) return meta.width / meta.height;
  }
  return width && height ? width / height : 9 / 16;
}

/**
 * A photo as a video's cover: turned the right way up, the part chosen (`crop`, fractions of the
 * photo), then the middle of that in the video's shape, as a JPEG at most poster-sized.
 */
export async function fitPhoto(original: Buffer, aspect: number, crop?: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const upright = await sharp(original).rotate().toBuffer({ resolveWithObject: true });
  let { width, height } = upright.info;
  let img = sharp(upright.data);
  if (crop) {
    const left = Math.min(width - 1, Math.round(crop.x * width));
    const top = Math.min(height - 1, Math.round(crop.y * height));
    const w = Math.max(1, Math.min(width - left, Math.round(crop.w * width)));
    const h = Math.max(1, Math.min(height - top, Math.round(crop.h * height)));
    img = sharp(await img.extract({ left, top, width: w, height: h }).toBuffer());
    [width, height] = [w, h];
  }
  // The largest piece in the video's shape, from the middle.
  const w = Math.max(1, Math.min(width, Math.round(height * aspect)));
  const h = Math.max(1, Math.min(height, Math.round(w / aspect)));
  const outW = Math.min(COVER_WIDTH, w);
  return img
    .extract({ left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h })
    .resize({ width: outW, height: Math.max(1, Math.round(outW / aspect)), fit: 'fill' })
    .flatten({ background: '#000000' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Store a cover for the video at `videoKey` under new names (<key>_cover_<rev>.jpg and its thumb), so no cache shows the old one. */
export async function storeCover(storage: MediaStorage, videoKey: string, jpg: Buffer): Promise<StoredCover> {
  const base = `${videoKey.replace(/\.[^.]+$/, '')}_cover_${randomBytes(4).toString('hex')}`;
  const keys = { poster: `${base}.jpg`, thumb: `${base}_thumb.webp` };
  const p = await storePoster(storage, jpg, keys);
  return { ...p, keys: p.thumb ? [keys.poster, keys.thumb] : [keys.poster] };
}
