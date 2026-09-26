import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Pool, PoolClient } from 'pg';
import type { MediaStorage } from './storage.ts';
import { MAX_ATTEMPTS } from './jobs.ts';
import { probe, run } from './media-processing.ts';

type Q = Pool | PoolClient;

/** Printed on the end card. Profiles are also reachable at /@username on the web app. */
export const SHARE_DOMAIN = 'yapilapi.com';
/** How long the end card stays on screen. */
export const END_CARD_SECONDS = 1.5;
/** Share videos are at most this wide (vertical 720p): small enough for chat apps, sharp enough for status. */
const MAX_WIDTH = 720;

/** A font shipped with the API, so drawing text never depends on fonts installed on the server. */
export const FONT_FILE = fileURLToPath(new URL('../../assets/fonts/Geist-Regular.ttf', import.meta.url));

/** The app icon (shapes only, no text), rasterized for the end card. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="g" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#E0204F"/><stop offset=".6" stop-color="#FF5C4A"/><stop offset="1" stop-color="#FFB020"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="14" fill="url(#g)"/><g fill="#fff"><rect x="11" y="11" width="11" height="11" rx="3.5"/><rect x="26" y="11" width="11" height="11" rx="3.5"/><rect x="18.5" y="25" width="11" height="13" rx="3.5"/></g></svg>`;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Render the share video: the reel scaled to at most 720 wide, a small "YAPILAPI @username"
 * watermark in the corner, then a 1.5 s end card with the logo, the name and the profile
 * address. H.264/AAC with fast start, which WhatsApp status and other apps accept.
 */
