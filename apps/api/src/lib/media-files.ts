import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.ts';
import type { MediaStorage } from './storage.ts';
import { storedKeys } from './chat.ts';
import { removePrivate } from './private-files.ts';

type Q = Pool | PoolClient;

export interface FileDeps {
  db: Q;
  storage: MediaStorage;
  config: Config;
}

export interface MediaFilesRow {
  url: string | null;
  poster_url: string | null;
  hls_url: string | null;
  variants: Record<string, string> | null;
  storage_key: string | null;
  private?: boolean;
}

/** Sizes and copies processing, the editor and recaps write next to an upload (<key without extension>_<suffix>). */
const DERIVED_SUFFIXES = ['_thumb.webp', '_medium.webp', '_large.webp', '_poster.jpg', '_web.mp4', '_360.mp4', '_recap.jpg', '_cover.jpg'];

/**
 * Every file one stored photo, video or voice note has: the upload, its sizes and posters, its
 * web MP4s, and its HLS folder (playlists and every segment, removed as a folder). Private
 * (view-once) files are listed separately: they live outside the public media folder.
 */
export function mediaFiles(row: MediaFilesRow): { keys: string[]; prefixes: string[]; privateKeys: string[] } {
  const key = row.storage_key;
  if (key?.startsWith('private/') || row.private) return { keys: [], prefixes: [], privateKeys: key ? [key] : [] };
  const keys = new Set(storedKeys(row));
  const prefixes: string[] = [];
  // Only uploads (<year>/<month>/<uuid>.<ext>) have derived files; caption and shared-video files stand alone.
  if (key && /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.\w+$/i.test(key)) {
    const base = key.replace(/\.[^.]+$/, '');
    for (const s of DERIVED_SUFFIXES) keys.add(`${base}${s}`);
    prefixes.push(`${base}_hls/`);
  }
  return { keys: [...keys].filter((k) => /^[\w/.-]+$/.test(k) && !k.includes('..')), prefixes, privateKeys: [] };
}

/** Delete these files from storage. A file that is already gone, or fails to go, never stops the others; failures are counted. */
export async function removeFiles(deps: Omit<FileDeps, 'db'>, rows: MediaFilesRow[]): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  const attempt = async (p: Promise<void> | undefined) => {
    if (!p) return;
    await p.then(
      () => void removed++,
      () => void failed++,
    );
  };
  for (const row of rows) {
    const f = mediaFiles(row);
    for (const k of f.keys) await attempt(deps.storage.remove?.(k));
    for (const p of f.prefixes) await attempt(deps.storage.removePrefix?.(p));
    for (const k of f.privateKeys) await attempt(removePrivate(deps, k));
  }
  return { removed, failed };
}

const MEDIA_FILE_COLS = `m.id, m.url, m.poster_url, m.hls_url, m.variants, m.storage_key, m.private`;

/**
 * Delete media rows and every file behind them: sizes, posters, web MP4s, HLS segments and
 * caption files. Rows go first, so nothing points at a file while it is being removed.
 */
export async function purgeMedia(deps: FileDeps, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { rows } = await deps.db.query<MediaFilesRow & { id: string }>(`SELECT ${MEDIA_FILE_COLS} FROM media m WHERE m.id = ANY($1::uuid[])`, [ids]);
  const captions = await deps.db.query<{ storage_key: string }>(
    `SELECT storage_key FROM caption_tracks WHERE media_id = ANY($1::uuid[]) AND storage_key IS NOT NULL`,
    [ids],
  );
  // A sound whose audio this was can't play any more.
  await deps.db.query(`DELETE FROM sounds WHERE media_id = ANY($1::uuid[])`, [ids]);
  await deps.db.query(`DELETE FROM media WHERE id = ANY($1::uuid[])`, [ids]);
  await removeFiles(deps, [...rows, ...captions.rows.map((c) => ({ url: null, poster_url: null, hls_url: null, variants: null, storage_key: c.storage_key }))]);
  return rows.length;
}

/**
 * Media that nothing uses any more: not in a post, story, message (attachment or view once),
 * profile cover or avatar, sound, recap or live recording, apart from the posts, stories and
 * messages being deleted.
 */
export async function unusedMedia(db: Q, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT m.id FROM media m
     WHERE m.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE pm.media_id = m.id AND p.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.media_id = m.id AND mo.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.view_once_media_id = m.id AND x.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.deleted_at IS NULL AND x.attachments @> jsonb_build_array(jsonb_build_object('mediaId', m.id::text)))
       AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.cover_media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.avatar_url IS NOT NULL AND (pr.avatar_url = m.url OR pr.avatar_url IN (SELECT value FROM jsonb_each_text(coalesce(m.variants, '{}'::jsonb)))))
       -- A sound made from it counts while a post still uses that sound.
       AND NOT EXISTS (SELECT 1 FROM sounds s JOIN posts sp ON sp.sound_id = s.id WHERE s.media_id = m.id AND sp.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM recaps r WHERE r.media_id = m.id AND r.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM live_sessions l WHERE l.recording_media_id = m.id)`,
    [ids],
  );
  return rows.map((r) => r.id);
}

/** The raw recording MediaMTX wrote for one live (LIVE_RECORDINGS_DIR/live/<id>/). Gone already is fine. */
export async function removeLiveRecordingFolder(recordingsDir: string | undefined, sessionId: string): Promise<void> {
  if (!recordingsDir || !/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  await rm(path.resolve(recordingsDir, 'live', sessionId), { recursive: true, force: true });
}

export interface AccountFiles {
  rows: MediaFilesRow[];
  lives: string[];
}

const keyOnly = (storage_key: string): MediaFilesRow => ({ url: null, poster_url: null, hls_url: null, variants: null, storage_key });

/**
 * Everything stored for one account, listed before it is deleted: its photos, videos and voice
 * notes (with every size, poster, MP4, HLS segment and caption file), view-once files, live
 * recordings (the stored video and the raw recording), recap videos and shared-reel videos.
 * The private files of digital products it sold are kept for the people who bought them.
 */
export async function collectAccountFiles(db: Q, userId: string): Promise<AccountFiles> {
  const media = await db.query<MediaFilesRow>(`SELECT ${MEDIA_FILE_COLS} FROM media m WHERE m.owner_id = $1`, [userId]);
  const captions = await db.query<{ storage_key: string }>(
    `SELECT c.storage_key FROM caption_tracks c JOIN media m ON m.id = c.media_id WHERE m.owner_id = $1 AND c.storage_key IS NOT NULL`,
    [userId],
  );
  const shares = await db.query<{ storage_key: string }>(
    `SELECT sv.storage_key FROM share_videos sv JOIN posts p ON p.id = sv.post_id WHERE p.author_id = $1 AND sv.storage_key IS NOT NULL`,
    [userId],
  );
  const lives = await db.query<{ id: string }>(`SELECT id FROM live_sessions WHERE host_id = $1`, [userId]);
  return {
    rows: [...media.rows, ...captions.rows.map((c) => keyOnly(c.storage_key)), ...shares.rows.map((s) => keyOnly(s.storage_key))],
    lives: lives.rows.map((l) => l.id),
  };
}

/** Remove what collectAccountFiles listed, once the account's rows are gone. */
export async function removeAccountFiles(deps: Omit<FileDeps, 'db'>, files: AccountFiles): Promise<{ removed: number; failed: number }> {
  const result = await removeFiles(deps, files.rows);
  for (const id of files.lives)
    await removeLiveRecordingFolder(deps.config.LIVE_RECORDINGS_DIR, id).then(
      () => void result.removed++,
      () => void result.failed++,
    );
  return result;
}
