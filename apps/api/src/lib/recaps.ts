import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import sharp, { type OverlayOptions } from 'sharp';
import {
  RECAP_CLIP_MAX_SECONDS,
  RECAP_DAILY_LIMIT,
  RECAP_MAX_ITEMS,
  RECAP_MAX_SECONDS,
  type RecapAspect,
  type RecapCandidate,
  type RecapSource,
  type RecapStyle,
} from '@yapilapi/shared';
import ffmpegPath from './ffmpeg-path.ts';
import { notFound } from './errors.ts';
import { mediaJobHandlers, probe } from './media-processing.ts';
import type { MediaModerator } from './media-moderation.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { assertSoundUsable } from './sounds.ts';
import type { MediaStorage } from './storage.ts';
import { postUnlockedSql, postVisibleSql } from './visibility.ts';
import { chapterVisibleSql, SEALED, storyVisibleSql } from '../modules/chapters.ts';

type Q = Pool | PoolClient;

/**
 * Recap videos: a short video made from photos and clips in a memory, "On this
 * day" or one of your own chapters.
 *
 * Only media the maker can see right now can go in, checked when it's asked for
 * and again when the job renders it (anything no longer visible is left out).
 * The 'recap.render' job draws a title card, then each photo (still, with a
 * crossfade, or with a slow zoom) and each clip (up to 4 s), fades the chosen
 * sound in and out, and stores an H.264 MP4 that then goes through the normal
 * video processing (poster, web MP4, HLS, automated checks). Every file it
 * makes on the way lives in one temporary folder that is removed at the end.
 */

export const RECAP_JOB = 'recap.render';
/** Frames per second of every recap. */
export const RECAP_FPS = 30;
/** Output frame sizes: vertical 720p, or a 720 square. */
export const RECAP_SIZES: Record<RecapAspect, { width: number; height: number }> = {
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
};
/** Source files bigger than this are left out (uploads are 50 MB at most; this is a safety net). */
export const RECAP_MAX_SOURCE_BYTES = 200 * 1024 * 1024;
/** At most this many recaps waiting or rendering per person. */
export const RECAP_MAX_PENDING = 3;
/** No single ffmpeg step may take longer than this. */
const STEP_TIMEOUT_MS = 3 * 60_000;

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
/** Fonts shipped with the API (SIL OFL), so the title card looks the same on every server. */
export const RECAP_FONTS = { title: path.join(FONT_DIR, 'Inter-Bold.ttf'), subtitle: path.join(FONT_DIR, 'Inter-Regular.ttf') };

// ─── What can go in ─────────────────────────────────────────────────────

export interface SourceRef {
  source: RecapSource;
  sourceId?: string | null;
}

/** A candidate with what the renderer needs. */
export interface CandidateMedia extends RecapCandidate {
  storageKey: string;
  hasWebMp4: boolean;
  sizeBytes: number | null;
}

const adult = (v: string) => `coalesce((SELECT uv.birth_date <= current_date - interval '18 years' FROM users uv WHERE uv.id = ${v}), false)`;

/**
 * Media `md` that can be drawn into a recap: a stored photo or video that finished
 * processing, isn't private or removed, passed the automated checks (sensitive
 * ones only for adults) and isn't itself a recap.
 */
const mediaOkSql = (v: string) => `(md.kind IN ('image', 'video') AND md.status = 'ready' AND md.deleted_at IS NULL AND NOT md.private
  AND md.storage_key IS NOT NULL AND md.moderation <> 'blocked' AND (md.moderation <> 'sensitive' OR ${adult(v)})
  AND NOT EXISTS (SELECT 1 FROM recaps rx WHERE rx.media_id = md.id))`;

const MEDIA_COLS = `md.id AS media_id, md.kind, md.variants, md.url, md.poster_url, md.duration_ms, md.owner_id, md.storage_key, md.size_bytes`;
const POSTS_FROM = `posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
  JOIN post_media pm ON pm.post_id = p.id JOIN media md ON md.id = pm.media_id`;
const POST_COLS = `${MEDIA_COLS}, 'post' AS from_type, p.id AS from_id, p.like_count AS likes, p.created_at AS taken_at, pm.position AS pos`;
const STORY_COLS = `${MEDIA_COLS}, 'story' AS from_type, m.id AS from_id, 0 AS likes, m.created_at AS taken_at, 0 AS pos`;
/** Candidates considered per source. */
const CANDIDATES_MAX = 300;

function toCandidate(r: Record<string, any>, viewer: string): CandidateMedia {
  const variants = (r.variants ?? {}) as Record<string, string>;
  return {
    mediaId: r.media_id,
    kind: r.kind,
    thumbUrl: r.kind === 'video' ? (r.poster_url ?? null) : (variants.thumb ?? variants.medium ?? r.url ?? null),
    durationMs: r.duration_ms ?? null,
    likes: Number(r.likes ?? 0),
    takenAt: new Date(r.taken_at).toISOString(),
    from: r.from_type,
    fromId: r.from_id,
    mine: r.owner_id === viewer,
    storageKey: r.storage_key,
    hasWebMp4: !!variants.mp4,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  };
}

