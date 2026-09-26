import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from './ffmpeg-path.ts';
import sharp, { type Sharp } from 'sharp';
import type { Pool } from 'pg';
import {
  colorMatrix,
  effectiveAdjustments,
  isIdentityMatrix,
  sharpenAmount,
  textBoxColor,
  VIGNETTE_INNER,
  vignetteAlpha,
  type ColorMatrix,
  type EditorParams,
  type TextFont,
  type TextOverlay,
} from '@yapilapi/shared';
import type { MediaStorage } from './storage.ts';
import { mediaJobHandlers, probe, run } from './media-processing.ts';

/**
 * The photo and video editor's renderer. A look (filter) and the colour adjustments are one
 * colour matrix from @yapilapi/shared, the same maths the web preview uses as a CSS filter:
 *   photos: sharp recomb with a 4×4 matrix (the offsets ride on an opaque alpha channel);
 *   videos: ffmpeg colorchannelmixer on RGBA (same trick: ra/ga/ba carry the offsets).
 * Vignette is the same radial gradient everywhere, sharpen is a light unsharp mask, and
 * text is drawn by ffmpeg with the bundled Inter and JetBrains Mono fonts (assets/fonts, SIL OFL).
 */

export interface EditDeps {
  db: Pool;
  storage: MediaStorage;
}

/** Photos are rendered up to this long edge; bigger ones are scaled down first. */
export const MAX_EDIT_EDGE = 4096;

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
/** Text is drawn by ffmpeg's drawtext from these files, for photos and videos alike, so both look the same on any server. */
export const FONTS: Record<TextFont, string> = {
  clean: path.join(FONT_DIR, 'Inter-Regular.ttf'),
  bold: path.join(FONT_DIR, 'Inter-Bold.ttf'),
  mono: path.join(FONT_DIR, 'JetBrainsMono-Regular.ttf'),
};

type Raw = { data: Buffer; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } };

// sharp runs its operations in a fixed order, not call order, so each geometric step is its own pass over raw pixels.
const toRaw = (s: Sharp) => s.raw().toBuffer({ resolveWithObject: true }) as Promise<Raw>;
const fromRaw = (r: Raw) => sharp(r.data, { raw: { width: r.info.width, height: r.info.height, channels: r.info.channels } });

/** 4×4 recombination: RGB rows with the offset in the alpha column, alpha kept as is. */
export function recombMatrix(
  cm: ColorMatrix,
): [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]] {
  const [a, b, c, d, e, f, g, h, i] = cm.m;
  return [
    [a, b, c, cm.o[0]],
    [d, e, f, cm.o[1]],
    [g, h, i, cm.o[2]],
    [0, 0, 0, 1],
  ];
}

/** Pixel crop box for a normalized crop, kept inside the picture and at least 1 pixel (even sizes for video). */
export function cropBox(crop: { x: number; y: number; w: number; h: number }, width: number, height: number, even = false) {
  const snap = (v: number) => (even ? Math.max(2, Math.floor(v / 2) * 2) : Math.max(1, Math.round(v)));
  const left = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)));
  const w = Math.min(snap(crop.w * width), width - left - (even ? (width - left) % 2 : 0));
  const h = Math.min(snap(crop.h * height), height - top - (even ? (height - top) % 2 : 0));
  return { left, top, width: w, height: h };
}

