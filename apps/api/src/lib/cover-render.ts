import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Pool, PoolClient } from 'pg';
import { COVER_MAX_ZOOM, COVER_RENDER_WIDTH, coverRatioOk, fitCoverCrop, turnedSize, type CoverRecipe } from '@yapilapi/shared';
import { MAX_EDIT_EDGE, renderPhoto } from './media-edit.ts';
import type { MediaStorage } from './storage.ts';

type Q = Pool | PoolClient;

/**
 * Edited profile covers (PUT /v1/me/cover with an edit). The original upload is never changed:
 * each edit is rendered from it with the photo editor's renderer (lib/media-edit.ts) into a new
 * media item with two sizes and no metadata, and the recipe is kept with the profile so the
 * owner can open the original again with everything as they left it.
 */

/** The rendered cover's smaller size, for Data saver (it swaps _large.webp for _medium.webp). */
const COVER_MEDIUM_WIDTH = 1080;

/** The upright size the renderer works on for this photo (capped like it), or null when it can't be read. */
export async function editSize(input: Buffer): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(input, { failOn: 'none' })
    .metadata()
    .catch(() => null);
  const width = meta?.autoOrient?.width ?? meta?.width;
  const height = meta?.autoOrient?.height ?? meta?.height;
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_EDIT_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Why this recipe can't make a cover from a picture of width × height, or null when it can. */
export function coverRecipeProblem(recipe: CoverRecipe, width: number, height: number): string | null {
  const { W, H } = turnedSize(width, height, recipe.rotate);
  if (!coverRatioOk(recipe.crop, W, H)) return 'Frame your cover in the cover shape (8:3).';
  // A little room past the limit for rounding.
  if (fitCoverCrop(W, H).w / recipe.crop.w > COVER_MAX_ZOOM * 1.02) return 'That’s zoomed in too far for a sharp cover. Zoom out a little.';
  return null;
}

/**
 * Render a cover from its original with a recipe and store it as a new media item of `ownerId`
 * (<key>_large.webp and <key>_medium.webp). Returns the new item and the address to show.
 */
export async function renderCover(
  deps: { db: Q; storage: MediaStorage },
  ownerId: string,
  original: Buffer,
  recipe: CoverRecipe,
  moderation: string,
): Promise<{ mediaId: string; url: string }> {
  const full = await renderPhoto(original, { ...recipe, muted: false }, { maxWidth: COVER_RENDER_WIDTH, format: 'webp' });
  const medium = full.width > COVER_MEDIUM_WIDTH ? await sharp(full.data).resize({ width: COVER_MEDIUM_WIDTH }).webp({ quality: 80 }).toBuffer() : full.data;
  const now = new Date();
  const base = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  const large = await deps.storage.putKey(`${base}_large.webp`, full.data, 'image/webp');
  const small = await deps.storage.putKey(`${base}_medium.webp`, medium, 'image/webp');
  const { rows } = await deps.db.query<{ id: string }>(
    `INSERT INTO media (owner_id, kind, url, mime, storage_key, size_bytes, width, height, variants, variant_bytes, status, moderation, used_at)
     VALUES ($1, 'image', $2, 'image/webp', $3, $4, $5, $6, $7, $8, 'ready', $9, now()) RETURNING id`,
    [
      ownerId,
      large.url,
      large.key,
      full.data.length,
      full.width,
      full.height,
      { large: large.url, medium: small.url },
      { large: full.data.length, medium: medium.length },
      moderation,
    ],
  );
  return { mediaId: rows[0]!.id, url: large.url };
}
