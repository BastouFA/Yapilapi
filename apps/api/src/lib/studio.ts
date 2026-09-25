import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { MediaStorage } from './storage.ts';
import { enqueue } from './jobs.ts';
import { probe, run } from './media-processing.ts';
import { MAX_TRANSCRIBE_AUDIO_BYTES, type TranscriptionProvider } from './transcription.ts';
import { parseVtt, serializeVtt, type Cue } from './webvtt.ts';

type Q = Pool | PoolClient;

export interface StudioDeps {
  db: Pool;
  storage: MediaStorage;
  transcription: TranscriptionProvider | null;
}

/** Copy a stored object to a temp dir, run fn, clean up. */
async function withLocalCopy<T>(storage: MediaStorage, key: string, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-studio-'));
  try {
    const file = path.join(dir, 'input');
    await writeFile(file, await storage.read(key));
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Duration of a stored video, probed and saved when processing didn't record it (older uploads). */
export async function videoDurationMs(deps: { db: Q; storage: MediaStorage }, media: { id: string; storage_key: string; duration_ms: number | null }) {
  if (media.duration_ms) return media.duration_ms;
  const info = await withLocalCopy(deps.storage, media.storage_key, (file) => probe(file));
  if (info.durationMs) await deps.db.query(`UPDATE media SET duration_ms = $2 WHERE id = $1`, [media.id, info.durationMs]);
  return info.durationMs;
}

/** Store a sanitized track under a fresh key (media URLs are cached as immutable) and upsert its row. */
export async function saveCaptionTrack(
  deps: { db: Q; storage: MediaStorage },
  t: { mediaId: string; lang: string; label: string; source: 'manual' | 'upload' | 'auto'; cues: Cue[]; userId: string | null },
) {
  const stored = await deps.storage.putKey(
    `captions/${t.mediaId}/${t.lang}-${randomUUID().slice(0, 8)}.vtt`,
    Buffer.from(serializeVtt(t.cues), 'utf8'),
    'text/vtt; charset=utf-8',
  );
  const { rows } = await deps.db.query(
    `INSERT INTO caption_tracks (media_id, lang, label, source, status, storage_key, url, cue_count, created_by)
     VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,$8)
     ON CONFLICT (media_id, lang) DO UPDATE SET label = EXCLUDED.label, source = EXCLUDED.source, status = 'ready', storage_key = EXCLUDED.storage_key,
       url = EXCLUDED.url, cue_count = EXCLUDED.cue_count, error = NULL
     RETURNING id`,
    [t.mediaId, t.lang, t.label, t.source, stored.key, stored.url, t.cues.length, t.userId],
  );
  return rows[0].id as string;
}

/**
 * Render one trim or clip: cut [start, end) from the original upload with a
 * re-encode (frame-accurate), store it as a new media item owned by the same
 * person, then hand it to the regular 'media.process' job for poster, MP4 and HLS.
 * Failures are recorded on the edit rather than retried: a bad cut stays bad.
 */
async function renderEdit(deps: StudioDeps, editId: string) {
  const { rows } = await deps.db.query(
    `SELECT e.id, e.owner_id, e.start_ms, e.end_ms, e.status, m.storage_key, m.alt_text
     FROM media_edits e JOIN media m ON m.id = e.source_media_id WHERE e.id = $1`,
    [editId],
  );
  const e = rows[0];
  if (!e || !['queued', 'rendering'].includes(e.status)) return;
  await deps.db.query(`UPDATE media_edits SET status = 'rendering' WHERE id = $1`, [editId]);
  try {
    if (!e.storage_key) throw new Error('The original file is no longer stored.');
    const out = await withLocalCopy(deps.storage, e.storage_key, async (input, dir) => {
      const info = await probe(input);
      const file = path.join(dir, 'edit.mp4');
      await run([
        '-ss',
        (e.start_ms / 1000).toFixed(3),
        '-i',
        input,
        '-t',
        ((e.end_ms - e.start_ms) / 1000).toFixed(3),
        '-map',
        '0:v:0',
        ...(info.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k'] : []),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-avoid_negative_ts',
        'make_zero',
        file,
      ]);
      return { data: await readFile(file), durationMs: (await probe(file)).durationMs };
    });
    const stored = await deps.storage.put(out.data, 'mp4', 'video/mp4');
    const media = await deps.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms)
       VALUES ($1,'video',$2,'video/mp4',$3,'processing',$4,$5,$6) RETURNING id`,
      [e.owner_id, stored.url, e.alt_text, stored.key, out.data.length, out.durationMs],
    );
    const jobId = await enqueue(deps.db, 'media.process', { mediaId: media.rows[0].id });
    await deps.db.query(`UPDATE media_edits SET status = 'processing', result_media_id = $2, process_job_id = $3, finished_at = now() WHERE id = $1`, [
      editId,
      media.rows[0].id,
      jobId,
    ]);
  } catch (err) {
    await deps.db.query(`UPDATE media_edits SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
      editId,
      `We couldn't render this part of the video. ${String((err as Error).message).slice(0, 200)}`,
    ]);
  }
}

/** Automatic captions through the configured speech-to-text provider. */
async function transcribeTrack(deps: StudioDeps, trackId: string) {
  const { rows } = await deps.db.query(
    `SELECT t.id, t.media_id, t.lang, t.label, t.status, t.created_by, m.storage_key
     FROM caption_tracks t JOIN media m ON m.id = t.media_id WHERE t.id = $1`,
    [trackId],
  );
  const t = rows[0];
  if (!t || t.status !== 'processing') return;
  const fail = (message: string) => deps.db.query(`UPDATE caption_tracks SET status = 'failed', error = $2 WHERE id = $1`, [trackId, message]);
  if (!deps.transcription) return fail('Automatic captions are not set up on this server.');
  try {
    const audio = await withLocalCopy(deps.storage, t.storage_key, async (input, dir) => {
      if (!(await probe(input)).hasAudio) return null;
      const file = path.join(dir, 'audio.m4a');
      // Mono speech-quality audio keeps long videos under the provider's upload limit.
      await run(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', file]);
      if ((await stat(file)).size > MAX_TRANSCRIBE_AUDIO_BYTES) throw new Error('This video is too long for automatic captions.');
      return readFile(file);
    });
    if (!audio) return fail('This video has no sound to caption.');
    const vtt = await deps.transcription.transcribe({ audio, filename: 'audio.m4a', mime: 'audio/mp4', language: t.lang });
    const cues = parseVtt(vtt);
    if (!cues.length) return fail('No speech was found in this video.');
    // The owner may have written or uploaded captions in this language meanwhile; theirs win.
    const still = await deps.db.query(`SELECT 1 FROM caption_tracks WHERE id = $1 AND status = 'processing'`, [trackId]);
    if (!still.rowCount) return;
    await saveCaptionTrack(deps, { mediaId: t.media_id, lang: t.lang, label: t.label, source: 'auto', cues, userId: t.created_by });
  } catch (err) {
    await fail(`Automatic captions failed. ${String((err as Error).message).slice(0, 200)}`);
  }
}

export function studioJobHandlers(deps: StudioDeps) {
  return {
    'media.edit': ({ editId }: { editId: string }) => renderEdit(deps, editId),
    'captions.transcribe': ({ trackId }: { trackId: string }) => transcribeTrack(deps, trackId).then(() => undefined),
  };
}