/** The vignette as an SVG the size of the picture (objectBoundingBox units make the ellipse pass through the corners). */
export function vignetteSvg(width: number, height: number, alpha: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="v" gradientUnits="objectBoundingBox" cx="0.5" cy="0.5" r="0.70710678">` +
      `<stop offset="${VIGNETTE_INNER}" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${alpha}"/></radialGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#v)"/></svg>`,
  );
}

function rgba(css: string) {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(css)!;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), alpha: Number(m[4]) };
}

/** Quote a value for an ffmpeg filter option. */
const quoteArg = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
const num = (v: number) => (Math.round(v * 10000) / 10000).toString();

/**
 * drawtext for a text overlay on a frame `width` pixels wide: centred on (x, y) and kept inside
 * the picture, like the web editor places it. The words come from a file, never the command line.
 */
export function drawtextFilter(t: TextOverlay, width: number, textFile: string): string {
  const px = Math.max(8, Math.round(t.size * width));
  let box = '';
  if (t.background) {
    const c = rgba(textBoxColor(t.color));
    const hex = [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('');
    box = `:box=1:boxcolor=0x${hex}@${c.alpha}:boxborderw=${Math.round(px * 0.25)}`;
  }
  return (
    `drawtext=fontfile=${quoteArg(FONTS[t.font])}:textfile=${quoteArg(textFile)}:expansion=none:fontsize=${px}:fontcolor=0x${t.color.slice(1)}` +
    `:x='max(0,min(w-tw,w*${num(t.x)}-tw/2))':y='max(0,min(h-th,h*${num(t.y)}-th/2))'${box}`
  );
}

/** Render an edited photo: turn, flip, crop, colour, sharpen, vignette, text. Returns a JPEG. */
export async function renderPhoto(input: Buffer, p: EditorParams): Promise<{ data: Buffer; width: number; height: number }> {
  // Upright, flattened onto white, capped in size, with an opaque alpha channel for the recombination.
  let r = await toRaw(
    sharp(input, { failOn: 'none' })
      .autoOrient()
      .resize({ width: MAX_EDIT_EDGE, height: MAX_EDIT_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .ensureAlpha(1),
  );
  if (p.rotate) r = await toRaw(fromRaw(r).rotate(p.rotate));
  if (p.flipH || p.flipV) {
    let s = fromRaw(r);
    if (p.flipH) s = s.flop();
    if (p.flipV) s = s.flip();
    r = await toRaw(s);
  }
  if (p.crop) r = await toRaw(fromRaw(r).extract(cropBox(p.crop, r.info.width, r.info.height)));
  const cm = colorMatrix(p.filter, p.adjustments);
  if (!isIdentityMatrix(cm)) r = await toRaw(fromRaw(r).recomb(recombMatrix(cm)));
  const adj = effectiveAdjustments(p.filter, p.adjustments);
  const sharpen = sharpenAmount(adj);
  if (sharpen > 0) r = await toRaw(fromRaw(r).sharpen({ sigma: 0.5 + sharpen, m1: 1, m2: 2 }));
  const { width, height } = r.info;
  const alpha = vignetteAlpha(adj);
  if (alpha > 0) r = await toRaw(fromRaw(r).composite([{ input: vignetteSvg(width, height, alpha), left: 0, top: 0 }]));
  let out = fromRaw(r).removeAlpha();
  if (p.text) {
    const text = p.text;
    const png = await withTempDir(async (dir) => {
      const input = path.join(dir, 'in.png');
      const output = path.join(dir, 'out.png');
      const textFile = path.join(dir, 'text.txt');
      await out.png({ compressionLevel: 1 }).toFile(input);
      await writeFile(textFile, text.value, 'utf8');
      await run(['-i', input, '-vf', drawtextFilter(text, width, textFile), '-frames:v', '1', '-y', output]);
      return readFile(output);
    });
    out = sharp(png);
  }
  const data = await out.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { data, width, height };
}

// ─── Video ─────────────────────────────────────────────────────────────

const clampMix = (v: number) => Math.min(2, Math.max(-2, v));

/** colorchannelmixer on RGBA: the alpha column adds the offsets (alpha is opaque in video frames). */
export function mixerFilter(cm: ColorMatrix): string {
  const [rr, rg, rb, gr, gg, gb, br, bg, bb] = cm.m.map(clampMix) as number[];
  const [ra, ga, ba] = cm.o.map(clampMix) as number[];
  const v = { rr, rg, rb, ra, gr, gg, gb, ga, br, bg, bb, ba, aa: 1 };
  return `format=rgba,colorchannelmixer=${Object.entries(v)
    .map(([k, x]) => `${k}=${num(x!)}`)
    .join(':')}`;
}

export interface VideoPlan {
  args: string[];
  /** Output length in ms. */
  durationMs: number;
}

/**
 * The ffmpeg command for an edited video. `size` is the upright frame size of the source,
 * used to size text; the filters themselves work from the frames.
 */
export function planVideo(
  p: EditorParams,
  files: { input: string; output: string; vignette?: string; textFile?: string },
  source: { durationMs: number; hasAudio: boolean; width: number; height: number },
): VideoPlan {
  const start = p.trim?.startMs ?? 0;
  const end = Math.min(p.trim?.endMs ?? source.durationMs, source.durationMs);
  const durationMs = end - start;
  const chain: string[] = [];
  let w = source.width;
  let h = source.height;
  if (p.rotate === 90) chain.push('transpose=clock');
  if (p.rotate === 270) chain.push('transpose=cclock');
  if (p.rotate === 180) chain.push('hflip', 'vflip');
  if (p.rotate === 90 || p.rotate === 270) [w, h] = [h, w];
  if (p.flipH) chain.push('hflip');
  if (p.flipV) chain.push('vflip');
  if (p.crop) {
    const c = cropBox(p.crop, w, h, true);
    chain.push(`crop=${c.width}:${c.height}:${c.left}:${c.top}`);
    w = c.width;
    h = c.height;
  }
  const cm = colorMatrix(p.filter, p.adjustments);
  if (!isIdentityMatrix(cm)) chain.push(mixerFilter(cm));
  const adj = effectiveAdjustments(p.filter, p.adjustments);
  const sharpen = sharpenAmount(adj);
  if (sharpen > 0) chain.push(`unsharp=5:5:${num(sharpen * 1.5)}:5:5:0`);
  // Even sizes for H.264.
  chain.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  const graph: string[] = [`[0:v]${chain.join(',')}[base]`];
  let last = 'base';
  const inputs = ['-ss', (start / 1000).toFixed(3), '-t', (durationMs / 1000).toFixed(3), '-i', files.input];
  if (files.vignette) {
    inputs.push('-loop', '1', '-i', files.vignette);
    graph.push(`[1:v][${last}]scale2ref[vig][ref]`, `[ref][vig]overlay=0:0:shortest=1:format=auto[vout]`);
    last = 'vout';
  }
  if (p.text && files.textFile) {
    graph.push(`[${last}]${drawtextFilter(p.text, w, files.textFile)}[tout]`);
    last = 'tout';
  }
  graph.push(`[${last}]format=yuv420p[out]`);
  const audio = !p.muted && source.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k'] : ['-an'];
  return {
    durationMs,
    args: [
      ...inputs,
      '-filter_complex',
      graph.join(';'),
      '-map',
      '[out]',
      ...audio,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-movflags',
      '+faststart',
      '-t',
      (durationMs / 1000).toFixed(3),
      '-y',
      files.output,
    ],
  };
}

/** Frame size as shown: phone videos store landscape frames with a rotation flag that ffmpeg applies when decoding. */
function uprightSize(file: string, info: { width: number | null; height: number | null }): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const { width, height } = info;
    if (!width || !height || !ffmpegPath) return resolve(null);
    // With no output file ffmpeg prints the stream info (including any display rotation) and exits non-zero.
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve({ width, height }));
    p.on('close', () =>
      resolve(/rotation of -?(90|270)\.00 degrees|rotate\s*:\s*-?(90|270)\b/.test(err) ? { width: height, height: width } : { width, height }),
    );
  });
}

/** Render an edited video to `output` (MP4). Returns the output length. */
export async function renderVideo(input: string, dir: string, output: string, p: EditorParams): Promise<{ durationMs: number }> {
  const info = await probe(input);
  if (!info.durationMs) throw new Error("We couldn't read this video's length.");
  const size = (await uprightSize(input, info)) ?? { width: 1280, height: 720 };
  const adj = effectiveAdjustments(p.filter, p.adjustments);
  const alpha = vignetteAlpha(adj);
  let vignette: string | undefined;
  if (alpha > 0) {
    // A square gradient stretched to the frame is the same bounding-box ellipse the web and photos use.
    vignette = path.join(dir, 'vignette.png');
    await sharp(vignetteSvg(512, 512, alpha))
      .png()
      .toFile(vignette);
  }
  let textFile: string | undefined;
  if (p.text) {
    textFile = path.join(dir, 'text.txt');
    await writeFile(textFile, p.text.value, 'utf8');
  }
  const plan = planVideo(p, { input, output, vignette, textFile }, { durationMs: info.durationMs, hasAudio: info.hasAudio, ...size });
  await run(plan.args);
  const out = await probe(output);
  return { durationMs: out.durationMs ?? plan.durationMs };
}

// ─── Job ───────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-editor-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Render one editor request into its result media item, then run the normal media
 * processing on it (variants, poster, MP4, HLS). The chosen cover frame replaces the
 * default poster. Failures are recorded, not retried: the same edit would fail again.
 */
export async function renderEditorJob(deps: EditDeps, renderId: string): Promise<void> {
  const { rows } = await deps.db.query(
    `SELECT r.id, r.kind, r.params, r.status, r.result_media_id, s.storage_key, s.mime
     FROM media_editor_renders r JOIN media s ON s.id = r.source_media_id WHERE r.id = $1`,
    [renderId],
  );
  const job = rows[0];
  if (!job || !['queued', 'rendering'].includes(job.status)) return;
  await deps.db.query(`UPDATE media_editor_renders SET status = 'rendering' WHERE id = $1`, [renderId]);
  const p = job.params as EditorParams;
  const resultId = job.result_media_id as string;
  try {
    if (!job.storage_key) throw new Error('The original file is no longer stored.');
    let cover: Buffer | null = null;
    if (job.kind === 'image') {
      const out = await renderPhoto(await deps.storage.read(job.storage_key), p);
      const stored = await deps.storage.put(out.data, 'jpg', 'image/jpeg');
      await deps.db.query(`UPDATE media SET url = $2, storage_key = $3, mime = 'image/jpeg', size_bytes = $4, width = $5, height = $6 WHERE id = $1`, [
        resultId,
        stored.url,
        stored.key,
        out.data.length,
        out.width,
        out.height,
      ]);
    } else {
      await withTempDir(async (dir) => {
        const input = path.join(dir, 'input');
        const output = path.join(dir, 'edit.mp4');
        await deps.storage.download(job.storage_key, input);
        const { durationMs } = await renderVideo(input, dir, output, p);
        if (p.coverMs !== undefined) {
          // The cover is picked on the original's timeline; take it from the edited video so it has the look and text.
          const at = Math.max(0, Math.min(durationMs - 50, p.coverMs - (p.trim?.startMs ?? 0)));
          const poster = path.join(dir, 'cover.jpg');
          await run(['-ss', (at / 1000).toFixed(3), '-i', output, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', poster]);
          cover = await readFile(poster);
        }
        const stored = await deps.storage.putFile(output, 'mp4', 'video/mp4');
        await deps.db.query(`UPDATE media SET url = $2, storage_key = $3, mime = 'video/mp4', size_bytes = $4, duration_ms = $5 WHERE id = $1`, [
          resultId,
          stored.url,
          stored.key,
          (await stat(output)).size,
          durationMs,
        ]);
      });
    }
    // The normal processing, run here so the cover and the finished state land after it.
    await mediaJobHandlers(deps)['media.process']({ mediaId: resultId });
    if (cover) {
      const key = (await deps.db.query(`SELECT storage_key FROM media WHERE id = $1`, [resultId])).rows[0].storage_key as string;
      const poster = await deps.storage.putKey(`${key.replace(/\.[^.]+$/, '')}_cover.jpg`, cover, 'image/jpeg');
      await deps.db.query(`UPDATE media SET poster_url = $2 WHERE id = $1`, [resultId, poster.url]);
    }
    await deps.db.query(`UPDATE media_editor_renders SET status = 'done', finished_at = now() WHERE id = $1`, [renderId]);
  } catch (err) {
    await deps.db.query(`UPDATE media_editor_renders SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
      renderId,
      `We couldn't apply your edits. ${String((err as Error).message).slice(0, 200)}`,
    ]);
    await deps.db.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [resultId]);
  }
}

export function editorJobHandlers(deps: EditDeps) {
  return {
    'media.editor': ({ renderId }: { renderId: string }) => renderEditorJob(deps, renderId),
  };
}
