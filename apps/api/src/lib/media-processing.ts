import { spawn } from 'node:child_process';
import { NO_METADATA } from './media-formats.ts';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from './ffmpeg-path.ts';
import sharp from 'sharp';
import type { Pool } from 'pg';
import type { MediaStorage } from './storage.ts';
import type { RealtimeHub } from './realtime.ts';
import { inheritedVerdict, recordVerdict, worst, type MediaFrame, type MediaModerator } from './media-moderation.ts';

/** Image sizes served to clients. Metadata (including GPS) is stripped from every derivative. */
const IMAGE_SIZES = { thumb: 320, medium: 1080, large: 2048 } as const;

export interface ProcessDeps {
  db: Pool;
  storage: MediaStorage;
  /** Automated image and video checks. Without one (or with "none"), media stays "pending" and is shown normally. */
  moderator?: MediaModerator;
  /** Tells the uploader when something is blocked. */
  realtime?: RealtimeHub;
}

interface MediaRow {
  id: string;
  ownerId: string;
  kind: 'image' | 'video';
  key: string;
  filename: string | null;
}

/** Run the moderator on the frames and store its verdict. Errors propagate so the job retries. */
async function moderate(deps: ProcessDeps, m: MediaRow, frames: MediaFrame[]) {
  if (!deps.moderator || deps.moderator.name === 'none' || !frames.length) return;
  const checked = await deps.moderator.moderate(frames, { mediaId: m.id, kind: m.kind, filename: m.filename });
  // A collage keeps the verdict of the photos it was made from when that is more severe.
  const inherited = await inheritedVerdict(deps.db, m.id);
  const result =
    worst(checked.verdict, inherited) === checked.verdict
      ? checked
      : { verdict: inherited, labels: [...checked.labels, { name: 'Made from a photo marked sensitive or blocked', confidence: 100 }] };
  await recordVerdict(deps.db, deps.realtime, { id: m.id, ownerId: m.ownerId, kind: m.kind }, deps.moderator.name, result);
}

/** Evenly spaced moments to sample from a video (a quarter, half and three quarters in). */
export function sampleTimes(durationMs: number | null, count = 3): number[] {
  if (!durationMs || durationMs < 1500) return [];
  return Array.from({ length: count }, (_, i) => Math.round((durationMs * (i + 1)) / (count + 1)) / 1000);
}

export function run(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is not available'));
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', ...args], { cwd });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

export interface VideoInfo {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

/** Read duration, frame size and whether there is an audio stream (ffmpeg-static ships without ffprobe). */
export function probe(file: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is not available'));
    // With no output file ffmpeg prints the stream info and exits non-zero; that is expected.
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => {
      const d = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(err);
      const size = /Stream #[^\n]*Video:[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(err);
      resolve({
        durationMs: d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : null,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        hasAudio: /Stream #[^\n]*Audio:/.test(err),
      });
    });
  });
}

async function processImage(deps: ProcessDeps, m: MediaRow) {
  const { id, key } = m;
  const original = await deps.storage.read(key);
  const base = key.replace(/\.[^.]+$/, '');
  const meta = await sharp(original).metadata();
  const variants: Record<string, string> = {};
  // Bytes of each size, so clients on Data saver can pick one and say what loading the full photo costs.
  const bytes: Record<string, number> = { original: original.length };
  for (const [name, width] of Object.entries(IMAGE_SIZES)) {
    if (meta.width && meta.width < width && name !== 'thumb') continue;
    const out = await sharp(original).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    variants[name] = (await deps.storage.putKey(`${base}_${name}.webp`, out, 'image/webp')).url;
    bytes[name] = out.length;
  }
  // A tiny blurred preview shown while the real image loads (low-bandwidth friendly).
  const tiny = await sharp(original).rotate().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
  await deps.db.query(
    `UPDATE media SET variants = $2, width = coalesce(width, $3), height = coalesce(height, $4), blurhash = $5, variant_bytes = $6, status = 'ready' WHERE id = $1`,
    [
      id,
      variants,
      meta.autoOrient?.width ?? meta.width ?? null,
      meta.autoOrient?.height ?? meta.height ?? null,
      `data:image/webp;base64,${tiny.toString('base64')}`,
      bytes,
    ],
  );
  if (deps.moderator && deps.moderator.name !== 'none') {
    const still = await sharp(original)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    await moderate(deps, m, [{ data: still, mime: 'image/jpeg', label: 'image' }]);
  }
}

