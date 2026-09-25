import type { AppContext } from '../../lib/context.js';
import { MediaRejectedError } from './processor.js';
import type { MediaRuntime } from './runtime.js';

/** Remove every storage object a media row owns (original, variants, captions). Best effort; never throws. */
export async function removeMediaObjects(
  rt: MediaRuntime,
  row: { storage_key: string; variants: unknown; captions: unknown },
): Promise<boolean> {
  const keys = [
    row.storage_key,
    ...((row.variants as Array<{ key?: string }>) ?? []).map((v) => v.key),
    ...((row.captions as Array<{ key?: string }>) ?? []).map((c) => c.key),
  ].filter((k): k is string => typeof k === 'string' && k.length > 0 && !k.startsWith('u/'));
  let ok = true;
  for (const k of keys) {
    try {
      await rt.adapter.delete(k);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * Lifecycle: uploaded -> processing -> ready | failed. Runs from the queue after an upload is stored.
 * Never overrides `blocked` (moderation wins) and cleans up after itself if the media was deleted meanwhile.
 */
export async function processMedia(
  ctx: AppContext,
  rt: MediaRuntime,
  mediaId: string,
): Promise<void> {
  const claimed = await ctx.db.query<{
    id: string;
    kind: 'image' | 'video' | 'audio' | 'file';
    mime_type: string;
    storage_key: string;
    size_bytes: string;
  }>(
    `UPDATE media SET status = 'processing', updated_at = now()
      WHERE id = $1 AND status IN ('uploaded','processing') AND deleted_at IS NULL
      RETURNING id, kind, mime_type, storage_key, size_bytes`,
    [mediaId],
  );
  const job = claimed.rows[0];
  if (!job) return;
  try {
    const res = await rt.processor.process(
      {
        mediaId,
        kind: job.kind,
        mime: job.mime_type,
        storageKey: job.storage_key,
        sizeBytes: Number(job.size_bytes),
      },
      rt.adapter,
    );
    const upd = await ctx.db.query(
      `UPDATE media SET status = 'ready', width = COALESCE($2, width), height = COALESCE($3, height), duration_ms = COALESCE($4, duration_ms),
              blurhash = COALESCE($5, blurhash), variants = $6::jsonb, processing = $7, processing_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'processing' AND deleted_at IS NULL`,
      [
        mediaId,
        res.width ?? null,
        res.height ?? null,
        res.durationMs ?? null,
        res.blurhash ?? null,
        JSON.stringify(res.variants),
        res.processing,
      ],
    );
    if (!upd.rowCount) {
      // Deleted or blocked while processing: the derived files must not linger.
      await removeMediaObjects(rt, { storage_key: 'u/none', variants: res.variants, captions: [] });
    }
  } catch (e) {
    const rejected = e instanceof MediaRejectedError;
    if (!rejected) ctx.log.error({ err: e, mediaId }, 'media processing failed');
    await ctx.db.query(
      `UPDATE media SET status = 'failed', processing_error = $2, updated_at = now() WHERE id = $1 AND status = 'processing'`,
      [mediaId, rejected ? (e as Error).message.slice(0, 200) : 'Processing failed'],
    );
    if (rejected) {
      // Unusable file: do not keep the bytes around.
      try {
        await rt.adapter.delete(job.storage_key);
        await ctx.db.query('UPDATE media SET purged_at = now() WHERE id = $1', [mediaId]);
      } catch {
        /* swept later */
      }
    }
  }
}
