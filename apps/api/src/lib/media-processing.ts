import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import type { Pool } from 'pg';
import type { MediaStorage } from './storage.ts';

/** Image sizes served to clients. Metadata (including GPS) is stripped from every derivative. */
const IMAGE_SIZES = { thumb: 320, medium: 1080, large: 2048 } as const;

export interface ProcessDeps {
  db: Pool;
  storage: MediaStorage;
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

async function processImage(deps: ProcessDeps, id: string, key: string) {
  const original = await deps.storage.read(key);
  const base = key.replace(/\.[^.]+$/, '');
  const meta = await sharp(original).metadata();
  const variants: Record<string, string> = {};
  for (const [name, width] of Object.entries(IMAGE_SIZES)) {
    if (meta.width && meta.width < width && name !== 'thumb') continue;
    const out = await sharp(original).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    variants[name] = (await deps.storage.putKey(`${base}_${name}.webp`, out, 'image/webp')).url;
  }
  // A tiny blurred preview shown while the real image loads (low-bandwidth friendly).
  const tiny = await sharp(original).rotate().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
  await deps.db.query(
    `UPDATE media SET variants = $2, width = coalesce(width, $3), height = coalesce(height, $4), blurhash = $5, status = 'ready' WHERE id = $1`,
    [
      id,
      variants,
      meta.autoOrient?.width ?? meta.width ?? null,
      meta.autoOrient?.height ?? meta.height ?? null,
      `data:image/webp;base64,${tiny.toString('base64')}`,
    ],
  );
}

async function processVideo(deps: ProcessDeps, id: string, key: string) {
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
    const poster = await deps.storage.putKey(`${base}_poster.jpg`, await readFile(path.join(dir, 'poster.jpg')), 'image/jpeg');
    const mp4 = await deps.storage.putFile(path.join(dir, 'web.mp4'), 'mp4', 'video/mp4', `${base}_web.mp4`);
    let hls: string | null = null;
    for (const f of await readdir(dir)) {
      if (!/\.(m3u8|ts)$/.test(f)) continue;
      const stored = await deps.storage.putKey(
        `${base}_hls/${f}`,
        await readFile(path.join(dir, f)),
        f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      );
      if (f === 'index.m3u8') hls = stored.url;
    }
    await deps.db.query(
      `UPDATE media SET poster_url = $2, hls_url = $3, variants = jsonb_build_object('mp4', $4::text), status = 'ready',
                        duration_ms = coalesce($5, duration_ms), width = coalesce(width, $6), height = coalesce(height, $7) WHERE id = $1`,
      [id, poster.url, hls, mp4.url, info.durationMs, info.width, info.height],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function mediaJobHandlers(deps: ProcessDeps) {
  return {
    'media.process': async ({ mediaId }: { mediaId: string }) => {
      const { rows } = await deps.db.query(`SELECT id, kind, storage_key FROM media WHERE id = $1`, [mediaId]);
      const m = rows[0];
      if (!m?.storage_key) return;
      if (m.kind === 'image') await processImage(deps, m.id, m.storage_key);
      else if (m.kind === 'video') await processVideo(deps, m.id, m.storage_key);
    },
  };
}
