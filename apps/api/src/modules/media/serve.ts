import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { canViewMedia } from './access.js';
import { MEDIA_COLS, type MediaRow } from './service.js';
import { getMediaRuntime } from './runtime.js';
import { MIME_BY_EXT } from './sniff.js';
import { isSafeKey } from './storage.js';

interface ServedObject {
  mime: string;
  size: number;
  ext: string;
  kind: 'original' | 'variant' | 'caption';
}

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim()); // single range only; anything else is served in full
  if (!m || (m[1] === '' && m[2] === ''))
    return header.startsWith('bytes=') && !header.includes(',') ? 'invalid' : null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // suffix: last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** GET /media/<storage key>: authorize, then stream (local) or redirect to a short-lived signed URL (S3). */
export async function serveMedia(
  ctx: AppContext,
  viewerId: string | null,
  req: FastifyRequest,
  reply: FastifyReply,
  key: string,
): Promise<FastifyReply> {
  // Only opaque server-generated keys are addressable; chunk staging ("u/...") is never served.
  if (!isSafeKey(key) || key.startsWith('u/')) throw notFound('Media');
  const { rows } = await ctx.db.query<MediaRow>(
    `SELECT ${MEDIA_COLS} FROM media m
      WHERE m.deleted_at IS NULL AND (m.storage_key = $1 OR m.variants @> $2::jsonb OR m.captions @> $2::jsonb) LIMIT 1`,
    [key, JSON.stringify([{ key }])],
  );
  const m = rows[0];
  // 404 (never 403) for everything the viewer may not see, including blocked/failed/pending media.
  if (!m || !(await canViewMedia(ctx.db, viewerId, m.id))) throw notFound('Media');

  let obj: ServedObject;
  if (m.storage_key === key)
    obj = {
      mime: m.mime_type,
      size: Number(m.size_bytes),
      ext: key.split('.').pop()!,
      kind: 'original',
    };
  else {
    const v = m.variants.find((x) => x.key === key);
    const c = m.captions.find((x) => x.key === key);
    const ext = key.split('.').pop()!;
    if (v) obj = { mime: v.mime, size: v.sizeBytes, ext, kind: 'variant' };
    else if (c)
      obj = { mime: MIME_BY_EXT.vtt!, size: c.sizeBytes ?? 0, ext: 'vtt', kind: 'caption' };
    else throw notFound('Media');
  }

  const rt = getMediaRuntime(ctx);
  const isPublic = m.purpose === 'public';
  const inline = obj.kind !== 'original' ? obj.kind === 'variant' : m.kind !== 'file';
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="yapilapi-${key.split('/').pop()!.slice(0, 12)}.${obj.ext}"`;
  const cache = isPublic ? 'public, max-age=31536000, immutable' : 'private, max-age=3600';

  void reply.headers({
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': disposition,
    'cache-control': cache,
    ...(isPublic ? {} : { vary: 'Cookie, Authorization' }),
  });

  if (rt.adapter.presignGet) {
    const url = await rt.adapter.presignGet(key, {
      expiresInSec: 300,
      contentType: obj.mime,
      disposition,
    });
    return reply.header('cache-control', 'private, no-store').redirect(url, 302);
  }

  const st = await rt.adapter.stat(key);
  if (!st) throw notFound('Media');
  const size = st.size;
  const etag = `"${createHash('sha256').update(key).digest('hex').slice(0, 32)}"`;
  void reply.headers({ etag, 'accept-ranges': 'bytes', 'content-type': obj.mime });
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();

  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
  if (range) {
    void reply.code(206).headers({
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    });
    return reply.send(await rt.adapter.read(key, range));
  }
  void reply.header('content-length', String(size));
  return reply.send(await rt.adapter.read(key));
}
