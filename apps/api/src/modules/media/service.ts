import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { withTransaction } from '@yapilapi/database';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { mediaUrl } from '../../lib/media-url.js';
import { stripJpegMetadata, stripPngMetadata } from './exif.js';
import { removeMediaObjects } from './pipeline.js';
import { loadSharp } from './processor.js';
import { getMediaRuntime } from './runtime.js';
import {
  MAX_BYTES,
  MIME_BY_EXT,
  SIMPLE_UPLOAD_MAX_BYTES,
  SNIFF_BYTES,
  sniffMedia,
  type MediaKind,
  type Sniffed,
} from './sniff.js';
import { chunkKey, newObjectKey } from './storage.js';
import { LANG_RE, validateVtt } from './vtt.js';

export const USER_STORAGE_QUOTA_BYTES = 10 * 1024 ** 3;
export const UPLOAD_TTL_HOURS = 24;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_CHUNKS = 4096;
const DIRECT_TTL_SEC = 15 * 60;

export const httpError = (status: number, message: string, details?: unknown) =>
  Object.assign(new Error(message), { statusCode: status, details });

// ------------------------------------------------------------------------------------------------ row + view
export interface MediaRow {
  id: string;
  owner_id: string;
  kind: MediaKind;
  storage_key: string;
  mime_type: string;
  size_bytes: string | number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  alt_text: string | null;
  alt_text_declined: boolean;
  blurhash: string | null;
  checksum_sha256: string | null;
  status: 'pending' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'blocked';
  variants: Array<{
    name: string;
    key: string;
    mime: string;
    width?: number;
    height?: number;
    durationMs?: number;
    sizeBytes: number;
  }>;
  captions: Array<{ lang: string; label?: string; kind: string; key: string; sizeBytes?: number }>;
  upload_state: UploadState;
  purpose: 'attachment' | 'public';
  processing: 'variants' | 'metadata' | 'passthrough' | null;
  processing_error: string | null;
  created_at: Date;
}

export interface UploadState {
  mode?: 'chunked' | 'direct';
  declaredKind?: MediaKind;
  size?: number;
  sha256?: string;
  chunkSize?: number;
  chunkCount?: number;
  chunks?: Record<string, { size: number; sha256: string }>;
  expiresAt?: string;
  completing?: boolean;
  contentType?: string;
  sanitized?: 'sharp' | 'js' | 'not_applicable' | 'unavailable';
}

export const MEDIA_COLS = `m.id, m.owner_id, m.kind, m.storage_key, m.mime_type, m.size_bytes, m.width, m.height, m.duration_ms, m.alt_text, m.alt_text_declined,
  m.blurhash, m.checksum_sha256, m.status, m.variants, m.captions, m.upload_state, m.purpose, m.processing, m.processing_error, m.created_at`;

const SERVED = new Set(['uploaded', 'processing', 'ready']);

export function mediaView(ctx: AppContext, r: MediaRow, forOwner: boolean) {
  const served = SERVED.has(r.status);
  const url = (key: string) => mediaUrl(ctx.config, key);
  const sanitized = r.upload_state?.sanitized;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    url: served ? url(r.storage_key) : null,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    blurhash: r.blurhash,
    altText: r.alt_text,
    // Accessibility prompt: images without alt text (and not declared decorative) should be described by the uploader.
    needsAltText: r.kind === 'image' && !r.alt_text && !r.alt_text_declined,
    purpose: r.purpose,
    // 'variants' = derived renditions exist, 'metadata' = only probed, 'passthrough' = stored exactly as uploaded.
    processing: r.processing,
    variants: served
      ? r.variants.map((v) => ({
          name: v.name,
          url: url(v.key),
          mimeType: v.mime,
          width: v.width ?? null,
          height: v.height ?? null,
          durationMs: v.durationMs ?? null,
          sizeBytes: v.sizeBytes,
        }))
      : [],
    captions: served
      ? r.captions.map((c) => ({
          lang: c.lang,
          label: c.label ?? null,
          kind: c.kind,
          url: url(c.key),
        }))
      : [],
    createdAt: r.created_at.toISOString(),
    ...(forOwner
      ? {
          checksumSha256: r.checksum_sha256,
          processingError: r.processing_error,
          // Whether GPS/EXIF metadata was removed from the stored image.
          metadataStripped:
            r.kind !== 'image'
              ? null
              : sanitized === 'sharp' || sanitized === 'js' || sanitized === 'not_applicable',
        }
      : {}),
  };
}

