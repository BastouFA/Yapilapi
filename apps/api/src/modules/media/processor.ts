import { spawn } from 'node:child_process';
import type SharpFn from 'sharp';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { newObjectKey, hasLocalPath, type StorageAdapter } from './storage.js';
import type { MediaKind } from './sniff.js';

export interface MediaVariant {
  name: string;
  key: string;
  mime: string;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  sizeBytes: number;
}

export interface ProcessJob {
  mediaId: string;
  kind: MediaKind;
  mime: string;
  storageKey: string;
  sizeBytes: number;
}

export interface ProcessResult {
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  blurhash?: string | undefined;
  variants: MediaVariant[];
  /**
   * variants    = derived renditions were created
   * metadata    = only probed (dimensions/duration); nothing derived
   * passthrough = stored exactly as uploaded (no tool available or nothing to derive)
   */
  processing: 'variants' | 'metadata' | 'passthrough';
}

/** Swappable processing step (in-process today; a worker fleet or a managed transcoder tomorrow). */
export interface MediaProcessor {
  process(job: ProcessJob, storage: StorageAdapter): Promise<ProcessResult>;
}

/** A job that is invalid media (e.g. magic bytes said mp4 but there is no video stream). Marks the media failed. */
export class MediaRejectedError extends Error {}

// ----------------------------------------------------------------------------------------------- helpers
interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  missing: boolean;
}

export function runBinary(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxStdout = 8 * 1024 * 1024,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout: Buffer.concat(out), stderr: `${err}\ntimeout`, missing: false });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen <= maxStdout) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 8000) err += d.toString();
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      done({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: e.message,
        missing: e.code === 'ENOENT',
      }),
    );
    child.on('close', (code) =>
      done({ code, stdout: Buffer.concat(out), stderr: err, missing: false }),
    );
  });
}

async function readAll(storage: StorageAdapter, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await storage.read(key))
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// ----------------------------------------------------------------------------------------------- images
type Sharp = typeof SharpFn;
let sharpModule: Promise<Sharp | null> | undefined;
/** sharp is an optional native dependency: everything degrades to passthrough when it cannot be loaded. */
export function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import('sharp').then((m) => m.default as Sharp).catch(() => null);
  return sharpModule;
}

