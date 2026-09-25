import type { FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { ALLOWED_MIME, sniffMatches } from '../lib/storage.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Media upload. Files are type-checked by magic bytes, stored through the
 * MediaStorage adapter, and recorded in `media`. Transcoding and adaptive
 * streaming run behind the same adapter in production (documented in docs/architecture).
 */
export default async function mediaModule(app: FastifyInstance, ctx: AppContext) {
  app.post('/v1/media', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('Attach a file.');
    const allowed = ALLOWED_MIME[file.mimetype];
    if (!allowed) throw new AppError(415, 'unsupported_media', 'Upload a JPEG, PNG, WebP, GIF, MP4, WebM, MP3 or M4A file.');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'too_large', 'Files can be up to 50 MB.');
    if (!sniffMatches(buf, file.mimetype)) throw new AppError(415, 'unsupported_media', "That file's contents don't match its type.");
    const stored = await ctx.storage.put(buf, allowed.ext, file.mimetype);
    const alt = (file.fields.altText as { value?: string } | undefined)?.value?.slice(0, 500) ?? null;
    const { rows } = await ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes) VALUES ($1,$2,$3,$4,$5,'ready',$6,$7) RETURNING id, kind, url, alt_text`,
      [u.id, allowed.kind, stored.url, file.mimetype, alt, stored.key, buf.length],
    );
    reply.code(201);
    return { media: { id: rows[0].id, kind: rows[0].kind, url: rows[0].url, altText: rows[0].alt_text } };
  });
}