export async function loadOwnedMedia(
  ctx: AppContext,
  id: string,
  ownerId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<MediaRow> {
  const { rows } = await ctx.db.query<MediaRow>(
    `SELECT ${MEDIA_COLS} FROM media m WHERE m.id = $1 AND m.owner_id = $2 AND m.deleted_at IS NULL${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [id, ownerId],
  );
  if (!rows[0]) throw notFound('Media');
  return rows[0];
}

const sha256Of = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

function normaliseAlt(altText: string | undefined): string | null {
  const t = altText?.trim();
  return t ? t.slice(0, 1500) : null;
}

async function assertQuota(ctx: AppContext, ownerId: string, adding: number): Promise<void> {
  const { rows } = await ctx.db.query<{ used: string }>(
    'SELECT COALESCE(SUM(size_bytes),0)::text AS used FROM media WHERE owner_id = $1 AND deleted_at IS NULL',
    [ownerId],
  );
  if (Number(rows[0]!.used) + adding > USER_STORAGE_QUOTA_BYTES)
    throw httpError(413, 'Storage quota exceeded');
}

function checkKindAndSize(s: Sniffed, size: number): void {
  if (size > MAX_BYTES[s.kind])
    throw httpError(
      413,
      `File too large for ${s.kind} (max ${Math.floor(MAX_BYTES[s.kind] / 1024 / 1024)} MB)`,
    );
}

// ------------------------------------------------------------------------------------------------ image sanitising
export interface Sanitized {
  bytes: Buffer;
  method: NonNullable<UploadState['sanitized']>;
}

/**
 * Remove EXIF (incl. GPS), XMP and IPTC from images before they are stored. Uses sharp when it can be loaded
 * (re-encode; orientation is applied then dropped) and a lossless pure-JS stripper for JPEG/PNG otherwise.
 * GIF carries no EXIF. WebP/AVIF cannot be stripped without sharp: they are then stored as-is and the media reports
 * `metadataStripped: false` instead of pretending.
 */
export async function sanitizeImage(mime: string, input: Buffer): Promise<Sanitized> {
  if (mime === 'image/gif') return { bytes: input, method: 'not_applicable' };
  const sharp = await loadSharp();
  if (sharp) {
    try {
      let img = sharp(input, {
        failOn: 'error',
        animated: mime === 'image/webp',
        limitInputPixels: 100_000_000,
      });
      if (mime === 'image/jpeg' || mime === 'image/png') img = img.rotate();
      if (mime === 'image/jpeg') img = img.jpeg({ quality: 90 });
      else if (mime === 'image/png') img = img.png({ compressionLevel: 6 });
      else if (mime === 'image/webp') img = img.webp({ quality: 90 });
      else img = img.avif({ quality: 60, effort: 2 });
      return { bytes: await img.toBuffer(), method: 'sharp' };
    } catch {
      throw new AppError('unprocessable', 'The image could not be decoded');
    }
  }
  try {
    if (mime === 'image/jpeg')
      return { bytes: Buffer.from(stripJpegMetadata(input)), method: 'js' };
    if (mime === 'image/png') return { bytes: Buffer.from(stripPngMetadata(input)), method: 'js' };
  } catch {
    throw new AppError('unprocessable', 'The image could not be decoded');
  }
  return { bytes: input, method: 'unavailable' };
}

// ------------------------------------------------------------------------------------------------ simple upload
export interface UploadOptions {
  ownerId: string;
  altText?: string | undefined;
  decorative?: boolean | undefined;
  purpose: 'attachment' | 'public';
  /** What the client CLAIMS the file is (form field or part MIME). A contradiction with the sniffed bytes is rejected. */
  declaredKind?: MediaKind | undefined;
}

export async function ingestUpload(
  ctx: AppContext,
  bytes: Buffer,
  o: UploadOptions,
): Promise<MediaRow> {
  if (bytes.length === 0) throw invalid('The file is empty');
  if (bytes.length > SIMPLE_UPLOAD_MAX_BYTES)
    throw httpError(413, 'File too large for a single request: use resumable uploads');
  const sniffed = sniffMedia(bytes.subarray(0, SNIFF_BYTES));
  if (!sniffed) throw httpError(415, 'Unsupported file type');
  if (o.declaredKind && o.declaredKind !== sniffed.kind)
    throw httpError(415, 'The file content does not match the declared type');
  checkKindAndSize(sniffed, bytes.length);
  if (o.purpose === 'public' && sniffed.kind !== 'image')
    throw invalid('Only images can be uploaded with purpose "public"');
  await assertQuota(ctx, o.ownerId, bytes.length);

  let stored = bytes;
  let sanitized: UploadState['sanitized'] = 'not_applicable';
  if (sniffed.kind === 'image') {
    const s = await sanitizeImage(sniffed.mime, bytes);
    stored = s.bytes;
    sanitized = s.method;
  }
  return storeAndRegister(ctx, stored, sniffed, { ...o, sanitized });
}

async function storeAndRegister(
  ctx: AppContext,
  stored: Buffer,
  sniffed: Sniffed,
  o: UploadOptions & { sanitized: UploadState['sanitized'] },
): Promise<MediaRow> {
  const rt = getMediaRuntime(ctx);
  const key = newObjectKey('m', sniffed.ext);
  await rt.adapter.put(key, stored, { contentType: sniffed.mime, size: stored.length });
  try {
    const { rows } = await ctx.db.query<MediaRow>(
      `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, alt_text, alt_text_declined, checksum_sha256, status, purpose, upload_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploaded',$9,$10)
       RETURNING id, owner_id, kind, storage_key, mime_type, size_bytes, width, height, duration_ms, alt_text, alt_text_declined, blurhash, checksum_sha256,
                 status, variants, captions, upload_state, purpose, processing, processing_error, created_at`,
      [
        o.ownerId,
        sniffed.kind,
        key,
        sniffed.mime,
        stored.length,
        normaliseAlt(o.altText),
        Boolean(o.decorative) && !normaliseAlt(o.altText),
        sha256Of(stored),
        o.purpose,
        JSON.stringify({ sanitized: o.sanitized }),
      ],
    );
    ctx.metrics.events.inc({ name: 'media_uploaded' });
    rt.queue.enqueue(rows[0]!.id);
    return rows[0]!;
  } catch (e) {
    await rt.adapter.delete(key).catch(() => undefined);
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ resumable / direct uploads
export interface InitUploadInput extends UploadOptions {
  size: number;
  sha256: string;
  kind: MediaKind;
  mode: 'chunked' | 'direct';
  chunkSize?: number | undefined;
  contentType?: string | undefined;
}

const DIRECT_MIME_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT)
    .filter(([ext]) => ['mp4', 'mov', 'webm', 'mp3', 'm4a', 'ogg', 'wav', 'pdf'].includes(ext))
    .map(([ext, mime]) => [mime, ext]),
);
const KIND_OF_MIME: Record<string, MediaKind> = {
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'application/pdf': 'file',
};

export async function initUpload(ctx: AppContext, i: InitUploadInput) {
  if (i.size > MAX_BYTES[i.kind]) throw httpError(413, `File too large for ${i.kind}`);
  if (i.purpose === 'public' && i.kind !== 'image')
    throw invalid('Only images can be uploaded with purpose "public"');
  await assertQuota(ctx, i.ownerId, i.size);
  const rt = getMediaRuntime(ctx);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_HOURS * 3600_000).toISOString();
  const state: UploadState = {
    mode: i.mode,
    declaredKind: i.kind,
    size: i.size,
    sha256: i.sha256.toLowerCase(),
    expiresAt,
  };
  let storageKey = `u/${id}/final`; // placeholder until the real (sniffed) key is known
  let direct: Awaited<ReturnType<NonNullable<typeof rt.adapter.presignPut>>> | undefined;

  if (i.mode === 'direct') {
    if (!rt.adapter.presignPut)
      throw new AppError(
        'unprocessable',
        'Direct uploads are not available on this deployment: use chunked uploads',
      );
    if (i.kind === 'image')
      throw invalid(
        'Images must be uploaded through the API so that location metadata can be removed',
      );
    const contentType = i.contentType?.toLowerCase();
    const ext = contentType ? DIRECT_MIME_EXT[contentType] : undefined;
    if (!contentType || !ext || KIND_OF_MIME[contentType] !== i.kind)
      throw invalid('contentType must be an allowed type that matches kind');
    storageKey = newObjectKey('m', ext);
    state.contentType = contentType;
    direct = await rt.adapter.presignPut(storageKey, {
      contentType,
      size: i.size,
      sha256Hex: state.sha256!,
      expiresInSec: DIRECT_TTL_SEC,
    });
    state.expiresAt = new Date(Date.now() + DIRECT_TTL_SEC * 1000 + 60_000).toISOString();
  } else {
    const chunkSize = i.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkCount = Math.max(1, Math.ceil(i.size / chunkSize));
    if (chunkCount > MAX_CHUNKS) throw invalid('Chunk size too small for this file');
    state.chunkSize = chunkSize;
    state.chunkCount = chunkCount;
    state.chunks = {};
  }

  await ctx.db.query(
    `INSERT INTO media (id, owner_id, kind, storage_key, mime_type, size_bytes, alt_text, alt_text_declined, status, purpose, upload_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
    [
      id,
      i.ownerId,
      i.kind,
      storageKey,
      state.contentType ?? 'application/octet-stream',
      i.size,
      normaliseAlt(i.altText),
      Boolean(i.decorative) && !normaliseAlt(i.altText),
      i.purpose,
      JSON.stringify(state),
    ],
  );
  return {
    id,
    mode: i.mode,
    status: 'pending' as const,
    size: i.size,
    expiresAt: state.expiresAt!,
    ...(i.mode === 'chunked'
      ? { chunkSize: state.chunkSize!, chunkCount: state.chunkCount! }
      : {
          upload: {
            url: direct!.url,
            method: direct!.method,
            headers: direct!.headers,
            expiresAt: direct!.expiresAt.toISOString(),
          },
        }),
  };
}

async function loadPending(ctx: AppContext, id: string, ownerId: string): Promise<MediaRow> {
  const { rows } = await ctx.db.query<MediaRow>(
    `SELECT ${MEDIA_COLS} FROM media m WHERE m.id = $1 AND m.owner_id = $2 AND m.deleted_at IS NULL`,
    [id, ownerId],
  );
  const r = rows[0];
  if (!r) throw notFound('Upload');
  return r;
}

const expired = (s: UploadState) => !s.expiresAt || new Date(s.expiresAt).getTime() <= Date.now();

export async function uploadStatus(ctx: AppContext, id: string, ownerId: string) {
  const r = await loadPending(ctx, id, ownerId);
  const s = r.upload_state;
  const received = Object.keys(s.chunks ?? {})
    .map(Number)
    .sort((a, b) => a - b);
  const missing: number[] = [];
  for (let n = 0; n < (s.chunkCount ?? 0); n++)
    if (!(String(n) in (s.chunks ?? {}))) missing.push(n);
  return {
    id: r.id,
    status: r.status,
    mode: s.mode ?? 'chunked',
    size: Number(r.size_bytes),
    chunkSize: s.chunkSize ?? null,
    chunkCount: s.chunkCount ?? null,
    received,
    missing,
    expiresAt: s.expiresAt ?? null,
    expired: r.status === 'pending' && expired(s),
  };
}

/** Store one chunk. Idempotent: re-sending a chunk (same or corrected content) is safe and overwrites it. */
export async function putChunk(
  ctx: AppContext,
  id: string,
  ownerId: string,
  n: number,
  data: Buffer,
  claimedSha256?: string,
) {
  const r = await loadPending(ctx, id, ownerId);
  const s = r.upload_state;
  if (r.status !== 'pending' || s.mode !== 'chunked')
    throw conflict('This upload does not accept chunks');
  if (expired(s)) throw new AppError('unprocessable', 'This upload has expired: start a new one');
  if (s.completing) throw conflict('This upload is being finalised');
  const count = s.chunkCount!;
  if (!Number.isInteger(n) || n < 0 || n >= count) throw invalid('Chunk index out of range');
  const expectedLen = n === count - 1 ? s.size! - (count - 1) * s.chunkSize! : s.chunkSize!;
  if (data.length !== expectedLen) throw invalid(`Chunk ${n} must be exactly ${expectedLen} bytes`);
  const sha = sha256Of(data);
  if (claimedSha256 && claimedSha256.toLowerCase() !== sha)
    throw invalid('Chunk checksum mismatch: the data was corrupted in transit, retry this chunk');

  const rt = getMediaRuntime(ctx);
  if (n === 0) {
    // Fail fast on the very first chunk: do not make a client spend bandwidth on a file we would reject.
    const sn = sniffMedia(data.subarray(0, SNIFF_BYTES));
    if (!sn || sn.kind !== s.declaredKind) {
      await abortUpload(ctx, r);
      throw httpError(415, 'Unsupported file type or the content does not match the declared kind');
    }
  }
  const prior = s.chunks?.[String(n)];
  const duplicate = prior?.sha256 === sha && Boolean(await rt.adapter.stat(chunkKey(id, n)));
  if (!duplicate)
    await rt.adapter.put(chunkKey(id, n), data, {
      contentType: 'application/octet-stream',
      size: data.length,
    });
  const upd = await ctx.db.query<{ upload_state: UploadState }>(
    `UPDATE media SET upload_state = jsonb_set(jsonb_set(upload_state, ARRAY['chunks', $3::text], $4::jsonb, true), '{expiresAt}', to_jsonb($5::text)), updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'pending' AND deleted_at IS NULL RETURNING upload_state`,
    [
      id,
      ownerId,
      String(n),
      JSON.stringify({ size: data.length, sha256: sha }),
      new Date(Date.now() + UPLOAD_TTL_HOURS * 3600_000).toISOString(),
    ],
  );
  if (!upd.rowCount) {
    await rt.adapter.delete(chunkKey(id, n)).catch(() => undefined);
    throw conflict('This upload is no longer open');
  }
  const receivedCount = Object.keys(upd.rows[0]!.upload_state.chunks ?? {}).length;
  return {
    index: n,
    duplicate,
    receivedCount,
    chunkCount: count,
    complete: receivedCount === count,
  };
}

async function deleteChunks(ctx: AppContext, r: MediaRow): Promise<void> {
  const rt = getMediaRuntime(ctx);
  const n = r.upload_state.chunkCount ?? 0;
  for (let i = 0; i < n; i++) await rt.adapter.delete(chunkKey(r.id, i)).catch(() => undefined);
}

/** Abort an unfinished upload: remove staged data and the row. */
export async function abortUpload(ctx: AppContext, r: MediaRow): Promise<void> {
  const rt = getMediaRuntime(ctx);
  if (r.upload_state.mode === 'direct' && r.storage_key && !r.storage_key.startsWith('u/'))
    await rt.adapter.delete(r.storage_key).catch(() => undefined);
  await deleteChunks(ctx, r);
  await ctx.db.query(`DELETE FROM media WHERE id = $1 AND status = 'pending'`, [r.id]);
}

export async function completeUpload(
  ctx: AppContext,
  id: string,
  ownerId: string,
): Promise<MediaRow> {
  const first = await loadPending(ctx, id, ownerId);
  if (first.status !== 'pending') return first; // idempotent: a retried "complete" returns the finished media
  const s0 = first.upload_state;
  if (expired(s0)) throw new AppError('unprocessable', 'This upload has expired: start a new one');

  // Claim the finalisation so two concurrent completes cannot both assemble.
  const claim = await ctx.db.query(
    `UPDATE media SET upload_state = jsonb_set(upload_state, '{completing}', 'true'::jsonb), updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'pending' AND COALESCE((upload_state->>'completing')::boolean, false) = false`,
    [id, ownerId],
  );
  if (!claim.rowCount) {
    const again = await loadPending(ctx, id, ownerId);
    if (again.status !== 'pending') return again;
    throw conflict('This upload is already being finalised');
  }
  const release = () =>
    ctx.db
      .query(
        `UPDATE media SET upload_state = upload_state - 'completing' WHERE id = $1 AND status = 'pending'`,
        [id],
      )
      .catch(() => undefined);
  try {
    return s0.mode === 'direct'
      ? await completeDirect(ctx, first)
      : await completeChunked(ctx, first, release);
  } catch (e) {
    await release();
    throw e;
  }
}

async function completeChunked(
  ctx: AppContext,
  r: MediaRow,
  release: () => Promise<unknown>,
): Promise<MediaRow> {
  const s = r.upload_state;
  const rt = getMediaRuntime(ctx);
  const missing: number[] = [];
  for (let n = 0; n < s.chunkCount!; n++) if (!s.chunks?.[String(n)]) missing.push(n);
  if (missing.length)
    throw new AppError('unprocessable', 'Some chunks are missing', {
      missing: missing.slice(0, 200),
    });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'yl-upload-'));
  const file = path.join(tmpDir, 'assembled');
  try {
    // Assemble on disk (never all in memory), hashing as we go.
    const hash = createHash('sha256');
    let total = 0;
    const out = createWriteStream(file);
    for (let n = 0; n < s.chunkCount!; n++) {
      for await (const part of await rt.adapter.read(chunkKey(r.id, n))) {
        const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
        hash.update(buf);
        total += buf.length;
        if (!out.write(buf)) await new Promise<void>((res) => out.once('drain', () => res()));
      }
    }
    await new Promise<void>((res, rej) => {
      out.end(() => res());
      out.on('error', rej);
    });

    if (total !== s.size) {
      await resetChunks(ctx, r);
      throw new AppError(
        'unprocessable',
        'Assembled size does not match the declared size: re-upload the chunks',
        { expected: s.size, actual: total },
      );
    }
    if (hash.digest('hex') !== s.sha256) {
      await resetChunks(ctx, r);
      throw new AppError(
        'unprocessable',
        'Checksum mismatch: the assembled file does not match the declared SHA-256. Re-upload the chunks.',
        { code: 'checksum_mismatch' },
      );
    }

    const fh = await open(file, 'r');
    let head: Buffer;
    try {
      head = Buffer.alloc(Math.min(SNIFF_BYTES, total));
      await fh.read(head, 0, head.length, 0);
    } finally {
      await fh.close();
    }
    const sniffed = sniffMedia(head);
    if (!sniffed || sniffed.kind !== s.declaredKind) {
      await abortUpload(ctx, r);
      throw httpError(415, 'Unsupported file type or the content does not match the declared kind');
    }
    checkKindAndSize(sniffed, total);

    const key = newObjectKey('m', sniffed.ext);
    let storedSize = total;
    let checksum = s.sha256!;
    let sanitized: UploadState['sanitized'] = 'not_applicable';
    if (sniffed.kind === 'image') {
      const clean = await sanitizeImage(sniffed.mime, await readFile(file));
      sanitized = clean.method;
      storedSize = clean.bytes.length;
      checksum = sha256Of(clean.bytes);
      await rt.adapter.put(key, clean.bytes, { contentType: sniffed.mime, size: storedSize });
    } else {
      await rt.adapter.put(key, createReadStream(file), { contentType: sniffed.mime, size: total });
    }
    const done = await ctx.db.query<MediaRow>(
      `UPDATE media SET kind = $2, storage_key = $3, mime_type = $4, size_bytes = $5, checksum_sha256 = $6, status = 'uploaded',
              upload_state = jsonb_build_object('mode','chunked','sanitized',$7::text,'completedAt',now()), updated_at = now()
        WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
        RETURNING id, owner_id, kind, storage_key, mime_type, size_bytes, width, height, duration_ms, alt_text, alt_text_declined, blurhash, checksum_sha256,
                  status, variants, captions, upload_state, purpose, processing, processing_error, created_at`,
      [r.id, sniffed.kind, key, sniffed.mime, storedSize, checksum, sanitized],
    );
    if (!done.rowCount) {
      await rt.adapter.delete(key).catch(() => undefined);
      throw conflict('This upload is no longer open');
    }
    await deleteChunks(ctx, r);
    ctx.metrics.events.inc({ name: 'media_uploaded' });
    rt.queue.enqueue(r.id);
    return done.rows[0]!;
  } finally {
    await release();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function resetChunks(ctx: AppContext, r: MediaRow): Promise<void> {
  await deleteChunks(ctx, r);
  await ctx.db.query(
    `UPDATE media SET upload_state = jsonb_set(upload_state, '{chunks}', '{}'::jsonb) WHERE id = $1 AND status = 'pending'`,
    [r.id],
  );
}

/** Direct-to-storage upload (S3): the bytes never touched the API, so verify what landed in the bucket. */
async function completeDirect(ctx: AppContext, r: MediaRow): Promise<MediaRow> {
  const s = r.upload_state;
  const rt = getMediaRuntime(ctx);
  const st = await rt.adapter.stat(r.storage_key);
  if (!st) throw new AppError('unprocessable', 'The file has not been uploaded yet');
  const reject = async (status: number, msg: string) => {
    await rt.adapter.delete(r.storage_key).catch(() => undefined);
    await ctx.db.query(`DELETE FROM media WHERE id = $1 AND status = 'pending'`, [r.id]);
    return httpError(status, msg);
  };
  if (st.size !== s.size) throw await reject(422, 'Uploaded size does not match the declared size');
  const head = await rt.adapter.readBytes(r.storage_key, {
    start: 0,
    end: Math.min(SNIFF_BYTES, st.size) - 1,
  });
  const sniffed = sniffMedia(head);
  if (!sniffed || sniffed.kind !== s.declaredKind || sniffed.mime !== s.contentType)
    throw await reject(415, 'The uploaded content does not match the declared type');
  checkKindAndSize(sniffed, st.size);
  // SHA-256 was signed into the presigned request, so the object store already refused any other body.
  const done = await ctx.db.query<MediaRow>(
    `UPDATE media SET kind = $2, mime_type = $3, size_bytes = $4, checksum_sha256 = $5, status = 'uploaded',
            upload_state = jsonb_build_object('mode','direct','sanitized','not_applicable','completedAt',now()), updated_at = now()
      WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
      RETURNING id, owner_id, kind, storage_key, mime_type, size_bytes, width, height, duration_ms, alt_text, alt_text_declined, blurhash, checksum_sha256,
                status, variants, captions, upload_state, purpose, processing, processing_error, created_at`,
    [r.id, sniffed.kind, sniffed.mime, st.size, s.sha256],
  );
  if (!done.rowCount) throw conflict('This upload is no longer open');
  ctx.metrics.events.inc({ name: 'media_uploaded' });
  rt.queue.enqueue(r.id);
  return done.rows[0]!;
}

// ------------------------------------------------------------------------------------------------ delete / purge / maintenance
/** Owner deletion: soft-delete now, remove bytes immediately (best effort; `purgeDeletedMedia` sweeps failures). */
export async function deleteMedia(ctx: AppContext, id: string, ownerId: string): Promise<void> {
  const r = await loadPending(ctx, id, ownerId);
  if (r.status === 'pending') return void (await abortUpload(ctx, r));
  await deleteMediaRow(ctx, r);
}

/** System deletion (e.g. expired moments): same as owner deletion without the ownership lookup. No-op if already gone. */
export async function deleteMediaById(ctx: AppContext, id: string): Promise<void> {
  const { rows } = await ctx.db.query<MediaRow>(
    `SELECT ${MEDIA_COLS} FROM media m WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [id],
  );
  if (rows[0]) await deleteMediaRow(ctx, rows[0]);
}

async function deleteMediaRow(ctx: AppContext, r: MediaRow): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await tx.query('UPDATE media SET deleted_at = now(), updated_at = now() WHERE id = $1', [r.id]);
    // Profile images pointing at this media are cleared so nobody keeps a dead URL.
    const url = mediaUrl(ctx.config, r.storage_key);
    await tx.query('UPDATE profiles SET avatar_url = NULL WHERE user_id = $1 AND avatar_url = $2', [
      r.owner_id,
      url,
    ]);
    await tx.query('UPDATE profiles SET cover_url = NULL WHERE user_id = $1 AND cover_url = $2', [
      r.owner_id,
      url,
    ]);
  });
  await purgeOne(ctx, r);
}

async function purgeOne(
  ctx: AppContext,
  r: Pick<MediaRow, 'id' | 'storage_key' | 'variants' | 'captions'>,
): Promise<boolean> {
  const ok = await removeMediaObjects(getMediaRuntime(ctx), r);
  if (ok) await ctx.db.query('UPDATE media SET purged_at = now() WHERE id = $1', [r.id]);
  return ok;
}

/** Remove storage objects of soft-deleted media (also covers rows soft-deleted by account deletion). */
export async function purgeDeletedMedia(ctx: AppContext, limit = 500): Promise<number> {
  const { rows } = await ctx.db.query<MediaRow>(
    `SELECT id, storage_key, variants, captions FROM media m WHERE deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const r of rows) if (await purgeOne(ctx, r)) n++;
  return n;
}

/** Drop expired, never-completed uploads and their staged chunks. */
export async function cleanupExpiredUploads(ctx: AppContext, limit = 500): Promise<number> {
  const { rows } = await ctx.db.query<MediaRow>(
    `SELECT ${MEDIA_COLS} FROM media m WHERE m.status = 'pending' AND (m.upload_state->>'expiresAt')::timestamptz <= now() ORDER BY m.created_at LIMIT $1`,
    [limit],
  );
  for (const r of rows) await abortUpload(ctx, r);
  return rows.length;
}

/** Re-queue media stuck in uploaded/processing (e.g. the process died mid-job). */
export async function recoverStuckMedia(ctx: AppContext, olderThanMinutes = 15): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM media WHERE status IN ('uploaded','processing') AND deleted_at IS NULL AND updated_at < now() - ($1::int || ' minutes')::interval LIMIT 500`,
    [olderThanMinutes],
  );
  const rt = getMediaRuntime(ctx);
  for (const r of rows) rt.queue.enqueue(r.id);
  return rows.length;
}

export async function runMediaMaintenance(ctx: AppContext) {
  const expiredUploads = await cleanupExpiredUploads(ctx);
  const purged = await purgeDeletedMedia(ctx);
  const requeued = await recoverStuckMedia(ctx);
  return { expiredUploads, purged, requeued };
}

// ------------------------------------------------------------------------------------------------ alt text, captions, profile images
export async function updateAlt(
  ctx: AppContext,
  id: string,
  ownerId: string,
  altText: string | null | undefined,
  decorative: boolean | undefined,
): Promise<MediaRow> {
  const r = await loadOwnedMedia(ctx, id, ownerId);
  const alt = altText === undefined ? r.alt_text : normaliseAlt(altText ?? undefined);
  const declined = alt ? false : (decorative ?? r.alt_text_declined);
  await ctx.db.query(
    'UPDATE media SET alt_text = $2, alt_text_declined = $3, updated_at = now() WHERE id = $1',
    [id, alt, declined],
  );
  return { ...r, alt_text: alt, alt_text_declined: declined };
}

export async function setCaptions(
  ctx: AppContext,
  id: string,
  ownerId: string,
  lang: string,
  text: string,
  label: string | undefined,
  kind: 'captions' | 'subtitles',
): Promise<MediaRow> {
  if (!LANG_RE.test(lang)) throw invalid('Invalid language tag');
  const r = await loadOwnedMedia(ctx, id, ownerId);
  if (r.kind !== 'video' && r.kind !== 'audio')
    throw invalid('Captions can only be added to video or audio');
  if (!SERVED.has(r.status)) throw conflict('Media is not available');
  const v = validateVtt(text);
  if (!v.ok) throw new AppError('unprocessable', v.error ?? 'Invalid WebVTT', { cues: v.cues });
  const language = lang.toLowerCase();
  const rt = getMediaRuntime(ctx);
  const key = newObjectKey('c', `${language}.vtt`);
  const body = Buffer.from(v.content!, 'utf8');
  await rt.adapter.put(key, body, { contentType: 'text/vtt; charset=utf-8', size: body.length });
  const entry = {
    lang: language,
    label: label?.trim().slice(0, 60) || language,
    kind,
    key,
    sizeBytes: body.length,
  };
  // Replace any existing track for this language atomically.
  const { rows } = await ctx.db.query<{ captions: MediaRow['captions'] }>(
    `UPDATE media SET captions = COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(captions) c WHERE c->>'lang' <> $2), '[]'::jsonb) || $3::jsonb, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING captions`,
    [id, language, JSON.stringify([entry])],
  );
  const old = r.captions.find((c) => c.lang === language);
  if (old) await rt.adapter.delete(old.key).catch(() => undefined);
  return { ...r, captions: rows[0]!.captions };
}

export async function removeCaptions(
  ctx: AppContext,
  id: string,
  ownerId: string,
  lang: string,
): Promise<void> {
  const r = await loadOwnedMedia(ctx, id, ownerId);
  const language = lang.toLowerCase();
  const old = r.captions.find((c) => c.lang === language);
  if (!old) throw notFound('Caption track');
  await ctx.db.query(
    `UPDATE media SET captions = COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(captions) c WHERE c->>'lang' <> $2), '[]'::jsonb), updated_at = now() WHERE id = $1`,
    [id, language],
  );
  await getMediaRuntime(ctx)
    .adapter.delete(old.key)
    .catch(() => undefined);
}

/** Set (or clear) the profile avatar/cover from an owned, ready image. The media becomes world-readable ('public'). */
export async function setProfileImage(
  ctx: AppContext,
  userId: string,
  which: 'avatar' | 'cover',
  mediaId: string | null,
): Promise<string | null> {
  const col = which === 'avatar' ? 'avatar_url' : 'cover_url';
  return withTransaction(ctx.db, async (tx) => {
    const cur = await tx.query<{ url: string | null }>(
      `SELECT ${col} AS url FROM profiles WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!cur.rows[0]) throw notFound('Profile');
    let url: string | null = null;
    if (mediaId) {
      const { rows } = await tx.query<MediaRow & { attached: boolean }>(
        `SELECT ${MEDIA_COLS},
                (EXISTS (SELECT 1 FROM post_media WHERE media_id = m.id) OR EXISTS (SELECT 1 FROM message_attachments WHERE media_id = m.id)
                 OR EXISTS (SELECT 1 FROM moments WHERE media_id = m.id)) AS attached
           FROM media m WHERE m.id = $1 AND m.owner_id = $2 AND m.deleted_at IS NULL FOR UPDATE`,
        [mediaId, userId],
      );
      const m = rows[0];
      if (!m || m.kind !== 'image') throw invalid('Choose an image you uploaded');
      if (m.status !== 'ready') throw conflict('The image is still being processed');
      // Media attached to a post/moment/message keeps its audience: it must not silently become world-readable.
      if (m.purpose !== 'public') {
        if (m.attached)
          throw invalid('Upload the image with purpose "public" to use it on your profile');
        await tx.query(`UPDATE media SET purpose = 'public', updated_at = now() WHERE id = $1`, [
          mediaId,
        ]);
      }
      url = mediaUrl(ctx.config, m.storage_key);
    }
    await tx.query(`UPDATE profiles SET ${col} = $2 WHERE user_id = $1`, [userId, url]);
    // Retire the previous image if it was our own public media (no other use).
    const prev = cur.rows[0].url;
    if (prev && prev !== url) {
      const base = mediaUrl(ctx.config, '');
      if (prev.startsWith(base)) {
        const key = prev.slice(base.length);
        await tx.query(
          `UPDATE media SET deleted_at = now(), updated_at = now() WHERE storage_key = $1 AND owner_id = $2 AND purpose = 'public' AND deleted_at IS NULL`,
          [key, userId],
        );
      }
    }
    return url;
  });
}

export async function setBlocked(ctx: AppContext, id: string, blocked: boolean): Promise<void> {
  if (blocked) {
    const r = await ctx.db.query(
      `UPDATE media SET status = 'blocked', updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND status <> 'pending'`,
      [id],
    );
    if (!r.rowCount) throw notFound('Media');
  } else {
    const r = await ctx.db.query(
      `UPDATE media SET status = 'uploaded', updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND status = 'blocked'`,
      [id],
    );
    if (!r.rowCount) throw notFound('Blocked media');
    getMediaRuntime(ctx).queue.enqueue(id); // reprocess -> ready
  }
}
