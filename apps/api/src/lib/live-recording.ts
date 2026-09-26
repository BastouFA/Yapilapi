import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { tx } from '@yapilapi/database';
import { enqueue } from './jobs.ts';
import { probe, run } from './media-processing.ts';
import type { MediaStorage } from './storage.ts';

export interface LiveRecordingDeps {
  db: Pool;
  storage: MediaStorage;
  /** Where MediaMTX writes recordings (recordPath's root). Unset: recording and auto-clips are off. */
  recordingsDir: string | undefined;
}

const WINDOW_MS = 30_000;
const MAX_CLIPS = 3;
/** A window needs at least this much activity to count as a highlight. */
const MIN_SCORE = 3;

/**
 * MediaMTX names segments by the time they started (recordPath
 * `%path/%Y-%m-%d_%H-%M-%S-%f`, UTC in the container). Returns the segments of
 * one live in order, with their start times.
 */
export async function recordingSegments(dir: string, sessionId: string): Promise<{ file: string; startedAt: Date }[]> {
  // Absolute, because ffmpeg's concat list resolves relative paths against the list file's own folder.
  const folder = path.resolve(dir, 'live', sessionId);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const m = n.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{1,6})\.(mp4|ts)$/);
      if (!m) return null;
      const ms = Number(m[7]!.padEnd(6, '0').slice(0, 3));
      return { file: path.join(folder, n), startedAt: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, ms)) };
    })
    .filter((x): x is { file: string; startedAt: Date } => !!x)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

/**
 * Highlights = the busiest 30-second stretches of chat, weighted so a gift
 * counts more than a message. Returns up to three non-overlapping windows,
 * as offsets into the recording.
 */
export function pickHighlights(
  events: { at: Date; weight: number }[],
  recordingStart: Date,
  durationMs: number,
): { startMs: number; endMs: number; score: number }[] {
  const buckets = new Map<number, number>();
  for (const e of events) {
    const offset = e.at.getTime() - recordingStart.getTime();
    if (offset < 0 || offset > durationMs) continue;
    const b = Math.floor(offset / WINDOW_MS);
    buckets.set(b, (buckets.get(b) ?? 0) + e.weight);
  }
  const picked: { startMs: number; endMs: number; score: number }[] = [];
  for (const [b, score] of [...buckets].sort((x, y) => y[1] - x[1])) {
    if (score < MIN_SCORE || picked.length >= MAX_CLIPS) break;
    // People react after the moment, so each clip starts 10 seconds before its busiest window.
    const startMs = Math.max(0, b * WINDOW_MS - 10_000);
    const endMs = Math.min(durationMs, startMs + WINDOW_MS + 10_000);
    if (endMs - startMs < 1000) continue;
    if (picked.some((p) => startMs < p.endMs && endMs > p.startMs)) continue;
    picked.push({ startMs, endMs, score });
  }
  return picked.sort((a, b) => a.startMs - b.startMs);
}

/** How long after a live ends we keep waiting for the encoder to stop writing. */
const SETTLE_LIMIT_MS = 10 * 60_000;
/** A segment untouched for this long is finished. */
const QUIET_MS = 10_000;

/**
 * Chat times are wall-clock; the joined recording has no gaps (segments are
 * concatenated), so each moment maps to its own segment's position in the
 * joined file. Moments that fall between segments (the stream dropped) map to
 * nothing.
 */
export function timelineMapper(segments: { startedAt: Date; durationMs: number }[]) {
  let offset = 0;
  const spans = segments.map((sg) => {
    const span = { from: sg.startedAt.getTime(), to: sg.startedAt.getTime() + sg.durationMs, offset };
    offset += sg.durationMs;
    return span;
  });
  return (at: Date): number | null => {
    const t = at.getTime();
    const sp = spans.find((x) => t >= x.from && t < x.to);
    return sp ? sp.offset + (t - sp.from) : null;
  };
}

