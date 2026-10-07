import type { Pool, PoolClient } from 'pg';
import type { MediaStorage } from './storage.ts';
import { storedKeys } from './chat.ts';
import { enqueue } from './jobs.ts';

type Q = Pool | PoolClient;

/**
 * Covers of videos (reels and videos in posts): a moment of the video or one of the owner's
 * photos, chosen when posting (the editor's cover frame) or any time after
 * (PUT /v1/posts/:id/cover). A cover is a poster like the default one: poster_url,
 * variants.thumb, blurhash and variant_bytes.poster/thumb, written under a new file name each
 * time so no app or cache keeps showing the old one. While a cover is up, `default_poster`
 * keeps the poster processing made, so "Use default" can put it back (migration 0081).
 *
 * Rendering the cover lives in lib/video-cover-render.ts; this file only moves the state.
 */

/** The poster processing made, as kept in media.default_poster. */
export interface DefaultPoster {
  url: string | null;
  thumb: string | null;
  placeholder: string | null;
  bytes: { poster?: number; thumb?: number };
}

/** A new cover's files, stored and ready to be put up (lib/video-cover-render.ts storeCover). */
export interface StoredCover {
  url: string;
  thumb: string | null;
  placeholder: string | null;
  bytes: { poster: number; thumb?: number };
  /** Its storage keys, to remove again if it doesn't go up. */
  keys: string[];
}

interface CoverRow {
  poster_url: string | null;
  variants: Record<string, string> | null;
  blurhash: string | null;
  variant_bytes: Record<string, number> | null;
  default_poster: DefaultPoster | null;
}

const keyOf = (url: string | null | undefined) =>
  url ? storedKeys({ url, poster_url: null, hls_url: null, variants: null, storage_key: null })[0] : undefined;

/** Before covers had their own file names, the editor's cover frame was written over <key>_cover.jpg (and the thumb stayed the default one). */
const LEGACY_COVER = /_cover\.jpg(\?.*)?$/;

/** What "Use default" goes back to. */
function defaultOf(row: CoverRow): DefaultPoster {
  if (row.default_poster) return row.default_poster;
  const bytes = row.variant_bytes ?? {};
  const poster = row.poster_url && LEGACY_COVER.test(row.poster_url) ? row.poster_url.replace(LEGACY_COVER, '_poster.jpg') : row.poster_url;
  return { url: poster, thumb: row.variants?.thumb ?? null, placeholder: row.blurhash, bytes: { poster: bytes.poster, thumb: bytes.thumb } };
}

/** The files of the cover that is up now, which go when it is replaced (never the upload or the default poster). */
function customKeys(row: CoverRow): string[] {
  const keep = new Set([keyOf(defaultOf(row).url), keyOf(defaultOf(row).thumb)]);
  const up = row.default_poster
    ? [keyOf(row.poster_url), keyOf(row.variants?.thumb)]
    : row.poster_url && LEGACY_COVER.test(row.poster_url)
      ? [keyOf(row.poster_url)]
      : [];
  return up.filter((k): k is string => !!k && !keep.has(k) && isCoverKey(k));
}

/** Only cover files are ever removed through here. */
export const isCoverKey = (k: string) => /^[\w/.-]+$/.test(k) && !k.includes('..') && /_cover(_[0-9a-f]+)?(_thumb)?\.(jpg|webp)$/.test(k);

/** The poster, thumb, preview and their sizes of a media row, set to these. */
async function writePoster(
  c: Q,
  mediaId: string,
  p: { url: string | null; thumb: string | null; placeholder: string | null; bytes: { poster?: number; thumb?: number } },
  rest: string,
  params: unknown[],
) {
  await c.query(
    `UPDATE media SET poster_url = $2,
            variants = CASE WHEN $3::text IS NULL THEN coalesce(variants, '{}'::jsonb) - 'thumb' ELSE coalesce(variants, '{}'::jsonb) || jsonb_build_object('thumb', $3::text) END,
            blurhash = coalesce($4, blurhash),
            variant_bytes = (coalesce(variant_bytes, '{}'::jsonb) - 'poster' - 'thumb') || jsonb_strip_nulls(jsonb_build_object('poster', $5::bigint, 'thumb', $6::bigint)),
            ${rest}
     WHERE id = $1`,
    [mediaId, p.url, p.thumb, p.placeholder, p.bytes.poster ?? null, p.bytes.thumb ?? null, ...params],
  );
}

/**
 * Put a stored cover up on a video, keeping its default poster to go back to. Run it in a
 * transaction: the row is locked while it changes. Returns the keys of the cover it replaced,
 * to remove once the transaction is done.
 */
export async function putCover(c: Q, mediaId: string, cover: StoredCover, choice: { atMs: number | null; imageMediaId: string | null }): Promise<string[]> {
  const row = (await c.query<CoverRow>(`SELECT poster_url, variants, blurhash, variant_bytes, default_poster FROM media WHERE id = $1 FOR UPDATE`, [mediaId]))
    .rows[0];
  if (!row) return [];
  const old = customKeys(row);
  await writePoster(c, mediaId, cover, `cover_ms = $7, cover_image_media_id = $8, default_poster = $9`, [
    choice.atMs,
    choice.imageMediaId,
    JSON.stringify(defaultOf(row)),
  ]);
  return old;
}

/** Go back to the default poster. Returns the keys of the cover that was up (none when there wasn't one). */
export async function restoreDefault(c: Q, mediaId: string): Promise<string[]> {
  const row = (await c.query<CoverRow>(`SELECT poster_url, variants, blurhash, variant_bytes, default_poster FROM media WHERE id = $1 FOR UPDATE`, [mediaId]))
    .rows[0];
  if (!row || (!row.default_poster && !(row.poster_url && LEGACY_COVER.test(row.poster_url)))) return [];
  const old = customKeys(row);
  await writePoster(c, mediaId, defaultOf(row), `cover_ms = NULL, cover_image_media_id = NULL, default_poster = NULL`, []);
  return old;
}

/**
 * A photo marked sensitive or blocked can't stay the cover of anyone's video: covers show in
 * feeds and grids to everyone, people under 18 included. Its videos go back to their default
 * poster now; the cover files are removed by a job (this runs inside the moderation transaction).
 */
export async function dropPhotoCovers(c: Q, imageMediaId: string): Promise<void> {
  const { rows } = await c.query<{ id: string }>(`SELECT id FROM media WHERE cover_image_media_id = $1`, [imageMediaId]);
  for (const r of rows) {
    const keys = await restoreDefault(c, r.id);
    if (keys.length) await enqueue(c, 'media.remove-cover-files', { keys });
  }
}

/** Remove cover files. One that is already gone, or fails to go, never stops the others. */
export async function removeCoverFiles(storage: MediaStorage, keys: string[]): Promise<void> {
  for (const k of keys.filter(isCoverKey)) await storage.remove?.(k).catch(() => {});
}

export function videoCoverJobHandlers(deps: { storage: MediaStorage }) {
  return {
    'media.remove-cover-files': ({ keys }: { keys: string[] }) => removeCoverFiles(deps.storage, Array.isArray(keys) ? keys : []),
  };
}
