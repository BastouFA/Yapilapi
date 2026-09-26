import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import heicConvert from 'heic-convert';
import sharp from 'sharp';

export type MediaKind = 'image' | 'video' | 'audio';
export interface Detected {
  mime: string;
  kind: MediaKind;
  ext: string;
}

/**
 * What a file really is, from its first bytes, whatever the browser called it.
 * Phones and browsers label files inconsistently (iPhone photos arrive as
 * HEIC, iPhone videos as QuickTime, Chrome often sends HEIC or MKV as
 * application/octet-stream), so the declared type is only used to tell audio
 * from video when the container can hold either.
 */
export function detectMedia(buf: Buffer, declared = ''): Detected | null {
  const hex = buf.subarray(0, 16).toString('hex');
  const ascii = (a: number, b: number) => buf.subarray(a, b).toString('latin1');
  const wantsAudio = declared.startsWith('audio/');

  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', kind: 'image', ext: 'jpg' };
  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', kind: 'image', ext: 'png' };
  if (ascii(0, 4) === 'GIF8') return { mime: 'image/gif', kind: 'image', ext: 'gif' };
  if (ascii(0, 2) === 'BM' && buf.length > 26) return { mime: 'image/bmp', kind: 'image', ext: 'bmp' };
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return { mime: 'image/tiff', kind: 'image', ext: 'tiff' };
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 12);
    if (form === 'WEBP') return { mime: 'image/webp', kind: 'image', ext: 'webp' };
    if (form === 'AVI ') return { mime: 'video/x-msvideo', kind: 'video', ext: 'avi' };
    if (form === 'WAVE') return { mime: 'audio/wav', kind: 'audio', ext: 'wav' };
    return null;
  }

  // ISO base media (MP4, MOV, M4A, 3GP, HEIC, AVIF): "ftyp" at byte 4, then the brand.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    const compatible = ascii(8, Math.min(buf.length, 64));
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return { mime: 'image/heic', kind: 'image', ext: 'heic' };
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', kind: 'image', ext: 'avif' };
    if (brand === 'mif1' || brand === 'msf1')
      return compatible.includes('avif') ? { mime: 'image/avif', kind: 'image', ext: 'avif' } : { mime: 'image/heif', kind: 'image', ext: 'heif' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video', ext: 'mov' };
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return { mime: 'audio/mp4', kind: 'audio', ext: 'm4a' };
    if (brand.startsWith('3g')) return wantsAudio ? { mime: 'audio/3gpp', kind: 'audio', ext: '3gp' } : { mime: 'video/3gpp', kind: 'video', ext: '3gp' };
    return wantsAudio ? { mime: 'audio/mp4', kind: 'audio', ext: 'm4a' } : { mime: 'video/mp4', kind: 'video', ext: 'mp4' };
  }
  // Older QuickTime files start straight with an atom.
  if (/^(moov|mdat|wide|free|skip|pnot)$/.test(ascii(4, 8))) return { mime: 'video/quicktime', kind: 'video', ext: 'mov' };

  // Matroska / WebM (EBML).
  if (hex.startsWith('1a45dfa3')) {
    const webm = ascii(0, Math.min(buf.length, 64)).includes('webm');
    if (wantsAudio) return { mime: 'audio/webm', kind: 'audio', ext: 'weba' };
    return webm ? { mime: 'video/webm', kind: 'video', ext: 'webm' } : { mime: 'video/x-matroska', kind: 'video', ext: 'mkv' };
  }
  if (ascii(0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio', ext: 'ogg' };
  if (ascii(0, 4) === 'fLaC') return { mime: 'audio/flac', kind: 'audio', ext: 'flac' };
  if (ascii(0, 5) === '#!AMR') return { mime: 'audio/amr', kind: 'audio', ext: 'amr' };
  if (ascii(0, 3) === 'ID3' || /^fff[bf3a2]/.test(hex)) return { mime: 'audio/mpeg', kind: 'audio', ext: 'mp3' };
  if (/^fff[19]/.test(hex)) return { mime: 'audio/aac', kind: 'audio', ext: 'aac' };
  if (hex.startsWith('000001ba') || hex.startsWith('000001b3')) return { mime: 'video/mpeg', kind: 'video', ext: 'mpg' };
  if (buf[0] === 0x47 && buf.length > 376 && buf[188] === 0x47 && buf[376] === 0x47) return { mime: 'video/mp2t', kind: 'video', ext: 'ts' };
  return null;
}

/** Photos every browser and phone shows as they are. */
const WEB_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** Audio every browser and phone plays (webm and ogg don't play on iPhones). */
const WEB_AUDIO = new Set(['audio/mpeg', 'audio/mp4']);

/**
 * Turn an upload into something every browser and phone can show, before it
 * is stored: HEIC/HEIF, AVIF, TIFF and BMP photos become JPEG (upright, no
 * location data), and audio other than MP3/M4A becomes M4A with its length
 * measured. Videos are stored as they are; processing makes a web MP4 of any
 * format ffmpeg reads (MOV, MKV, AVI, 3GP, MPEG, …).
 */
export async function toWebFormat(buf: Buffer, d: Detected): Promise<{ buf: Buffer; mime: string; ext: string; durationMs?: number }> {
  if (d.kind === 'image' && !WEB_IMAGES.has(d.mime)) {
    let source = buf;
    if (d.mime === 'image/heic' || d.mime === 'image/heif') {
      source = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.92 }));
    } else if (d.mime === 'image/bmp') {
      source = await ffmpegConvert(buf, 'bmp', 'png', ['-frames:v', '1']);
    }
    const jpeg = await sharp(source, { limitInputPixels: 100_000_000 }).rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    return { buf: jpeg, mime: 'image/jpeg', ext: 'jpg' };
  }
  if (d.kind === 'audio') {
    const needsConvert = !WEB_AUDIO.has(d.mime);
    const out = needsConvert ? await ffmpegConvert(buf, d.ext, 'm4a', ['-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart']) : buf;
    const durationMs = await audioDurationMs(out, needsConvert ? 'm4a' : d.ext).catch(() => undefined);
    return needsConvert ? { buf: out, mime: 'audio/mp4', ext: 'm4a', durationMs } : { buf, mime: d.mime, ext: d.ext, durationMs };
  }
  return { buf, mime: d.mime, ext: d.ext };
}

function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is not available'));
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(Object.assign(new Error(`ffmpeg exited ${code}`), { stderr: err }))));
  });
}

async function ffmpegConvert(buf: Buffer, inExt: string, outExt: string, args: string[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-fmt-'));
  try {
    const input = path.join(dir, `in.${inExt}`);
    const output = path.join(dir, `out.${outExt}`);
    await writeFile(input, buf);
    await ffmpeg(['-loglevel', 'error', '-y', '-i', input, ...args, output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function audioDurationMs(buf: Buffer, ext: string): Promise<number | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-dur-'));
  try {
    const input = path.join(dir, `in.${ext}`);
    await writeFile(input, buf);
    // With no output ffmpeg prints the stream info and exits non-zero; the duration is in stderr.
    const info = await ffmpeg(['-i', input]).catch((e: { stderr?: string }) => e.stderr ?? '');
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
    return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** For error messages: what people can upload. */
export const SUPPORTED_FORMATS =
  'Photos: JPEG, PNG, HEIC, HEIF, WebP, AVIF, GIF, TIFF, BMP. Videos: MP4, MOV, WebM, MKV, AVI, 3GP, MPEG. Audio: MP3, M4A, AAC, WAV, OGG, Opus, FLAC, AMR.';
