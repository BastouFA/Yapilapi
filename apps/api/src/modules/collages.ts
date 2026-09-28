import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { collageSchema, type CollageSpec } from '@yapilapi/shared';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { canonicalJson, COLLAGE_MAX_SOURCE_BYTES, COLLAGE_MAX_TOTAL_BYTES, renderCollage } from '../lib/collage.ts';
import { enqueue } from '../lib/jobs.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** A claim on a client key that never finished (the server stopped mid-way) can be taken again after this. */
const STALE_CLAIM = `interval '2 minutes'`;

interface CollageRow {
  media_id: string | null;
  spec: CollageSpec;
  url: string | null;
  alt_text: string | null;
  width: number | null;
  height: number | null;
}

const result = (r: { media_id: string; url: string; alt_text: string | null; width: number | null; height: number | null }) => ({
  media: { id: r.media_id, kind: 'image' as const, url: r.url, altText: r.alt_text, width: r.width, height: r.height, collage: true as const },
});

/**
 * Photo collages, for posts and stories:
 *   POST /v1/media/collage → a new photo made from 2 to 9 of your processed photos in a layout
 *                            from @yapilapi/shared (shape, gap, corners, background, and each
 *                            cell's photo, focus and zoom)
 * The collage is drawn here at full quality, stored like an upload and put through the same
 * media job (sizes, blurred preview, automated checks); it is then used like any photo. The same
 * client key gives back the same collage, so a request sent again never makes a second one.
 */
export default async function collagesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /** The collage already made (or being made) with this key, or null. The request must be the same one. */
  async function made(userId: string, clientKey: string, spec: CollageSpec) {
    const { rows } = await db.query<CollageRow>(
      `SELECT c.media_id, c.spec, m.url, m.alt_text, m.width, m.height
       FROM media_collages c LEFT JOIN media m ON m.id = c.media_id WHERE c.owner_id = $1 AND c.client_key = $2`,
      [userId, clientKey],
    );
    const r = rows[0];
    if (!r) return null;
    if (canonicalJson(r.spec) !== canonicalJson(spec))
      throw new AppError(409, 'idempotency_mismatch', 'This request was already used for a different collage. Start the collage again.');
    if (!r.media_id || r.url === null) throw new AppError(409, 'collage_in_progress', 'This collage is still being made. Try again in a moment.');
    return result({ ...r, media_id: r.media_id, url: r.url });
  }

  app.post('/v1/media/collage', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(collageSchema, req.body);
    const spec: CollageSpec = {
      layout: input.layout,
      shape: input.shape,
      gap: input.gap,
      radius: input.radius,
      background: input.background,
      cells: input.cells,
    };
    const again = await made(u.id, input.clientKey, spec);
    if (again) return again;

    const ids = spec.cells.map((c) => c.mediaId);
    const { rows } = await db.query(
      `SELECT m.id, m.kind, m.mime, m.storage_key, m.status, m.moderation, m.size_bytes, m.variants ? 'thumb' AS processed
       FROM media m WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND NOT m.private AND m.deleted_at IS NULL`,
      [ids, u.id],
    );
    const sources = ids.map((id) => rows.find((r) => r.id === id));
    let total = 0;
    for (const m of sources) {
      // Someone else's photo looks the same as one that doesn't exist.
      if (!m) throw notFound('That photo');
      if (m.kind !== 'image') throw badRequest('Collages are made from photos.');
      if (!m.storage_key) throw badRequest('This photo was not uploaded here, so it cannot be used.');
      if (m.mime === 'image/gif') throw new AppError(415, 'unsupported_media', 'Animated GIFs cannot be used in a collage.');
      if (m.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
      // Until the media job has made its sizes and (when checks are on) checked it, a photo isn't ready.
      if (m.status !== 'ready' || !m.processed || (ctx.mediaModerator.name !== 'none' && m.moderation === 'pending'))
        throw new AppError(409, 'media_processing', 'Some of these photos are still being prepared. Try again in a moment.');
      const size = Number(m.size_bytes ?? 0);
      if (size > COLLAGE_MAX_SOURCE_BYTES) throw new AppError(413, 'too_large', 'Photos in a collage can be up to 50 MB each.');
      total += size;
    }
    if (total > COLLAGE_MAX_TOTAL_BYTES) throw new AppError(413, 'too_large', 'These photos are too big to put together. Use fewer or smaller photos.');

    // Claim the key before the slow part, so two copies of one request can't both make a collage.
    const claim = await db.query<{ id: string }>(
      `INSERT INTO media_collages (owner_id, client_key, source_ids, spec) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id, client_key) DO UPDATE SET source_ids = EXCLUDED.source_ids, spec = EXCLUDED.spec, created_at = now()
         WHERE media_collages.media_id IS NULL AND media_collages.created_at < now() - ${STALE_CLAIM}
       RETURNING id`,
      [u.id, input.clientKey, ids, spec],
    );
    const claimId = claim.rows[0]?.id;
    if (!claimId) {
      const other = await made(u.id, input.clientKey, spec);
      if (other) return other;
      throw new AppError(409, 'collage_in_progress', 'This collage is still being made. Try again in a moment.');
    }

    try {
      const out = await renderCollage(spec, (i) => ctx.storage.read(sources[i]!.storage_key)).catch(() => {
        throw new AppError(422, 'unsupported_media', "One of these photos couldn't be read, so the collage wasn't made.");
      });
      const stored = await ctx.storage.put(out.data, 'jpg', 'image/jpeg');
      // Shown blurred from the start when a photo in it is: the media job keeps it that way (inheritedVerdict).
      const sensitive = sources.some((m) => m!.moderation === 'sensitive');
      const media = await tx(db, async (c) => {
        const m = await c.query(
          `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, width, height, moderation)
           VALUES ($1,'image',$2,'image/jpeg',$3,'ready',$4,$5,$6,$7,$8) RETURNING id, url, alt_text, width, height`,
          [u.id, stored.url, input.altText || null, stored.key, out.data.length, out.width, out.height, sensitive ? 'sensitive' : 'pending'],
        );
        await c.query(`UPDATE media_collages SET media_id = $2 WHERE id = $1`, [claimId, m.rows[0].id]);
        // The same processing and checks as an upload.
        await enqueue(c, 'media.process', { mediaId: m.rows[0].id, filename: 'collage.jpg' });
        return m.rows[0];
      });
      reply.code(201);
      return result({ ...media, media_id: media.id });
    } catch (err) {
      await db.query(`DELETE FROM media_collages WHERE id = $1 AND media_id IS NULL`, [claimId]);
      throw err;
    }
  });
}
