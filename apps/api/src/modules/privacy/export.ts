import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { withTransaction } from '@yapilapi/database';
import { AppError, notFound } from '@yapilapi/shared';
import { randomToken, safeEqual, sha256Hex } from '@yapilapi/security';
import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';
import { getExportSections } from './registry.js';

export const EXPORT_TTL_HOURS = 72;
export const DOWNLOAD_LINK_TTL_MINUTES = 10;
export const EXPORT_MIN_INTERVAL_HOURS = 24;

export interface ExportArchive {
  format: 'yapilapi-export';
  version: 1;
  generatedAt: string;
  userId: string;
  sections: Record<string, { description: string; data: unknown }>;
  notes: string[];
}

/** Collect every registered section. A failing section fails the export: an incomplete archive must never look complete. */
export async function buildExport(ctx: AppContext, userId: string): Promise<ExportArchive> {
  const sections: ExportArchive['sections'] = {};
  for (const s of getExportSections()) {
    sections[s.key] = { description: s.description, data: await s.collect(ctx, ctx.db, userId) };
  }
  return {
    format: 'yapilapi-export',
    version: 1,
    generatedAt: new Date().toISOString(),
    userId,
    sections,
    notes: [
      "Contains data you own or authored. Messages other people sent you, other people's private data, and secrets (passwords, tokens, keys) are not included.",
      'Lists are capped at 20,000 items per section; contact support if you need more.',
    ],
  };
}

/**
 * Create an export request and build the archive. Rate limited to one per 24 hours (counted in the database so the
 * limit holds across processes and restarts). Runs synchronously: fine for the account sizes we serve today; a queue is
 * the documented next step for very large accounts.
 */
export async function requestExport(
  ctx: AppContext,
  userId: string,
): Promise<{ requestId: string; status: string; expiresAt: string; sizeBytes: number }> {
  const recent = await ctx.db.query<{ created_at: Date }>(
    `SELECT created_at FROM privacy_requests WHERE user_id = $1 AND kind = 'export' AND status IN ('pending','processing','completed') AND created_at > now() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT 1`,
    [userId, String(EXPORT_MIN_INTERVAL_HOURS)],
  );
  if (recent.rows[0]) {
    const retryAt = new Date(
      recent.rows[0].created_at.getTime() + EXPORT_MIN_INTERVAL_HOURS * 3_600_000,
    );
    throw new AppError('rate_limited', 'You can request one data export every 24 hours.', {
      retryAfterSec: Math.ceil((retryAt.getTime() - Date.now()) / 1000),
      retryAt: retryAt.toISOString(),
    });
  }
  const req = await ctx.db.query<{ id: string }>(
    `INSERT INTO privacy_requests (user_id, kind, status) VALUES ($1,'export','processing') RETURNING id`,
    [userId],
  );
  const requestId = req.rows[0]!.id;
  try {
    const archive = await buildExport(ctx, userId);
    const json = Buffer.from(JSON.stringify(archive));
    const gz = gzipSync(json);
    const expiresAt = new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000);
    await withTransaction(ctx.db, async (tx) => {
      await tx.query(
        'INSERT INTO privacy_exports (request_id, user_id, payload_gz, size_bytes, sha256, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          requestId,
          userId,
          gz,
          json.length,
          createHash('sha256').update(json).digest('hex'),
          expiresAt,
        ],
      );
      await tx.query(
        `UPDATE privacy_requests SET status = 'completed', completed_at = now(), updated_at = now(), result = $2 WHERE id = $1`,
        [
          requestId,
          JSON.stringify({
            sizeBytes: json.length,
            expiresAt: expiresAt.toISOString(),
            sections: Object.keys(archive.sections),
          }),
        ],
      );
    });
    await notify(ctx, {
      userId,
      kind: 'privacy_export_ready',
      actorId: null,
      targetType: 'privacy_request',
      targetId: requestId,
      data: { expiresAt: expiresAt.toISOString() },
    });
    return {
      requestId,
      status: 'completed',
      expiresAt: expiresAt.toISOString(),
      sizeBytes: json.length,
    };
  } catch (err) {
    await ctx.db.query(
      `UPDATE privacy_requests SET status = 'rejected', completed_at = now(), updated_at = now(), result = $2 WHERE id = $1`,
      [requestId, JSON.stringify({ error: 'export_failed' })],
    );
    ctx.log.error({ err, requestId }, 'data export failed');
    throw new AppError('internal', 'We could not build your export. Please try again later.');
  }
}

/** Mint a short-lived, single-use download token. The download additionally requires the owner's session. */
export async function createDownloadLink(
  ctx: AppContext,
  userId: string,
  requestId: string,
): Promise<{ path: string; expiresAt: string }> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + DOWNLOAD_LINK_TTL_MINUTES * 60_000);
  const r = await ctx.db.query(
    `UPDATE privacy_exports SET link_hash = $3, link_expires_at = $4 WHERE request_id = $1 AND user_id = $2 AND expires_at > now() RETURNING 1`,
    [requestId, userId, sha256Hex(token), expires],
  );
  if (!r.rowCount) throw notFound('Export');
  return {
    path: `/v1/privacy/requests/${requestId}/download?token=${token}`,
    expiresAt: expires.toISOString(),
  };
}

export async function consumeDownload(
  ctx: AppContext,
  userId: string,
  requestId: string,
  token: string,
): Promise<{ body: Buffer; filename: string; sha256: string }> {
  const row = await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{
      payload_gz: Buffer;
      link_hash: string | null;
      link_expires_at: Date | null;
      sha256: string;
      created_at: Date;
    }>(
      `SELECT payload_gz, link_hash, link_expires_at, sha256, created_at FROM privacy_exports WHERE request_id = $1 AND user_id = $2 AND expires_at > now() FOR UPDATE`,
      [requestId, userId],
    );
    const e = rows[0];
    if (!e) throw notFound('Export');
    const ok =
      e.link_hash &&
      e.link_expires_at &&
      e.link_expires_at.getTime() > Date.now() &&
      safeEqual(e.link_hash, sha256Hex(token));
    if (!ok)
      throw new AppError(
        'forbidden',
        'This download link is invalid or has expired. Request a new one.',
      );
    // Single use: burn the link before serving.
    await tx.query(
      'UPDATE privacy_exports SET link_hash = NULL, link_expires_at = NULL, downloaded_at = now(), download_count = download_count + 1 WHERE request_id = $1',
      [requestId],
    );
    return e;
  });
  return {
    body: gunzipSync(row.payload_gz),
    filename: `yapilapi-export-${row.created_at.toISOString().slice(0, 10)}.json`,
    sha256: row.sha256,
  };
}

/** Job: purge expired archives so exported personal data does not linger. */
export async function purgeExpiredExports(ctx: AppContext): Promise<number> {
  const r = await ctx.db.query('DELETE FROM privacy_exports WHERE expires_at <= now()');
  return r.rowCount ?? 0;
}

export async function listPrivacyRequests(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.kind, r.status, r.created_at, r.completed_at, r.result,
            e.expires_at AS export_expires_at, e.size_bytes, (e.request_id IS NOT NULL AND e.expires_at > now()) AS downloadable
       FROM privacy_requests r LEFT JOIN privacy_exports e ON e.request_id = r.id WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
    ...(r.kind === 'export'
      ? {
          export: {
            downloadable: Boolean(r.downloadable),
            expiresAt: r.export_expires_at?.toISOString() ?? null,
            sizeBytes: r.size_bytes ?? null,
          },
        }
      : {}),
    ...(r.kind === 'delete' ? { scheduledFor: r.result?.scheduledFor ?? null } : {}),
  }));
}
