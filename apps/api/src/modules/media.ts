import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { detectMedia, SUPPORTED_FORMATS, toWebFormat } from '../lib/media-formats.ts';
import { enqueue } from '../lib/jobs.ts';
import { putPrivate } from '../lib/private-files.ts';
import { cleanViewOncePhoto } from '../lib/view-once.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const uploadQuery = z.object({ viewOnce: z.enum(['true', 'false', '1', '0']).optional() });

/**
 * Media upload. Files are type-checked by magic bytes, stored through the
 * MediaStorage adapter, and recorded in `media`. Transcoding and adaptive
 * streaming run behind the same adapter in production (documented in docs/architecture).
 *
 * With ?viewOnce=true the photo or video is for a view-once chat message: it is
 * stored privately (never at a public address, url is empty) and can only be
 * sent with `viewOnce: true`.
 */
export default async function mediaModule(app: FastifyInstance, ctx: AppContext) {
  app.post('/v1/media', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const q = parse(uploadQuery, req.query);
    const viewOnce = q.viewOnce === 'true' || q.viewOnce === '1';
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('Attach a file.');
    const raw = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'too_large', 'Files can be up to 50 MB.');
    // The file's real type comes from its contents, not from its name or the browser's label.
    const detected = detectMedia(raw, file.mimetype);
    if (!detected) throw new AppError(415, 'unsupported_media', `That file type isn't supported. ${SUPPORTED_FORMATS}`);
    if (viewOnce && detected.kind === 'audio') throw new AppError(415, 'unsupported_media', 'Only photos and videos can be sent to view once.');
    const unreadable = () => {
      throw new AppError(415, 'unsupported_media', "That file couldn't be read. It may be damaged; try exporting it again.");
    };
    let web = await toWebFormat(raw, detected).catch(unreadable);
    const alt = (file.fields.altText as { value?: string } | undefined)?.value?.slice(0, 500) ?? null;
    const filename = file.filename?.slice(0, 200) ?? null;

    if (viewOnce) {
      if (detected.kind === 'image') web = await cleanViewOncePhoto(web.buf, web.mime).catch(unreadable);
      const key = await putPrivate(ctx, web.buf, web.ext, web.mime);
      const { rows } = await ctx.db.query(
        `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms, private) VALUES ($1,$2,'',$3,$4,'ready',$5,$6,$7,true) RETURNING id, kind`,
        [u.id, detected.kind, web.mime, alt, key, web.buf.length, web.durationMs ?? null],
      );
      await enqueue(ctx.db, 'media.private', { mediaId: rows[0].id, filename });
      reply.code(201);
      return { media: { id: rows[0].id, kind: rows[0].kind, url: '', altText: alt, viewOnce: true } };
    }

    const stored = await ctx.storage.put(web.buf, web.ext, web.mime);
    const { rows } = await ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms) VALUES ($1,$2,$3,$4,$5,'ready',$6,$7,$8) RETURNING id, kind, url, alt_text`,
      [u.id, detected.kind, stored.url, web.mime, alt, stored.key, web.buf.length, web.durationMs ?? null],
    );
    await enqueue(ctx.db, 'media.process', { mediaId: rows[0].id, filename });
    reply.code(201);
    return { media: { id: rows[0].id, kind: rows[0].kind, url: rows[0].url, altText: rows[0].alt_text } };
  });
}