async function processImage(job: ProcessJob, storage: StorageAdapter): Promise<ProcessResult> {
  const sharp = await loadSharp();
  if (!sharp) return { variants: [], processing: 'passthrough' };
  const src = await readAll(storage, job.storageKey);
  const animatedSource = job.mime === 'image/gif' || job.mime === 'image/webp';
  let meta;
  try {
    meta = await sharp(src, {
      failOn: 'error',
      animated: false,
      limitInputPixels: 100_000_000,
    }).metadata();
  } catch {
    throw new MediaRejectedError('Image could not be decoded');
  }
  const width = meta.width;
  const height = meta.pageHeight ?? meta.height;
  if (!width || !height) throw new MediaRejectedError('Image has no dimensions');
  const multiPage = (meta.pages ?? 1) > 1;

  // BlurHash placeholder from a tiny RGBA thumbnail.
  let blurhash: string | undefined;
  try {
    const { encode } = await import('blurhash');
    const { data, info } = await sharp(src, { animated: false, limitInputPixels: 100_000_000 })
      .rotate()
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    blurhash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
  } catch {
    /* optional */
  }

  const variants: MediaVariant[] = [];
  const make = async (name: string, longest: number, quality: number, animated: boolean) => {
    const { data, info } = await sharp(src, { animated, limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    const key = newObjectKey('v', 'webp');
    await storage.put(key, data, { contentType: 'image/webp' });
    variants.push({
      name,
      key,
      mime: 'image/webp',
      width: info.width,
      height: info.pageHeight ?? info.height,
      sizeBytes: data.length,
    });
  };
  await make('thumb', 320, 76, false);
  // A web-friendly rendition of static images that are not already small WebP. Animated sources keep the original.
  if (
    !(multiPage && animatedSource) &&
    !(job.mime === 'image/webp' && Math.max(width, height) <= 1600)
  )
    await make('webp', 1600, 80, false);
  return { width, height, blurhash, variants, processing: 'variants' };
}

// ----------------------------------------------------------------------------------------------- audio / video
const DEMUXER: Record<string, string> = {
  'video/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/quicktime': 'mov,mp4,m4a,3gp,3g2,mj2',
  'audio/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/webm': 'matroska,webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}
interface Probe {
  format?: { duration?: string };
  streams?: ProbeStream[];
}

export interface FfmpegOptions {
  ffmpegPath: string;
  ffprobePath: string;
  timeoutMs?: number;
}

class AvProcessor {
  private available: Promise<boolean> | undefined;
  constructor(private readonly o: FfmpegOptions) {}

  isAvailable(): Promise<boolean> {
    this.available ??= Promise.all([
      runBinary(this.o.ffprobePath, ['-version'], 10_000),
      runBinary(this.o.ffmpegPath, ['-version'], 10_000),
    ]).then(([a, b]) => a.code === 0 && b.code === 0);
    return this.available;
  }

  async process(job: ProcessJob, storage: StorageAdapter): Promise<ProcessResult> {
    if (!(await this.isAvailable())) return { variants: [], processing: 'passthrough' };
    const timeout = this.o.timeoutMs ?? 10 * 60_000;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'yl-media-'));
    try {
      let input: string;
      if (hasLocalPath(storage)) input = storage.localPath(job.storageKey);
      else {
        input = path.join(tmp, 'source');
        await pipeline(await storage.read(job.storageKey), createWriteStream(input));
      }
      const fmt = DEMUXER[job.mime];
      // Hardening: force the demuxer chosen from OUR sniffing and allow only the file protocol so a crafted container
      // cannot make ffmpeg open network URLs or other local files (HLS/concat playlist tricks).
      const inArgs = ['-protocol_whitelist', 'file', ...(fmt ? ['-f', fmt] : []), '-i', input];

      const probe = await runBinary(
        this.o.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...inArgs],
        timeout,
      );
      if (probe.code !== 0) throw new MediaRejectedError('Media could not be decoded');
      let info: Probe;
      try {
        info = JSON.parse(probe.stdout.toString('utf8')) as Probe;
      } catch {
        throw new MediaRejectedError('Media could not be probed');
      }
      const streams = info.streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
      const hasAudio = streams.some((s) => s.codec_type === 'audio');
      if (job.kind === 'video' && !v) throw new MediaRejectedError('No video stream found');
      if (job.kind === 'audio' && !hasAudio) throw new MediaRejectedError('No audio stream found');
      const dur = Number(info.format?.duration ?? streams.find((s) => s.duration)?.duration);
      const durationMs = Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : undefined;
      const base: ProcessResult = {
        width: v?.width,
        height: v?.height,
        durationMs,
        variants: [],
        processing: 'metadata',
      };
      if (job.kind !== 'video' || !v) return base;

      // Poster frame (JPEG), scaled to at most 720px wide.
      const poster = path.join(tmp, 'poster.jpg');
      const at = durationMs && durationMs > 2000 ? '1' : '0';
      const p = await runBinary(
        this.o.ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          at,
          ...inArgs,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(720,iw)':-2",
          '-q:v',
          '4',
          poster,
        ],
        timeout,
      );
      if (p.code === 0 && (await stat(poster).catch(() => null))?.size) {
        const key = newObjectKey('v', 'jpg');
        const size = (await stat(poster)).size;
        await storage.put(key, createReadStream(poster), { contentType: 'image/jpeg', size });
        base.variants.push({
          name: 'poster',
          key,
          mime: 'image/jpeg',
          width: Math.min(720, v.width!),
          sizeBytes: size,
        });
      }

      // 720p H.264/AAC MP4 with the moov atom up front for progressive playback. Never upscales.
      const mp4 = path.join(tmp, '720p.mp4');
      const t = await runBinary(
        this.o.ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          ...inArgs,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          "scale=-2:'min(720,ih)'",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '26',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          '-sn',
          '-dn',
          mp4,
        ],
        timeout,
      );
      if (t.code === 0) {
        const size = (await stat(mp4).catch(() => null))?.size ?? 0;
        if (size > 0) {
          const chk = await runBinary(
            this.o.ffprobePath,
            ['-v', 'error', '-print_format', 'json', '-show_streams', mp4],
            60_000,
          );
          const out =
            chk.code === 0
              ? (JSON.parse(chk.stdout.toString('utf8')) as Probe).streams?.find(
                  (s) => s.codec_type === 'video',
                )
              : undefined;
          const key = newObjectKey('v', 'mp4');
          await storage.put(key, createReadStream(mp4), { contentType: 'video/mp4', size });
          base.variants.push({
            name: '720p',
            key,
            mime: 'video/mp4',
            width: out?.width,
            height: out?.height,
            durationMs,
            sizeBytes: size,
          });
        }
      }
      // HLS is intentionally not produced: it needs a manifest + hundreds of segment objects per video and a
      // segment-aware serving route. The progressive MP4 supports Range requests, which every player handles.
      if (base.variants.length) base.processing = 'variants';
      return base;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** Default processor: sharp for images, ffprobe/ffmpeg for audio+video, passthrough for everything else. */
export class DefaultMediaProcessor implements MediaProcessor {
  private readonly av: AvProcessor;
  constructor(ffmpeg: FfmpegOptions) {
    this.av = new AvProcessor(ffmpeg);
  }
  async process(job: ProcessJob, storage: StorageAdapter): Promise<ProcessResult> {
    if (job.kind === 'image') return processImage(job, storage);
    if (job.kind === 'video' || job.kind === 'audio') return this.av.process(job, storage);
    return { variants: [], processing: 'passthrough' };
  }
}
