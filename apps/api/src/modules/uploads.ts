import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '@yapilapi/database';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { detectMedia, SUPPORTED_FORMATS, toWebFormat, videoFileToWeb } from '../lib/media-formats.ts';
import { enqueue } from '../lib/jobs.ts';
import { chunkKey } from '../lib/storage.ts';
import { isPlus, MAX_RESUMABLE_BYTES, PLUS_MAX_RESUMABLE_BYTES } from '../lib/plus.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export const CHUNK_SIZE = 5 * 1024 * 1024;

/**
 * Resumable uploads for large or flaky-network files (low-bandwidth support):
 *   POST /v1/uploads                   → session with chunk size and count
 *   PUT  /v1/uploads/:id/chunks/:index → one chunk (raw bytes), idempotent
 *   GET  /v1/uploads/:id               → which chunks arrived, so clients resume
 *   POST /v1/uploads/:id/complete      → verify, store, create the media item
 * Sessions expire after 24 hours. Files can be up to 200 MB, or 500 MB with Plus. Parts are kept in
 * the media storage, so an upload carries on through a deploy or a restart of this server.
 */
export default async function uploadsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const removeChunks = async (id: string, total: number) => {
    for (let i = 0; i < total; i++) await ctx.storage.remove?.(chunkKey(id, i))?.catch(() => {});
  };

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
    reply.code(201);
    return { uploadId: rows[0].id, chunkSize: rows[0].chunk_size, totalChunks: rows[0].total_chunks, expiresAt: rows[0].expires_at };
  });

  app.get('/v1/uploads/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const s = await session(id, me(req).id);
    const missing = Array.from({ length: s.total_chunks }, (_, i) => i).filter((i) => !s.received.includes(i));
    return { uploadId: id, status: s.status, received: s.received, missing, mediaId: s.media_id, chunkSize: s.chunk_size, totalChunks: s.total_chunks };
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
    await ctx.storage.putKey(chunkKey(id, index), body, 'application/octet-stream');
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
    await session(id, u.id);
    // One completion at a time per upload: a retry sent while the first is still running (a slow
    // network, a double tap) waits for it and gets the same media item back instead of a second copy.
    const done = await tx(db, async (c) => {
      const s = (await c.query(`SELECT * FROM upload_sessions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (s.status === 'completed')
        return { again: true, media: (await c.query(`SELECT id, kind, url, alt_text AS "altText" FROM media WHERE id = $1`, [s.media_id])).rows[0] };
      if (s.status !== 'open') throw new AppError(409, 'upload_finished', 'This upload is already finished.');
      if (s.received.length !== s.total_chunks) throw badRequest(`${s.total_chunks - s.received.length} chunks are still missing.`);
      // The parts are put together on disk, so a long video is never all in memory.
      const dir = await mkdtemp(path.join(tmpdir(), 'ypl-upload-'));
      try {
        const whole = path.join(dir, 'whole');
        try {
          for (let i = 0; i < s.total_chunks; i++) {
            const part = path.join(dir, 'part');
            await ctx.storage.download(chunkKey(id, i), part);
            await pipeline(createReadStream(part), createWriteStream(whole, { flags: 'a' }));
          }
        } catch {
          // Parts kept on the disk of a server that has since been replaced (before they went to storage).
          await c.query(`UPDATE upload_sessions SET status = 'failed' WHERE id = $1`, [id]);
          return { error: new AppError(409, 'upload_parts_lost', 'This upload was interrupted. Start it again.') };
        }
        if ((await stat(whole)).size !== Number(s.size)) throw badRequest('The uploaded size does not match.');
        const head = Buffer.alloc(4096);
        const handle = await open(whole, 'r');
        const { bytesRead } = await handle.read(head, 0, head.length, 0).finally(() => handle.close());
        const detected = detectMedia(head.subarray(0, bytesRead), s.mime);
        const unreadable = () => {
          const message = detected
            ? "That file couldn't be read. It may be damaged; try exporting it again."
            : `That file type isn't supported. ${SUPPORTED_FORMATS}`;
          return new AppError(415, 'unsupported_media', message);
        };
        let stored: { key: string; url: string };
        let mime: string;
        let size: number;
        let durationMs: number | null = null;
        if (detected?.kind === 'video') {
          const web = await videoFileToWeb(whole, detected, dir).catch(() => null);
          if (!web) {
            await c.query(`UPDATE upload_sessions SET status = 'failed' WHERE id = $1`, [id]);
            await removeChunks(id, s.total_chunks);
            return { error: unreadable() };
          }
          stored = await ctx.storage.putFile(web.file, web.ext, web.mime);
          mime = web.mime;
          size = (await stat(web.file)).size;
        } else {
          const data = await readFile(whole);
          const web = detected ? await toWebFormat(data, detected).catch(() => null) : null;
          if (!detected || !web) {
            await c.query(`UPDATE upload_sessions SET status = 'failed' WHERE id = $1`, [id]);
            await removeChunks(id, s.total_chunks);
            return { error: unreadable() };
          }
          stored = await ctx.storage.put(web.buf, web.ext, web.mime);
          mime = web.mime;
          size = web.buf.length;
          durationMs = web.durationMs ?? null;
        }
        const { rows } = await c.query(
          `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes, duration_ms) VALUES ($1,$2,$3,$4,$5,'ready',$6,$7,$8) RETURNING id, kind, url, alt_text AS "altText"`,
          [u.id, detected!.kind, stored.url, mime, alt, stored.key, size, durationMs],
        );
        await c.query(`UPDATE upload_sessions SET status = 'completed', media_id = $2 WHERE id = $1`, [id, rows[0].id]);
        await enqueue(c, 'media.process', { mediaId: rows[0].id, filename: s.filename });
        await removeChunks(id, s.total_chunks);
        return { media: rows[0] };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    if (done.error) throw done.error;
    if (done.again) return { media: done.media };
    reply.code(201);
    return { media: done.media };
  });
}
