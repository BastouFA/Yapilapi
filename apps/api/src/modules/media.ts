import type { FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { detectMedia, SUPPORTED_FORMATS, toWebFormat } from '../lib/media-formats.ts';
import { enqueue } from '../lib/jobs.ts';
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
    const raw = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'too_large', 'Files can be up to 50 MB.');
    // The file's real type comes from its contents, not from its name or the browser's label.
    const detected = detectMedia(raw, file.mimetype);
    if (!detected) throw new AppError(415, 'unsupported_media', `That file type isn't supported. ${SUPPORTED_FORMATS}`);
    const web = await toWebFormat(raw, detected).catch(() => {
      throw new AppError(415, 'unsupported_media', "That file couldn't be read. It may be damaged; try exporting it again.");
    });
    const allowed = { kind: detected.kind };
    const stored = await ctx.storage.put(web.buf, web.ext, web.mime);
    const alt = (file.fields.altText as { value?: string } | undefined)?.value?.slice(0, 500) ?? null;
    const { rows } = await ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms) VALUES ($1,$2,$3,$4,$5,'ready',$6,$7,$8) RETURNING id, kind, url, alt_text`,
      [u.id, allowed.kind, stored.url, web.mime, alt, stored.key, web.buf.length, web.durationMs ?? null],
    );
    await enqueue(ctx.db, 'media.process', { mediaId: rows[0].id, filename: file.filename?.slice(0, 200) ?? null });
    reply.code(201);
    return { media: { id: rows[0].id, kind: rows[0].kind, url: rows[0].url, altText: rows[0].alt_text } };
  });
}