/**
 * Everything `viewer` may put in a recap from a source, oldest first, each photo or
 * video once. Throws "not found" when the source itself isn't theirs to use.
 */
export async function recapCandidates(db: Q, viewer: string, ref: SourceRef): Promise<{ title: string; items: CandidateMedia[] }> {
  let title: string;
  const queries: [string, unknown[]][] = [];
  if (ref.source === 'memory') {
    // Your memories, and ones shared with you; items are checked against you, not the owner.
    const m = (
      await db.query(
        `SELECT m.id, m.title, m.owner_id FROM memories m
         WHERE m.id = $2 AND (m.owner_id = $1 OR (m.visibility = 'selected' AND EXISTS (SELECT 1 FROM memory_shares s WHERE s.memory_id = m.id AND s.user_id = $1)))`,
        [viewer, ref.sourceId],
      )
    ).rows[0];
    if (!m) throw notFound('Memory');
    title = m.title;
    queries.push(
      [
        `SELECT ${POST_COLS} FROM ${POSTS_FROM} JOIN memory_items mi ON mi.item_id = p.id AND mi.item_type = 'post'
         WHERE mi.memory_id = $2 AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')} AND ${mediaOkSql('$1')}
         ORDER BY p.created_at DESC LIMIT ${CANDIDATES_MAX}`,
        [viewer, m.id],
      ],
      [
        // Stories in a memory are the memory owner's own, shown to the people it's shared with.
        `SELECT ${STORY_COLS} FROM memory_items mi JOIN moments m ON m.id = mi.item_id JOIN users au ON au.id = m.author_id JOIN media md ON md.id = m.media_id
         WHERE mi.memory_id = $2 AND mi.item_type = 'moment' AND m.author_id = $3 AND m.deleted_at IS NULL AND au.status = 'active' AND ${mediaOkSql('$1')}
         ORDER BY m.created_at DESC LIMIT ${CANDIDATES_MAX}`,
        [viewer, m.id, m.owner_id],
      ],
    );
  } else if (ref.source === 'chapter') {
    // Only your own chapters, once they're open.
    const ch = (
      await db.query(
        `SELECT ch.id, ch.title FROM chapters ch JOIN users ou ON ou.id = ch.owner_id JOIN profiles op ON op.user_id = ch.owner_id
         WHERE ch.id = $2 AND ch.owner_id = $1 AND ${chapterVisibleSql('$1')} AND NOT ${SEALED}`,
        [viewer, ref.sourceId],
      )
    ).rows[0];
    if (!ch) throw notFound('Chapter');
    title = ch.title;
    queries.push([
      `SELECT ${STORY_COLS} FROM chapters ch JOIN chapter_items ci ON ci.chapter_id = ch.id JOIN moments m ON m.id = ci.moment_id
         JOIN users au ON au.id = m.author_id JOIN media md ON md.id = m.media_id
       WHERE ch.id = $2 AND ${storyVisibleSql('$1')} AND ${mediaOkSql('$1')}
       ORDER BY m.created_at DESC LIMIT ${CANDIDATES_MAX}`,
      [viewer, ch.id],
    ]);
  } else {
    // Your own posts and stories from this day in earlier years.
    title = 'On this day';
    const sameDay = (col: string) =>
      `extract(month FROM ${col}) = extract(month FROM now()) AND extract(day FROM ${col}) = extract(day FROM now()) AND ${col} < date_trunc('year', now())`;
    queries.push(
      [
        `SELECT ${POST_COLS} FROM ${POSTS_FROM}
         WHERE p.author_id = $1 AND p.deleted_at IS NULL AND p.status = 'published' AND ${sameDay('p.created_at')} AND ${mediaOkSql('$1')}
         ORDER BY p.created_at DESC LIMIT ${CANDIDATES_MAX}`,
        [viewer],
      ],
      [
        `SELECT ${STORY_COLS} FROM moments m JOIN media md ON md.id = m.media_id
         WHERE m.author_id = $1 AND m.deleted_at IS NULL AND ${sameDay('m.created_at')} AND ${mediaOkSql('$1')}
         ORDER BY m.created_at DESC LIMIT ${CANDIDATES_MAX}`,
        [viewer],
      ],
    );
  }
  const rows = (await Promise.all(queries.map(([sql, params]) => db.query(sql, params)))).flatMap((r) => r.rows);
  rows.sort((a, b) => new Date(a.taken_at).getTime() - new Date(b.taken_at).getTime() || a.pos - b.pos);
  const seen = new Set<string>();
  const items: CandidateMedia[] = [];
  for (const r of rows) {
    if (seen.has(r.media_id)) continue;
    seen.add(r.media_id);
    items.push(toCandidate(r, viewer));
  }
  return { title, items: items.slice(0, CANDIDATES_MAX) };
}

