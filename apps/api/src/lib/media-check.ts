import type { Queryable } from '@yapilapi/database';
import { invalid } from '@yapilapi/shared';

/**
 * A media id may only be attached to an entity (event cover, place photo, business logo...) by the user who uploaded it,
 * while it is a live image that has not been blocked by the media pipeline. Entity images are world-readable, so the media must have been
 * uploaded with purpose 'public' (attachment-purpose media is only served through the post/moment/message that carries it).
 */
export async function assertOwnedImage(
  db: Queryable,
  mediaId: string,
  userId: string,
): Promise<{ id: string; storageKey: string }> {
  const { rows } = await db.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM media WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND kind = 'image' AND purpose = 'public' AND status IN ('uploaded','processing','ready')`,
    [mediaId, userId],
  );
  if (!rows[0])
    throw invalid(
      'That image is unavailable (it must be an image you uploaded with purpose "public")',
    );
  return { id: rows[0].id, storageKey: rows[0].storage_key };
}
