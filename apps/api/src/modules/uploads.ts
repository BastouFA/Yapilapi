import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { detectMedia, SUPPORTED_FORMATS, toWebFormat } from '../lib/media-formats.ts';
import { enqueue } from '../lib/jobs.ts';
import { isPlus, MAX_RESUMABLE_BYTES, PLUS_MAX_RESUMABLE_BYTES } from '../lib/plus.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export const CHUNK_SIZE = 5 * 1024 * 1024;

/**
 * Resumable uploads for large or flaky-network files (low-bandwidth support):
 *   POST /v1/uploads                   → session with chunk size and count
 *   PUT  /v1/uploads/:id/chunks/:index → one chunk (raw bytes), idempotent
 *   GET  /v1/uploads/:id               → which chunks arrived, so clients resume
 *   POST /v1/uploads/:id/complete      → verify, store, create the media item
 * Sessions expire after 24 hours. Files can be up to 200 MB, or 500 MB with Plus.
 */
export default async function uploadsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const chunkDir = (id: string) => path.resolve(ctx.config.UPLOAD_DIR, '.chunks', id);

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_SIZE + 1024 }, (_req, body, done) => done(null, body));

  async function session(id: string, userId: string) {
    const { rows } = await db.query(`SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2`, [id, userId]);
    const s = rows[0];
    if (!s) throw notFound('Upload');
    if (s.status === 'open' && s.expires_at < new Date()) {
      await db.query(`UPDATE upload_sessions SET status = 'expired' WHERE id = $1`, [id]);
      throw new AppError(410, 'upload_expired', 'This upload expired. Start it again.');
    }
    return s;
  }

  app.post('/v1/uploads', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(z.object({ filename: z.string().trim().min(1).max(200), mime: z.string().max(100), size: z.number().int().positive() }), req.body);
    // The real type is checked from the contents when the upload completes; here only rule out obvious non-media.
    if (input.mime && !/^(image|video|audio)\//.test(input.mime) && !/^application\/(octet-stream|mp4)$/.test(input.mime))
      throw new AppError(415, 'unsupported_media', `That file type isn't supported. ${SUPPORTED_FORMATS}`);
    if (input.size > MAX_RESUMABLE_BYTES) {
      // Plus members can upload bigger files.
      if (!(await isPlus(db, u.id))) throw new AppError(413, 'too_large', 'Files can be up to 200 MB, or 500 MB with YAPILAPI Plus.');
      if (input.size > PLUS_MAX_RESUMABLE_BYTES) throw new AppError(413, 'too_large', 'Files can be up to 500 MB.');
    }
    const total = Math.ceil(input.size / CHUNK_SIZE);
    const { rows } = await db.query(
      `INSERT INTO upload_sessions (user_id, filename, mime, size, chunk_size, total_chunks) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, chunk_size, total_chunks, expires_at`,
      [u.id, input.filename, input.mime, input.size, CHUNK_SIZE, total],
    );
    await mkdir(chunkDir(rows[0].id), { recursive: true });
    reply.code(201);
    return { uploadId: rows[0].id, chunkSize: rows[0].chunk_size, totalChunks: rows[0].total_chunks, expiresAt: rows[0].expires_at };
  });

  app.get('/v1/uploads/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const s = await session(id, me(req).id);
    const missing = Array.from({ length: s.total_chunks }, (_, i) => i).filter((i) => !s.received.includes(i));
    return { uploadId: id, status: s.status, received: s.received, missing, mediaId: s.media_id };
  });

  app.put('/v1/uploads/:id/chunks/:index', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { id, index } = parse(z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }), req.params);
    const s = await session(id, me(req).id);
    if (s.status !== 'open') throw badRequest('This upload is already finished.');
    if (index >= s.total_chunks) throw badRequest('Chunk index is out of range.');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) throw badRequest('Send the chunk as application/octet-stream.');
    const last = index === s.total_chunks - 1;
    const expected = last ? Number(s.size) - index * s.chunk_size : s.chunk_size;
    if (body.length !== expected) throw badRequest(`Chunk ${index} must be ${expected} bytes.`);
    await writeFile(path.join(chunkDir(id), String(index)), body);
    const { rows } = await db.query(
      `UPDATE upload_sessions SET received = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(array_append(received, $2::int)) x) WHERE id = $1 RETURNING received`,
      [id, index],
    );
    return { received: rows[0].received.length, total: s.total_chunks };
  });

  app.post('/v1/uploads/:id/complete', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const alt = parse(z.object({ altText: z.string().max(500).optional() }), req.body ?? {}).altText ?? null;
    const s = await session(id, u.id);
    if (s.status === 'completed')
      return { media: (await db.query(`SELECT id, kind, url, alt_text AS "altText" FROM media WHERE id = $1`, [s.media_id])).rows[0] };
    if (s.received.length !== s.total_chunks) throw badRequest(`${s.total_chunks - s.received.length} chunks are still missing.`);
    const dir = chunkDir(id);
    const parts = (await readdir(dir)).map(Number).sort((a, b) => a - b);
    const data = Buffer.concat(await Promise.all(parts.map((i) => readFile(path.join(dir, String(i))))));
    if (data.length !== Number(s.size)) throw badRequest('The uploaded size does not match.');
    const detected = detectMedia(data, s.mime);
    const web = detected ? await toWebFormat(data, detected).catch(() => null) : null;
    if (!detected || !web) {
      await db.query(`UPDATE upload_sessions SET status = 'failed' WHERE id = $1`, [id]);
      await rm(dir, { recursive: true, force: true });
      throw new AppError(
        415,
        'unsupported_media',
        detected ? "That file couldn't be read. It may be damaged; try exporting it again." : `That file type isn't supported. ${SUPPORTED_FORMATS}`,
      );
    }
    const kind = { kind: detected.kind };
    const stored = await ctx.storage.put(web.buf, web.ext, web.mime);
    const { rows } = await db.query(
      `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms) VALUES ($1,$2,$3,$4,$5,'ready',$6,$7,$8) RETURNING id, kind, url, alt_text AS "altText"`,
      [u.id, kind.kind, stored.url, web.mime, alt, stored.key, web.buf.length, web.durationMs ?? null],
    );
    await db.query(`UPDATE upload_sessions SET status = 'completed', media_id = $2 WHERE id = $1`, [id, rows[0].id]);
    await enqueue(db, 'media.process', { mediaId: rows[0].id });
    await rm(dir, { recursive: true, force: true });
    reply.code(201);
    return { media: rows[0] };
  });
}