/**
 * The suggested pick: the best-liked first, one per post or story before a second
 * from any of them, photos before more than half the pick is videos, then put back
 * in the order they happened.
 */
export function preselect(items: RecapCandidate[], max = RECAP_MAX_ITEMS): string[] {
  const ranked = [...items].sort((a, b) => b.likes - a.likes || a.takenAt.localeCompare(b.takenAt));
  const picked = new Set<string>();
  const perSource = new Map<string, number>();
  let videos = 0;
  const videoCap = Math.max(1, Math.floor(max / 2));
  for (let round = 0; picked.size < Math.min(max, items.length); round++) {
    let added = false;
    for (const c of ranked) {
      if (picked.size >= max) break;
      if (picked.has(c.mediaId)) continue;
      const key = `${c.from}:${c.fromId}`;
      if ((perSource.get(key) ?? 0) > round) continue;
      // Past the first rounds, videos no longer count against their cap: better a video than nothing.
      if (c.kind === 'video' && videos >= videoCap && round < 3) continue;
      picked.add(c.mediaId);
      perSource.set(key, (perSource.get(key) ?? 0) + 1);
      if (c.kind === 'video') videos++;
      added = true;
    }
    if (!added && round >= 3) break;
  }
  const order = new Map(items.map((c, i) => [c.mediaId, i]));
  return [...picked].sort((a, b) => order.get(a)! - order.get(b)!);
}

/** Recaps a person can still start today: failed ones don't count, deleted ones do. */
export async function recapsLeftToday(db: Q, userId: string): Promise<number> {
  const n = (
    await db.query(`SELECT count(*)::int AS n FROM recaps WHERE owner_id = $1 AND created_at > now() - interval '1 day' AND status <> 'failed'`, [userId])
  ).rows[0].n as number;
  return Math.max(0, RECAP_DAILY_LIMIT - n);
}

// ─── Planning ───────────────────────────────────────────────────────────

/** How each style paces things, in seconds. `transition` is the crossfade between two segments (0: straight cuts). */
export const RECAP_STYLE_TIMING: Record<RecapStyle, { title: number; image: number; clip: number; transition: number; minShown: number }> = {
  // Slow crossfades between still photos.
  calm: { title: 2.5, image: 3.5, clip: RECAP_CLIP_MAX_SECONDS, transition: 1, minShown: 1.2 },
  // Straight cuts on the beat (120 bpm: a photo every two beats, clips cut to four).
  quick: { title: 1.5, image: 1, clip: 2, transition: 0, minShown: 0.5 },
  // A slow zoom or pan on every photo, with short dissolves.
  film: { title: 2.5, image: 3, clip: RECAP_CLIP_MAX_SECONDS, transition: 0.5, minShown: 1 },
};

export interface PlannedSegment {
  kind: 'title' | 'image' | 'video';
  /** Index into the items given to planRecap (-1 for the title card). */
  item: number;
  /** Length of the segment in frames, including its crossfade into the next. */
  frames: number;
  /** Where a clip starts, in seconds. */
  clipStart: number;
}

export interface RecapPlan {
  width: number;
  height: number;
  transitionFrames: number;
  segments: PlannedSegment[];
  totalFrames: number;
  totalSeconds: number;
}

/**
 * Lay out a recap: the title card, then each item for its style's time (clips up to
 * their own length), crossfades overlapping neighbours. Longer than the limit (60 s,
 * or the chosen length), everything is shortened evenly; when that would make items
 * too short to see, the last ones are left out.
 */
