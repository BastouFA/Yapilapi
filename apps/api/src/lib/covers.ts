import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

/**
 * Profile covers: cover_media_id is the original upload, cover_edit how it was edited (or null),
 * cover_render_media_id the copy rendered from it (lib/cover-render.ts) and cover_url the address
 * shown. Kept free of the renderer so moderation can use it.
 */

/** Every cover column, cleared. */
export const NO_COVER_SQL = `cover_url = NULL, cover_media_id = NULL, cover_alt = NULL, cover_edit = NULL, cover_render_media_id = NULL`;

/**
 * Take covers down (removed, or their photo failed a check). Their rendered copies are marked
 * deleted, and the retention job removes the files.
 */
export async function clearCovers(c: Q, where: string, params: unknown[]): Promise<void> {
  await c.query(
    `UPDATE media SET deleted_at = coalesce(deleted_at, now())
     WHERE id IN (SELECT cover_render_media_id FROM profiles WHERE (${where}) AND cover_render_media_id IS NOT NULL)`,
    params,
  );
  await c.query(`UPDATE profiles SET ${NO_COVER_SQL} WHERE ${where}`, params);
}

/** Mark a cover's earlier rendered copy deleted once a new one (or none) replaces it. */
export async function retireCoverRender(c: Q, mediaId: string | null | undefined, keep?: string | null): Promise<void> {
  if (!mediaId || mediaId === keep) return;
  await c.query(`UPDATE media SET deleted_at = coalesce(deleted_at, now()) WHERE id = $1`, [mediaId]);
}