export async function renderShareVideo(input: string, output: string, username: string): Promise<void> {
  const dir = path.dirname(output);
  const info = await probe(input);
  const srcW = info.width ?? 720;
  const srcH = info.height ?? 1280;
  const W = even(Math.min(MAX_WIDTH, srcW));
  const H = even((srcH * W) / srcW);

  // Text goes through files so no character in a name can break the filter syntax.
  await copyFile(FONT_FILE, path.join(dir, 'font.ttf'));
  await writeFile(path.join(dir, 'mark.txt'), `YAPILAPI @${username}`);
  await writeFile(path.join(dir, 'brand.txt'), 'YAPILAPI');
  const address = `${SHARE_DOMAIN}/@${username}`;
  await writeFile(path.join(dir, 'address.txt'), address);

  const short = Math.min(W, H);
  const markSize = Math.max(10, Math.round(short * 0.036));
  const margin = Math.round(short * 0.04);
  const logo = even(short * 0.2);
  const brandSize = Math.max(14, Math.round(short * 0.1));
  // The address shrinks for long names so it always fits on one line.
  const addressSize = Math.max(9, Math.min(Math.round(short * 0.045), Math.floor((W * 0.9) / (address.length * 0.56))));
  const block = logo + Math.round(logo * 0.3) + brandSize + Math.round(brandSize * 0.6) + addressSize;
  const logoY = Math.round((H - block) / 2);
  const brandY = logoY + logo + Math.round(logo * 0.3);
  const addressY = brandY + brandSize + Math.round(brandSize * 0.6);
  await sharp(Buffer.from(LOGO_SVG)).resize(logo, logo).png().toFile(path.join(dir, 'logo.png'));

  const text = (file: string, size: number, color: string, x: string, y: string, shadow = false) =>
    `drawtext=fontfile=font.ttf:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}` +
    (shadow ? `:shadowcolor=black@0.55:shadowx=${Math.max(1, Math.round(markSize / 12))}:shadowy=${Math.max(1, Math.round(markSize / 12))}` : '');

  const main =
    `[0:v]scale=${W}:${H},setsar=1,fps=30,` + `${text('mark.txt', markSize, 'white@0.85', `w-tw-${margin}`, `h-th-${margin}`, true)},format=yuv420p[v0]`;
  const card =
    `[1:v][2:v]overlay=x=(W-w)/2:y=${logoY},` +
    `${text('brand.txt', brandSize, 'white', '(w-tw)/2', String(brandY))},` +
    `${text('address.txt', addressSize, 'white@0.8', '(w-tw)/2', String(addressY))},setsar=1,format=yuv420p[v1]`;
  const inputs = [
    '-i',
    input,
    '-f',
    'lavfi',
    '-t',
    String(END_CARD_SECONDS),
    '-i',
    `color=c=0x111111:s=${W}x${H}:r=30`,
    '-loop',
    '1',
    '-t',
    String(END_CARD_SECONDS),
    '-i',
    'logo.png',
  ];
  const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

  if (info.hasAudio) {
    await run(
      [
        '-y',
        ...inputs,
        '-f',
        'lavfi',
        '-t',
        String(END_CARD_SECONDS),
        '-i',
        'anullsrc=r=44100:cl=stereo',
        '-filter_complex',
        `${main};${card};[0:a]aresample=44100,aformat=channel_layouts=stereo[a0];[3:a]aformat=channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
        '-map',
        '[v]',
        '-map',
        '[a]',
        ...encode,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        output,
      ],
      dir,
    );
  } else {
    await run(['-y', ...inputs, '-filter_complex', `${main};${card};[v0][v1]concat=n=2:v=1:a=0[v]`, '-map', '[v]', ...encode, output], dir);
  }
}

export interface ShareVideoDeps {
  db: Pool;
  storage: MediaStorage;
}

/** The storage key of the best source for a video: the processed web MP4 when there is one, else the upload. */
function sourceKey(m: { storage_key: string | null; variants: Record<string, string> | null }): string | null {
  if (!m.storage_key) return null;
  if (m.variants?.mp4) return `${m.storage_key.replace(/\.[^.]+$/, '')}_web.mp4`;
  return m.storage_key;
}

async function fail(db: Q, postId: string, message: string) {
  await db.query(`UPDATE share_videos SET status = 'failed', error = $2 WHERE post_id = $1`, [postId, message]);
}

export function shareVideoJobHandlers(deps: ShareVideoDeps) {
  return {
    'share.render': async ({ postId }: { postId: string }) => {
      const { db, storage } = deps;
      const job = (await db.query(`SELECT username FROM share_videos WHERE post_id = $1 AND status IN ('queued', 'processing')`, [postId])).rows[0];
      if (!job) return;
      const { rows } = await db.query(
        `SELECT m.storage_key, m.variants FROM post_media pm JOIN media m ON m.id = pm.media_id
         WHERE pm.post_id = $1 AND m.kind = 'video' ORDER BY pm.position LIMIT 1`,
        [postId],
      );
      const key = rows[0] ? sourceKey(rows[0]) : null;
      if (!key) return fail(db, postId, 'This reel has no video file to share.');
      await db.query(`UPDATE share_videos SET status = 'processing', error = NULL WHERE post_id = $1`, [postId]);
      const dir = await mkdtemp(path.join(tmpdir(), 'ypl-share-'));
      try {
        const input = path.join(dir, 'input');
        try {
          await storage.download(key, input);
        } catch {
          // The web MP4 may be missing (processing was re-run, or an older layout): fall back to the upload.
          const original = rows[0].storage_key as string;
          if (original === key) throw new Error('The reel video could not be read.');
          await storage.download(original, input);
        }
        const out = path.join(dir, 'share.mp4');
        await renderShareVideo(input, out, job.username);
        const stored = await storage.putFile(out, 'mp4', 'video/mp4', `shares/${postId}/${randomUUID()}.mp4`);
        await db.query(`UPDATE share_videos SET status = 'ready', storage_key = $2, url = $3, error = NULL WHERE post_id = $1`, [
          postId,
          stored.key,
          stored.url,
        ]);
      } catch (e) {
        // The queue retries with backoff; the row stays queued so status polls keep waiting, and
        // turns failed after the last attempt so people can ask again instead of waiting forever.
        const attempts = (
          await db.query(`SELECT max(attempts) AS n FROM jobs WHERE kind = 'share.render' AND status = 'running' AND payload->>'postId' = $1`, [postId])
        ).rows[0]?.n;
        const last = Number(attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
        await db.query(`UPDATE share_videos SET status = $2, error = $3 WHERE post_id = $1`, [
          postId,
          last ? 'failed' : 'queued',
          String((e as Error).message).slice(0, 300),
        ]);
        throw e;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