export function planRecap(
  items: { kind: 'image' | 'video'; durationMs: number | null }[],
  style: RecapStyle,
  aspect: RecapAspect,
  maxSeconds?: number | null,
): RecapPlan {
  const s = RECAP_STYLE_TIMING[style];
  const { width, height } = RECAP_SIZES[aspect];
  const limit = Math.min(RECAP_MAX_SECONDS, maxSeconds ?? RECAP_MAX_SECONDS);
  const T = s.transition;
  type Seg = { kind: PlannedSegment['kind']; item: number; seconds: number; clipLength: number };
  const all: Seg[] = [];
  items.forEach((it, i) => {
    if (it.kind === 'image') all.push({ kind: 'image', item: i, seconds: s.image, clipLength: 0 });
    else {
      const len = it.durationMs ? it.durationMs / 1000 : s.clip;
      const seconds = Math.min(s.clip, len);
      // Clips too short to show through a crossfade are left out.
      if (seconds >= T + Math.min(s.minShown, 0.5)) all.push({ kind: 'video', item: i, seconds, clipLength: len });
    }
  });
  const total = (segs: Seg[]) => segs.reduce((a, g) => a + g.seconds, 0) - (segs.length - 1) * T;
  let segs: Seg[] = [{ kind: 'title', item: -1, seconds: s.title, clipLength: 0 }, ...all];
  let scale = 1;
  if (total(segs) > limit) {
    for (;;) {
      // Shorten everything evenly beyond the crossfade: T + (d - T) * f each, so the total is T + f * Σ(d - T).
      const spare = segs.reduce((a, g) => a + (g.seconds - T), 0);
      scale = Math.max(0, (limit - T) / spare);
      const shortest = Math.min(...segs.map((g) => (g.seconds - T) * scale));
      if (shortest >= s.minShown || segs.length <= 2) break;
      segs = segs.slice(0, -1);
    }
  }
  const transitionFrames = Math.round(T * RECAP_FPS);
  const segments: PlannedSegment[] = segs.map((g) => {
    const seconds = T + (g.seconds - T) * scale;
    const frames = Math.max(transitionFrames + 2, Math.round(seconds * RECAP_FPS));
    // A clip plays from the middle of the part it has room for.
    const clipStart = g.kind === 'video' ? Math.max(0, (g.clipLength - frames / RECAP_FPS) / 2) : 0;
    return { kind: g.kind, item: g.item, frames, clipStart: Math.round(clipStart * 1000) / 1000 };
  });
  const totalFrames = segments.reduce((a, g) => a + g.frames, 0) - (segments.length - 1) * transitionFrames;
  return { width, height, transitionFrames, segments, totalFrames, totalSeconds: totalFrames / RECAP_FPS };
}

// ─── Rendering ──────────────────────────────────────────────────────────

/** Run ffmpeg with a time limit. */
function ff(args: string[], cwd?: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is not available'));
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { cwd });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? 'ffmpeg took too long' : `ffmpeg exited ${code}: ${err.slice(-300)}`));
    });
  });
}

let drawtextCheck: Promise<boolean> | null = null;
/** Whether this ffmpeg has the drawtext filter (the Linux ffmpeg-static build does not). */
export function hasDrawtext(): Promise<boolean> {
  drawtextCheck ??= new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const p = spawn(ffmpegPath as unknown as string, ['-hide_banner', '-filters']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(/\sdrawtext\s/.test(out)));
  });
  return drawtextCheck;
}

/** Break a title into at most `maxLines` lines of about `perLine` characters (long words are split). */
export function wrapTitle(title: string, perLine: number, maxLines = 3): string[] {
  const words = title
    .trim()
    .split(/\s+/)
    .flatMap((w) => (w.length > perLine ? (w.match(new RegExp(`.{1,${perLine}}`, 'gu')) ?? [w]) : [w]));
  const lines: string[] = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${w}`.length <= perLine) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, Math.max(1, perLine - 1))}…`;
    return kept;
  }
  return lines;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Title card layout: sizes and the lines, for a frame `width` wide. */