/** After a live ends: store the recording as the host's video and queue highlight clips from it. */
export async function processLiveRecording(deps: LiveRecordingDeps, sessionId: string) {
  if (!deps.recordingsDir) return;
  const live = (await deps.db.query(`SELECT id, host_id, title, status, ended_at, recording_media_id FROM live_sessions WHERE id = $1`, [sessionId])).rows[0];
  if (!live || live.status !== 'ended' || live.recording_media_id) return;
  const segments = await recordingSegments(deps.recordingsDir, sessionId);
  if (!segments.length) {
    await deps.db.query(`UPDATE live_sessions SET recording_status = 'none' WHERE id = $1`, [sessionId]);
    return;
  }
  // Ending the live doesn't stop an encoder that keeps pushing; wait until the last segment stops growing.
  const lastWrite = Math.max(...(await Promise.all(segments.map(async (sg) => (await stat(sg.file)).mtimeMs))));
  const endedAgo = Date.now() - new Date(live.ended_at ?? Date.now()).getTime();
  if (Date.now() - lastWrite < QUIET_MS && endedAgo < SETTLE_LIMIT_MS) {
    await enqueue(deps.db, 'live.recording', { sessionId }, 15);
    return;
  }

  const work = await mkdtemp(path.join(tmpdir(), 'ypl-live-'));
  try {
    const timed: { file: string; startedAt: Date; durationMs: number }[] = [];
    for (const sg of segments) timed.push({ ...sg, durationMs: (await probe(sg.file)).durationMs ?? 0 });
    const list = path.join(work, 'list.txt');
    await writeFile(list, segments.map((sg) => `file '${sg.file.replace(/'/g, "'\\''")}'`).join('\n'));
    const out = path.join(work, 'recording.mp4');
    // Segments share codecs, so they are joined without re-encoding.
    await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    const info = await probe(out);
    // Streamed from disk: a long live can be many gigabytes.
    const stored = await deps.storage.putFile(out, 'mp4', 'video/mp4');
    const size = (await stat(out)).size;

    const chat = await deps.db.query<{ created_at: Date; kind: string }>(
      `SELECT created_at, kind FROM live_chat WHERE session_id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    const toOffset = timelineMapper(timed);
    const highlights = pickHighlights(
      chat.rows.flatMap((r) => {
        const off = toOffset(r.created_at);
        return off === null ? [] : [{ at: new Date(timed[0]!.startedAt.getTime() + off), weight: r.kind === 'gift' ? 5 : r.kind === 'reaction' ? 0.5 : 1 }];
      }),
      timed[0]!.startedAt,
      info.durationMs ?? 0,
    );

    // The recording, its link on the live and the clip jobs are saved together, so a retry never duplicates them.
    await tx(deps.db, async (c) => {
      const media = await c.query(
        `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms)
         VALUES ($1,'video',$2,'video/mp4',$3,'processing',$4,$5,$6) RETURNING id`,
        [live.host_id, stored.url, `Recording of the live "${live.title}"`, stored.key, size, info.durationMs],
      );
      const mediaId = media.rows[0].id as string;
      await enqueue(c, 'media.process', { mediaId });
      await c.query(`UPDATE live_sessions SET recording_media_id = $2, recording_status = 'ready' WHERE id = $1`, [sessionId, mediaId]);
      for (const h of highlights) {
        const edit = await c.query(
          `INSERT INTO media_edits (source_media_id, owner_id, kind, start_ms, end_ms, auto) VALUES ($1,$2,'clip',$3,$4,true) RETURNING id`,
          [mediaId, live.host_id, h.startMs, h.endMs],
        );
        await enqueue(c, 'media.edit', { editId: edit.rows[0].id });
      }
    });
  } catch (err) {
    await deps.db.query(`UPDATE live_sessions SET recording_status = 'failed' WHERE id = $1 AND recording_media_id IS NULL`, [sessionId]);
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function liveRecordingJobHandlers(deps: LiveRecordingDeps) {
  return { 'live.recording': ({ sessionId }: { sessionId: string }) => processLiveRecording(deps, sessionId) };
}