async function processVideo(deps: ProcessDeps, m: MediaRow) {
  const { id, key } = m;
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-video-'));
  try {
    const input = path.join(dir, 'input');
    await deps.storage.download(key, input);
    const base = key.replace(/\.[^.]+$/, '');
    const info = await probe(input);
    // Poster frame.
    // One second in, or the first frame of a video shorter than that (ffmpeg writes nothing, without failing, past the end).
    const posterFile = path.join(dir, 'poster.jpg');
    await run(['-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', posterFile]).catch(() => {});
    if (!(await stat(posterFile).catch(() => null))?.size) await run(['-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', posterFile]);
    // Web-safe MP4 (H.264/AAC, fast start) as the universal fallback.
    await run([
      '-i',
      input,
      '-vf',
      "scale='min(1280,iw)':-2",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      ...NO_METADATA,
      '-movflags',
      '+faststart',
      path.join(dir, 'web.mp4'),
    ]);
    // Adaptive HLS with two renditions (360p for slow networks, 720p).
    await run(
      [
        '-i',
        input,
        '-filter_complex',
        "[0:v]split=2[a][b];[a]scale=-2:360[v360];[b]scale=-2:'min(720,ih)'[v720]",
        '-map',
        '[v360]',
        '-map',
        '0:a?',
        '-map',
        '[v720]',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '24',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-g',
        '48',
        '-keyint_min',
        '48',
        '-sc_threshold',
        '0',
        ...NO_METADATA,
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        'v%v_%03d.ts',
        '-master_pl_name',
        'index.m3u8',
        '-var_stream_map',
        'v:0,a:0 v:1,a:1',
        'v%v.m3u8',
      ],
      dir,
    ).catch(async () => {
      // Videos without audio: same ladder, no audio maps.
      await run(
        [
          '-i',
          input,
          '-filter_complex',
          "[0:v]split=2[a][b];[a]scale=-2:360[v360];[b]scale=-2:'min(720,ih)'[v720]",
          '-map',
          '[v360]',
          '-map',
          '[v720]',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '24',
          '-g',
          '48',
          '-keyint_min',
          '48',
          '-sc_threshold',
          '0',
          ...NO_METADATA,
          '-f',
          'hls',
          '-hls_time',
          '4',
          '-hls_playlist_type',
          'vod',
          '-hls_segment_filename',
          'v%v_%03d.ts',
          '-master_pl_name',
          'index.m3u8',
          '-var_stream_map',
          'v:0 v:1',
          'v%v.m3u8',
        ],
        dir,
      );
    });
    // The 360p rung as a plain MP4 too (copied from the HLS segments, not encoded again): browsers without HLS play it on Data saver.
    const low = await run(['-i', 'v0.m3u8', '-c', 'copy', ...NO_METADATA, '-movflags', '+faststart', 'low.mp4'], dir).then(
      () => true,
      () => false,
    );
    const posterJpg = await readFile(path.join(dir, 'poster.jpg'));
    const poster = await deps.storage.putKey(`${base}_poster.jpg`, posterJpg, 'image/jpeg');
    // A tiny blurred preview of the poster frame, like photos have: shown while loading, and as the locked preview of a reel for subscribers.
    const tiny = await sharp(posterJpg)
      .resize({ width: 16 })
      .webp({ quality: 40 })
      .toBuffer()
      .catch(() => null);
    // A small poster for feeds on Data saver.
    const thumbWebp = await sharp(posterJpg)
      .resize({ width: IMAGE_SIZES.thumb, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer()
      .catch(() => null);
    const mp4 = await deps.storage.putFile(path.join(dir, 'web.mp4'), 'mp4', 'video/mp4', `${base}_web.mp4`);
    const variants: Record<string, string> = { mp4: mp4.url };
    const bytes: Record<string, number> = {
      original: (await stat(input)).size,
      mp4: (await stat(path.join(dir, 'web.mp4'))).size,
      poster: posterJpg.length,
    };
    if (thumbWebp) {
      variants.thumb = (await deps.storage.putKey(`${base}_thumb.webp`, thumbWebp, 'image/webp')).url;
      bytes.thumb = thumbWebp.length;
    }
    if (low) {
      variants.mp4_360 = (await deps.storage.putFile(path.join(dir, 'low.mp4'), 'mp4', 'video/mp4', `${base}_360.mp4`)).url;
      bytes.mp4_360 = (await stat(path.join(dir, 'low.mp4'))).size;
    }
    let hls: string | null = null;
    for (const f of await readdir(dir)) {
      if (!/\.(m3u8|ts)$/.test(f)) continue;
      const data = await readFile(path.join(dir, f));
      const stored = await deps.storage.putKey(`${base}_hls/${f}`, data, f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      if (f === 'index.m3u8') hls = stored.url;
      // v0 is the 360p rendition, v1 the 720p one: count what each costs to watch through.
      const rung = /^v([01])[._]/.exec(f)?.[1];
      if (rung) {
        const k = rung === '0' ? 'hls_360' : 'hls_720';
        bytes[k] = (bytes[k] ?? 0) + data.length;
      }
      if (f === 'v0.m3u8') variants.hls_360 = stored.url;
    }
    await deps.db.query(
      `UPDATE media SET poster_url = $2, hls_url = $3, variants = $4, status = 'ready',
                        duration_ms = coalesce($5, duration_ms), width = coalesce(width, $6), height = coalesce(height, $7),
                        blurhash = coalesce($8, blurhash), variant_bytes = $9 WHERE id = $1`,
      [id, poster.url, hls, variants, info.durationMs, info.width, info.height, tiny ? `data:image/webp;base64,${tiny.toString('base64')}` : null, bytes],
    );
    if (deps.moderator && deps.moderator.name !== 'none') {
      // The poster plus a few frames sampled across the video.
      const frames: MediaFrame[] = [{ data: await readFile(path.join(dir, 'poster.jpg')), mime: 'image/jpeg', label: 'poster' }];
      for (const [i, t] of sampleTimes(info.durationMs).entries()) {
        const out = path.join(dir, `frame${i}.jpg`);
        const ok = await run(['-ss', String(t), '-i', input, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', out]).then(
          () => true,
          () => false,
        );
        if (ok) frames.push({ data: await readFile(out), mime: 'image/jpeg', label: `frame@${t}s` });
      }
      await moderate(deps, m, frames);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function mediaJobHandlers(deps: ProcessDeps) {
  return {
    /** `filename` is the name the file had on the uploader's device; the dev moderator reads it. */
    'media.process': async ({ mediaId, filename }: { mediaId: string; filename?: string | null }, run?: { lastAttempt: boolean }) => {
      const { rows } = await deps.db.query(`SELECT id, owner_id, kind, storage_key FROM media WHERE id = $1 AND NOT private`, [mediaId]);
      const r = rows[0];
      if (!r?.storage_key) return;
      const m: MediaRow = { id: r.id, ownerId: r.owner_id, kind: r.kind, key: r.storage_key, filename: filename ?? null };
      try {
        if (r.kind === 'image') await processImage(deps, m);
        else if (r.kind === 'video') await processVideo(deps, m);
      } catch (e) {
        // Given up: say so, instead of leaving the apps waiting for sizes that will never come.
        if (run?.lastAttempt) await deps.db.query(`UPDATE media SET status = 'failed' WHERE id = $1 AND status <> 'failed'`, [mediaId]);
        throw e;
      }
    },
  };
}