function titleLayout(width: number, height: number, title: string) {
  let size = Math.round(width * 0.075);
  let lines = wrapTitle(title, Math.floor((width * 0.84) / (size * 0.56)), 4);
  if (lines.length > 2) {
    size = Math.round(size * 0.8);
    lines = wrapTitle(title, Math.floor((width * 0.84) / (size * 0.56)), 4);
  }
  const lineHeight = Math.round(size * 1.25);
  const subSize = Math.round(size * 0.5);
  const block = lines.length * lineHeight + subSize * 2;
  const top = Math.round((height - block) / 2);
  return { size, lines, lineHeight, subSize, top, subY: top + lines.length * lineHeight + Math.round(subSize * 0.8) };
}

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The title card background: the first photo blurred and darkened, or the brand's dark gradient. */
async function titleBackground(out: string, width: number, height: number, firstImage: string | null) {
  if (firstImage) {
    try {
      await sharp(firstImage, { failOn: 'none' })
        .resize(Math.round(width / 8), Math.round(height / 8), { fit: 'cover' })
        .blur(10)
        .modulate({ brightness: 0.45 })
        .resize(width, height)
        .jpeg({ quality: 88 })
        .toFile(out);
      return;
    } catch {
      // Fall through to the gradient.
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E1020"/><stop offset="1" stop-color="#5A1024"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(out);
}

/**
 * The title card drawn with sharp (Pango, with the bundled fonts): used when this
 * ffmpeg has no drawtext, or drawtext fails. Writes a finished picture to `out`.
 */
export async function titleWithSharp(bg: string, out: string, width: number, height: number, title: string, subtitle: string | null) {
  const l = titleLayout(width, height, title);
  const layers: OverlayOptions[] = [];
  const text = async (markup: string, fontfile: string, font: string, size: number) =>
    sharp({ text: { text: markup, fontfile, font: `${font} ${size}`, width: Math.round(width * 0.88), align: 'centre', dpi: 72, rgba: true } })
      .png()
      .toBuffer({ resolveWithObject: true });
  try {
    const t = await text(`<span foreground="white">${escapeMarkup(l.lines.join('\n'))}</span>`, RECAP_FONTS.title, 'Inter Bold', l.size);
    layers.push({ input: t.data, left: Math.max(0, Math.round((width - t.info.width) / 2)), top: Math.max(0, l.top) });
    if (subtitle) {
      const s = await text(`<span foreground="#FFFFFFBF">${escapeMarkup(subtitle)}</span>`, RECAP_FONTS.subtitle, 'Inter', l.subSize);
      layers.push({ input: s.data, left: Math.max(0, Math.round((width - s.info.width) / 2)), top: Math.min(height - s.info.height, l.subY) });
    }
  } catch {
    // No text rendering at all: the card is the background alone, which still opens the video calmly.
  }
  await sharp(bg).composite(layers).jpeg({ quality: 90 }).toFile(out);
}

const encodeSegment = (frames: number, out: string) => [
  '-frames:v',
  String(frames),
  '-r',
  String(RECAP_FPS),
  '-an',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-y',
  out,
];

/** The title card segment: drawtext when this ffmpeg has it, else a picture drawn with sharp. */
async function renderTitle(dir: string, out: string, plan: RecapPlan, frames: number, title: string, subtitle: string | null, firstImage: string | null) {
  const { width, height } = plan;
  await titleBackground(path.join(dir, 'title-bg.jpg'), width, height, firstImage);
  if (await hasDrawtext()) {
    try {
      const l = titleLayout(width, height, title);
      // Fonts and words go through files next to the command, so no character in a title can break the filter.
      await copyFile(RECAP_FONTS.title, path.join(dir, 'title.ttf'));
      await copyFile(RECAP_FONTS.subtitle, path.join(dir, 'subtitle.ttf'));
      const fade = `alpha='min(1,t/0.6)'`;
      const filters: string[] = [];
      for (const [i, line] of l.lines.entries()) {
        await writeFile(path.join(dir, `title${i}.txt`), line, 'utf8');
        filters.push(
          `drawtext=fontfile=title.ttf:textfile=title${i}.txt:expansion=none:fontsize=${l.size}:fontcolor=white:x=(w-tw)/2:y=${l.top + i * l.lineHeight}:${fade}`,
        );
      }
      if (subtitle) {
        await writeFile(path.join(dir, 'subtitle.txt'), subtitle, 'utf8');
        filters.push(
          `drawtext=fontfile=subtitle.ttf:textfile=subtitle.txt:expansion=none:fontsize=${l.subSize}:fontcolor=white@0.75:x=(w-tw)/2:y=${l.subY}:${fade}`,
        );
      }
      await ff(
        [
          '-loop',
          '1',
          '-framerate',
          String(RECAP_FPS),
          '-i',
          'title-bg.jpg',
          '-vf',
          `${filters.join(',')},setsar=1,format=yuv420p`,
          ...encodeSegment(frames, out),
        ],
        dir,
      );
      return;
    } catch {
      // Fall back to sharp below.
    }
  }
  await titleWithSharp(path.join(dir, 'title-bg.jpg'), path.join(dir, 'title.jpg'), width, height, title, subtitle);
  await ff(['-loop', '1', '-framerate', String(RECAP_FPS), '-i', 'title.jpg', '-vf', 'setsar=1,format=yuv420p', ...encodeSegment(frames, out)], dir);
}

/** Slow zooms and pans for the Film style, taking turns. `F` is the segment's frame count. */
function kenBurns(i: number, frames: number, width: number, height: number): string {
  const moves = [
    `z='1+0.14*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.14-0.14*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.12':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
    `z='1.12':x='(iw-iw/zoom)*(1-on/${frames})':y='(ih-ih/zoom)/2'`,
  ];
  return `zoompan=${moves[i % moves.length]}:d=${frames}:s=${width}x${height}:fps=${RECAP_FPS}`;
}

async function renderImage(src: string, dir: string, out: string, plan: RecapPlan, seg: PlannedSegment, style: RecapStyle, index: number) {
  const { width, height } = plan;
  const film = style === 'film';
  // Resized once with sharp (upright, covering the frame); Film gets room to move.
  const prepared = path.join(dir, `img${index}.jpg`);
  const w = film ? even(width * 1.5) : width;
  const h = film ? even(height * 1.5) : height;
  await sharp(src, { failOn: 'none', limitInputPixels: 100_000_000 })
    .rotate()
    .resize(w, h, { fit: 'cover' })
    .flatten({ background: '#000000' })
    .jpeg({ quality: 92 })
    .toFile(prepared);
  if (film) await ff(['-i', prepared, '-vf', `${kenBurns(index, seg.frames, width, height)},setsar=1,format=yuv420p`, ...encodeSegment(seg.frames, out)], dir);
  else await ff(['-loop', '1', '-framerate', String(RECAP_FPS), '-i', prepared, '-vf', 'setsar=1,format=yuv420p', ...encodeSegment(seg.frames, out)], dir);
}

async function renderClip(src: string, dir: string, out: string, plan: RecapPlan, seg: PlannedSegment) {
  const { width, height } = plan;
  const seconds = (seg.frames / RECAP_FPS).toFixed(3);
  await ff(
    [
      '-ss',
      seg.clipStart.toFixed(3),
      '-t',
      seconds,
      '-i',
      src,
      '-vf',
      // Cover the frame, and hold the last picture if the clip ends early.
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${RECAP_FPS},tpad=stop_mode=clone:stop_duration=${seconds},setsar=1,format=yuv420p`,
      ...encodeSegment(seg.frames, out),
    ],
    dir,
  );
}

export interface RenderInput {
  title: string;
  subtitle: string | null;
  style: RecapStyle;
  plan: RecapPlan;
  /** Local files for the planned items, by item index. */
  files: Map<number, string>;
  kinds: ('image' | 'video')[];
  /** A local file whose audio is the sound, or null for none. */
  sound: string | null;
}

/**
 * Render a recap to `output` (H.264/AAC MP4, fast start) and a poster picture to
 * `poster`. Each segment is rendered on its own, then joined with crossfades or
 * cuts, with the sound faded in and out over the whole length.
 */
export async function renderRecap(dir: string, input: RenderInput, output: string, poster: string): Promise<{ durationMs: number }> {
  const { plan, style } = input;
  const segFiles: string[] = [];
  const firstImage = [...input.files.entries()].find(([i]) => input.kinds[i] === 'image')?.[1] ?? null;
  for (const [n, seg] of plan.segments.entries()) {
    const out = path.join(dir, `seg${n}.mp4`);
    if (seg.kind === 'title') await renderTitle(dir, out, plan, seg.frames, input.title, input.subtitle, firstImage);
    else if (seg.kind === 'image') await renderImage(input.files.get(seg.item)!, dir, out, plan, seg, style, n);
    else await renderClip(input.files.get(seg.item)!, dir, out, plan, seg);
    segFiles.push(out);
  }
  const total = plan.totalSeconds.toFixed(3);
  const args: string[] = [];
  for (const f of segFiles) args.push('-i', f);
  const graph: string[] = [];
  if (plan.transitionFrames === 0 || segFiles.length === 1) {
    graph.push(`${segFiles.map((_, i) => `[${i}:v]`).join('')}concat=n=${segFiles.length}:v=1:a=0,format=yuv420p[v]`);
  } else {
    const T = plan.transitionFrames / RECAP_FPS;
    let last = '0:v';
    let elapsed = plan.segments[0]!.frames;
    for (let k = 1; k < segFiles.length; k++) {
      const offset = (elapsed - k * plan.transitionFrames) / RECAP_FPS;
      const label = k === segFiles.length - 1 ? 'xf' : `x${k}`;
      graph.push(`[${last}][${k}:v]xfade=transition=fade:duration=${T.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`);
      last = label;
      elapsed += plan.segments[k]!.frames;
    }
    graph.push(`[xf]format=yuv420p[v]`);
  }
  let audio = false;
  if (input.sound && (await probe(input.sound).catch(() => null))?.hasAudio) {
    audio = true;
    const idx = segFiles.length;
    args.push('-stream_loop', '-1', '-i', input.sound);
    const fadeIn = Math.min(1, plan.totalSeconds / 4);
    const fadeOut = Math.min(1.5, plan.totalSeconds / 3);
    graph.push(
      `[${idx}:a]atrim=0:${total},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,` +
        `afade=t=in:st=0:d=${fadeIn.toFixed(2)},afade=t=out:st=${(plan.totalSeconds - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(2)}[a]`,
    );
  }
  await ff(
    [
      ...args,
      '-filter_complex',
      graph.join(';'),
      '-map',
      '[v]',
      ...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(RECAP_FPS),
      '-movflags',
      '+faststart',
      '-t',
      total,
      '-y',
      output,
    ],
    dir,
    STEP_TIMEOUT_MS * 2,
  );
  // The poster: just after the title card, on the first photo or clip.
  const at = Math.min(plan.totalSeconds - 0.05, plan.segments[0]!.frames / RECAP_FPS + 0.2);
  await ff(['-ss', Math.max(0, at).toFixed(3), '-i', output, '-frames:v', '1', '-q:v', '3', '-y', poster], dir);
  const info = await probe(output);
  return { durationMs: info.durationMs ?? Math.round(plan.totalSeconds * 1000) };
}

// ─── The job ────────────────────────────────────────────────────────────

export interface RecapDeps {
  db: Pool;
  storage: MediaStorage;
  realtime: RealtimeHub;
  moderator?: MediaModerator;
}

/** The storage key of a video's processed web MP4, when it has one. */
const webMp4Key = (key: string) => `${key.replace(/\.[^.]+$/, '')}_web.mp4`;

/** Copy a stored video, preferring its processed web MP4 (smaller, and a format ffmpeg always reads). */
async function downloadVideo(storage: MediaStorage, key: string, hasWeb: boolean, file: string) {
  if (hasWeb) {
    try {
      await storage.download(webMp4Key(key), file);
      return;
    } catch {
      // Fall back to the upload.
    }
  }
  await storage.download(key, file);
}

/** "2019", or "2019 – 2024": the years the recap spans. */
export function yearSpan(dates: string[]): string | null {
  const years = dates.map((d) => new Date(d).getUTCFullYear()).filter((y) => Number.isFinite(y));
  if (!years.length) return null;
  const lo = Math.min(...years);
  const hi = Math.max(...years);
  return lo === hi ? String(lo) : `${lo} – ${hi}`;
}

class RecapFailure extends Error {}

/** Every file a stored video has: the upload, its web MP4, posters and HLS playlist and segments. */
export function recapStoredKeys(key: string, durationMs: number | null): string[] {
  const base = key.replace(/\.[^.]+$/, '');
  const keys = [key, `${base}_web.mp4`, `${base}_poster.jpg`, `${base}_recap.jpg`, `${base}_hls/index.m3u8`, `${base}_hls/v0.m3u8`, `${base}_hls/v1.m3u8`];
  // Four-second HLS segments for at most a minute, in two renditions.
  const segments = Math.ceil(Math.max(durationMs ?? 0, RECAP_MAX_SECONDS * 1000) / 4000) + 2;
  for (let v = 0; v < 2; v++) for (let i = 0; i < segments; i++) keys.push(`${base}_hls/v${v}_${String(i).padStart(3, '0')}.ts`);
  return keys;
}

/** Delete a recap video's files and media row, unless a post, story or message uses it. Returns whether it was removed. */
export async function removeRecapMedia(deps: Pick<RecapDeps, 'db' | 'storage'>, mediaId: string): Promise<boolean> {
  const { rows } = await deps.db.query(
    `SELECT m.id, m.storage_key, m.duration_ms FROM media m
     WHERE m.id = $1
       AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.deleted_at IS NULL AND x.attachments @> jsonb_build_array(jsonb_build_object('mediaId', m.id::text)))`,
    [mediaId],
  );
  const m = rows[0];
  if (!m) return false;
  if (m.storage_key) for (const key of recapStoredKeys(m.storage_key, m.duration_ms)) await deps.storage.remove?.(key).catch(() => {});
  await deps.db.query(`UPDATE recaps SET media_id = NULL WHERE media_id = $1`, [mediaId]);
  await deps.db.query(`DELETE FROM media WHERE id = $1`, [mediaId]);
  return true;
}

/**
 * Render one recap. Everything is checked again first: the source must still be
 * the maker's to use, each item must still be visible to them (others are left
 * out), and the sound must still be usable (else it's left out). Failures are
 * recorded and the maker is told; they aren't retried, since the same recap
 * would fail again.
 */
export async function renderRecapJob(deps: RecapDeps, recapId: string): Promise<void> {
  const { db, storage } = deps;
  const r = (await db.query(`SELECT * FROM recaps WHERE id = $1 AND deleted_at IS NULL AND status IN ('queued', 'rendering')`, [recapId])).rows[0];
  if (!r) return;
  await db.query(`UPDATE recaps SET status = 'rendering', error = NULL WHERE id = $1`, [recapId]);
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-recap-'));
  let mediaId: string | null = null;
  try {
    let candidates: CandidateMedia[];
    try {
      candidates = (await recapCandidates(db, r.owner_id, { source: r.source_type, sourceId: r.source_id })).items;
    } catch {
      throw new RecapFailure("This memory or chapter isn't available to you any more.");
    }
    const byId = new Map(candidates.map((c) => [c.mediaId, c]));
    const chosen = (r.items as { mediaId: string }[])
      .map((it) => byId.get(it.mediaId))
      .filter((c): c is CandidateMedia => !!c && (c.sizeBytes == null || c.sizeBytes <= RECAP_MAX_SOURCE_BYTES))
      .slice(0, RECAP_MAX_ITEMS);
    if (!chosen.length) throw new RecapFailure('None of the photos or videos you chose are available to you any more.');

    // Copy each file here; one that can't be read is left out.
    const files = new Map<number, string>();
    for (const [i, c] of chosen.entries()) {
      const file = path.join(dir, `src${i}`);
      try {
        if (c.kind === 'video') await downloadVideo(storage, c.storageKey, c.hasWebMp4, file);
        else await storage.download(c.storageKey, file);
        files.set(i, file);
      } catch {
        // Left out.
      }
    }
    const usable = chosen.filter((_, i) => files.has(i));
    if (!usable.length) throw new RecapFailure("We couldn't read the photos or videos you chose. Try again later.");
    const usableFiles = new Map<number, string>();
    let k = 0;
    for (const [i] of chosen.entries()) if (files.has(i)) usableFiles.set(k++, files.get(i)!);

    let sound: string | null = null;
    if (r.sound_id) {
      try {
        await assertSoundUsable(db, r.sound_id, r.owner_id);
        const s = (
          await db.query(
            `SELECT md.storage_key, md.variants FROM sounds s JOIN media md ON md.id = s.media_id WHERE s.id = $1 AND md.storage_key IS NOT NULL`,
            [r.sound_id],
          )
        ).rows[0];
        if (s) {
          sound = path.join(dir, 'sound');
          await downloadVideo(storage, s.storage_key, !!s.variants?.mp4, sound);
        }
      } catch {
        sound = null;
      }
      // A sound that can't be used any more is left out, and the recap says so by having none.
      if (!sound) await db.query(`UPDATE recaps SET sound_id = NULL WHERE id = $1`, [recapId]);
    }

    const plan = planRecap(
      usable.map((c) => ({ kind: c.kind, durationMs: c.durationMs })),
      r.style,
      r.aspect,
      r.length_seconds,
    );
    const used = plan.segments.filter((g) => g.item >= 0).map((g) => usable[g.item]!);
    const output = path.join(dir, 'recap.mp4');
    const posterFile = path.join(dir, 'poster.jpg');
    const subtitle = yearSpan(used.map((c) => c.takenAt));
    let durationMs: number;
    try {
      ({ durationMs } = await renderRecap(
        dir,
        {
          title: r.title,
          subtitle,
          style: r.style,
          plan,
          files: usableFiles,
          kinds: usable.map((c) => c.kind),
          sound,
        },
        output,
        posterFile,
      ));
    } catch (e) {
      throw new RecapFailure(
        `We couldn't make this recap. Try again with fewer or different photos and videos. (${String((e as Error).message).slice(0, 120)})`,
      );
    }

    // Stored like any upload, then processed like any video.
    const size = (await stat(output)).size;
    const stored = await storage.putFile(output, 'mp4', 'video/mp4');
    mediaId = (
      await db.query<{ id: string }>(
        `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, size_bytes, duration_ms, width, height, alt_text)
         VALUES ($1, 'video', $2, 'video/mp4', 'processing', $3, $4, $5, $6, $7, $8) RETURNING id`,
        [r.owner_id, stored.url, stored.key, size, durationMs, plan.width, plan.height, `Recap video: ${r.title}`.slice(0, 500)],
      )
    ).rows[0]!.id;
    await mediaJobHandlers({ db, storage, moderator: deps.moderator, realtime: deps.realtime })['media.process']({ mediaId });
    const poster = await storage.putKey(
      `${stored.key.replace(/\.[^.]+$/, '')}_recap.jpg`,
      await sharp(posterFile).jpeg({ quality: 85 }).toBuffer(),
      'image/jpeg',
    );
    await db.query(`UPDATE media SET poster_url = $2 WHERE id = $1`, [mediaId, poster.url]);
    const done = await db.query(
      `UPDATE recaps SET status = 'ready', media_id = $2, duration_ms = $3, used_media_ids = $4::uuid[], finished_at = now(), error = NULL
       WHERE id = $1 AND deleted_at IS NULL`,
      [recapId, mediaId, durationMs, used.map((c) => c.mediaId)],
    );
    if (!done.rowCount) {
      // Deleted while it was rendering: nothing to keep.
      await removeRecapMedia(deps, mediaId);
      return;
    }
    await notify(db, deps.realtime, {
      userId: r.owner_id,
      category: 'system',
      type: 'recap_ready',
      entityType: 'recap',
      entityId: recapId,
      data: { title: r.title },
    }).catch(() => {});
  } catch (e) {
    if (mediaId) await removeRecapMedia(deps, mediaId).catch(() => false);
    const message = e instanceof RecapFailure ? e.message : "We couldn't make this recap. Try again later.";
    const failed = await db.query(`UPDATE recaps SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND deleted_at IS NULL`, [
      recapId,
      message,
    ]);
    if (failed.rowCount)
      await notify(db, deps.realtime, {
        userId: r.owner_id,
        category: 'system',
        type: 'recap_failed',
        entityType: 'recap',
        entityId: recapId,
        data: { title: r.title },
      }).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function recapJobHandlers(deps: RecapDeps) {
  return {
    [RECAP_JOB]: ({ recapId }: { recapId: string }) => renderRecapJob(deps, recapId),
  };
}
