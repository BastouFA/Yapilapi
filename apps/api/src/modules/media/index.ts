import multipart from '@fastify/multipart';
import { z } from 'zod';
import { invalid, notFound } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { canViewMedia } from './access.js';
import { getMediaRuntime } from './runtime.js';
import { serveMedia } from './serve.js';
import {
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  completeUpload,
  deleteMedia,
  ingestUpload,
  initUpload,
  MEDIA_COLS,
  mediaView,
  putChunk,
  removeCaptions,
  setBlocked,
  setCaptions,
  setProfileImage,
  updateAlt,
  uploadStatus,
  httpError,
  type MediaRow,
} from './service.js';
import { MAX_VTT_BYTES } from './vtt.js';
import { KIND_BY_MIME, SIMPLE_UPLOAD_MAX_BYTES } from './sniff.js';
import type { ApiModule } from '../types.js';

export { getMediaRuntime, overrideMediaRuntime } from './runtime.js';
export {
  runMediaMaintenance,
  cleanupExpiredUploads,
  purgeDeletedMedia,
  recoverStuckMedia,
  deleteMedia,
} from './service.js';
export { mediaAccessSql, canViewMedia } from './access.js';

const idParams = z.object({ id: z.uuid() });
const purposeSchema = z.enum(['attachment', 'public']);
const altSchema = z.string().max(1500);
const uploadFields = z.object({
  kind: z.enum(['image', 'video', 'audio', 'file']).optional(),
  altText: altSchema.optional(),
  decorative: z.enum(['true', 'false']).optional(),
  purpose: purposeSchema.optional(),
});
const sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/);
const initBody = z.object({
  kind: z.enum(['image', 'video', 'audio', 'file']),
  size: z.number().int().positive(),
  sha256: sha256Schema,
  mode: z.enum(['chunked', 'direct']).default('chunked'),
  chunkSize: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE).optional(),
  contentType: z.string().max(100).optional(),
  altText: altSchema.optional(),
  decorative: z.boolean().optional(),
  purpose: purposeSchema.default('attachment'),
});

export const mediaModule: ApiModule = {
  name: 'media',
  async register(app, ctx) {
    getMediaRuntime(ctx); // create the adapter eagerly so configuration errors surface at boot
    await app.register(multipart, {
      limits: {
        fileSize: SIMPLE_UPLOAD_MAX_BYTES,
        files: 1,
        fields: 8,
        fieldSize: 8192,
        parts: 12,
      },
    });
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_CHUNK_SIZE },
      (_req, body, done) => done(null, body),
    );
    app.addContentTypeParser(
      'text/vtt',
      { parseAs: 'string', bodyLimit: MAX_VTT_BYTES + 1024 },
      (_req, body, done) => done(null, body),
    );

    registerDeletionHook(async (_ctx, tx, userId) => {
      // Soft-delete; storage objects are removed by the maintenance sweep (`purgeDeletedMedia`).
      await tx.query(
        'UPDATE media SET deleted_at = now(), updated_at = now() WHERE owner_id = $1 AND deleted_at IS NULL',
        [userId],
      );
    });

    // ------------------------------------------------------------------ simple upload (multipart)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/media',
      summary: 'Upload a file (multipart: file, altText?, decorative?, purpose?)',
      tags: ['media'],
      auth: 'user',
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply }) => {
        if (!req.isMultipart()) throw httpError(415, 'Send multipart/form-data with a "file" part');
        const fields: Record<string, string> = {};
        let file: Buffer | null = null;
        let labelled: string | undefined;
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file' || file) {
              part.file.resume();
              throw invalid('Send exactly one part named "file"');
            }
            labelled = part.mimetype;
            file = await part.toBuffer(); // throws 413 if it exceeds the single-request ceiling
          } else fields[part.fieldname] = String(part.value);
        }
        if (!file) throw invalid('Missing "file" part');
        const f = uploadFields.safeParse(fields);
        if (!f.success) throw invalid('Invalid form fields');
        const row = await ingestUpload(ctx, file, {
          ownerId: auth.userId,
          altText: f.data.altText,
          decorative: f.data.decorative === 'true',
          purpose: f.data.purpose ?? 'attachment',
          // The client's claims are never trusted, but a claim that contradicts the bytes is an error, not something to paper over.
          declaredKind: f.data.kind ?? KIND_BY_MIME[(labelled ?? '').toLowerCase()],
        });
        void reply.code(201);
        return mediaView(ctx, row, true);
      },
    });

    // ------------------------------------------------------------------ resumable / direct uploads
    route(app, ctx, {
      method: 'POST',
      url: '/v1/media/uploads',
      summary: 'Start a resumable (chunked) or direct-to-storage upload',
      tags: ['media'],
      auth: 'user',
      body: initBody,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, body, reply }) => {
        const r = await initUpload(ctx, { ownerId: auth.userId, ...body });
        void reply.code(201);
        return r;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/media/uploads/:id',
      summary: 'Which chunks have been received (to resume)',
      tags: ['media'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => uploadStatus(ctx, params.id, auth.userId),
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/media/uploads/:id/chunks/:n',
      summary: 'Upload one chunk (raw bytes; idempotent per chunk; optional X-Chunk-Sha256)',
      tags: ['media'],
      auth: 'user',
      params: z.object({ id: z.uuid(), n: z.coerce.number().int().min(0).max(100_000) }),
      rateLimit: { limit: 6000, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        const body = req.body;
        if (!Buffer.isBuffer(body))
          throw httpError(415, 'Send the chunk as application/octet-stream');
        const h = req.headers['x-chunk-sha256'];
        return putChunk(
          ctx,
          params.id,
          auth.userId,
          params.n,
          body,
          typeof h === 'string' ? h : undefined,
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/media/uploads/:id/complete',
      summary: 'Finish an upload: assemble, verify size and checksum, validate the type',
      tags: ['media'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, params }) =>
        mediaView(ctx, await completeUpload(ctx, params.id, auth.userId), true),
    });

    // ------------------------------------------------------------------ metadata
    route(app, ctx, {
      method: 'GET',
      url: '/v1/media/:id',
      summary: 'Media metadata (owner, or anyone who can see what it is attached to)',
      tags: ['media'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const viewer = auth?.userId ?? null;
        const { rows } = await ctx.db.query<MediaRow>(
          `SELECT ${MEDIA_COLS} FROM media m WHERE m.id = $1 AND m.deleted_at IS NULL`,
          [params.id],
        );
        const m = rows[0];
        if (!m) throw notFound('Media');
        const owner = viewer === m.owner_id;
        if (!owner && !(await canViewMedia(ctx.db, viewer, m.id))) throw notFound('Media');
        return mediaView(ctx, m, owner);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/media/:id',
      summary: 'Set alt text (or mark an image decorative)',
      tags: ['media'],
      auth: 'user',
      params: idParams,
      body: z.object({
        altText: altSchema.nullable().optional(),
        decorative: z.boolean().optional(),
      }),
      rateLimit: { limit: 300, windowSec: 3600, by: 'user' },
      handler: async ({ auth, params, body }) =>
        mediaView(
          ctx,
          await updateAlt(ctx, params.id, auth.userId, body.altText, body.decorative),
          true,
        ),
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/media/:id',
      summary: 'Delete your media (soft-delete + remove from storage)',
      tags: ['media'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 300, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        await deleteMedia(ctx, params.id, auth.userId);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'media.deleted',
            targetType: 'media',
            targetId: params.id,
          },
          req,
        );
      },
    });

    // ------------------------------------------------------------------ captions / subtitles
    const captionParams = z.object({ id: z.uuid(), lang: z.string().min(2).max(20) });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/media/:id/captions/:lang',
      summary: 'Upload a WebVTT caption/subtitle track (text/vtt body, or JSON {content})',
      tags: ['media'],
      auth: 'user',
      params: captionParams,
      query: z.object({
        label: z.string().max(60).optional(),
        kind: z.enum(['captions', 'subtitles']).optional(),
      }),
      body: z.union([
        z.string().max(MAX_VTT_BYTES + 1024),
        z.object({
          content: z.string().max(MAX_VTT_BYTES + 1024),
          label: z.string().max(60).optional(),
          kind: z.enum(['captions', 'subtitles']).optional(),
        }),
      ]),
      rateLimit: { limit: 120, windowSec: 3600, by: 'user' },
      handler: async ({ auth, params, query, body }) => {
        const text = typeof body === 'string' ? body : body.content;
        const label = typeof body === 'string' ? query.label : (body.label ?? query.label);
        const kind =
          (typeof body === 'string' ? query.kind : (body.kind ?? query.kind)) ?? 'captions';
        return mediaView(
          ctx,
          await setCaptions(ctx, params.id, auth.userId, params.lang, text, label, kind),
          true,
        );
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/media/:id/captions/:lang',
      summary: 'Remove a caption track',
      tags: ['media'],
      auth: 'user',
      params: captionParams,
      handler: async ({ auth, params }) => removeCaptions(ctx, params.id, auth.userId, params.lang),
    });

    // ------------------------------------------------------------------ profile images
    for (const which of ['avatar', 'cover'] as const) {
      route(app, ctx, {
        method: 'PUT',
        url: `/v1/profile/${which}`,
        summary: `Set your ${which} from an image you uploaded`,
        tags: ['media', 'profiles'],
        auth: 'user',
        body: z.object({ mediaId: z.uuid() }),
        rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
        handler: async ({ auth, req, body }) => {
          const url = await setProfileImage(ctx, auth.userId, which, body.mediaId);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: `profile.${which}_changed`,
              targetType: 'media',
              targetId: body.mediaId,
            },
            req,
          );
          return { [`${which}Url`]: url };
        },
      });
      route(app, ctx, {
        method: 'DELETE',
        url: `/v1/profile/${which}`,
        summary: `Remove your ${which}`,
        tags: ['media', 'profiles'],
        auth: 'user',
        handler: async ({ auth }) => {
          await setProfileImage(ctx, auth.userId, which, null);
        },
      });
    }

    // ------------------------------------------------------------------ moderation
    route(app, ctx, {
      method: 'POST',
      url: '/v1/admin/media/:id/block',
      summary: 'Block media (never served again until unblocked)',
      tags: ['media', 'moderation'],
      auth: { staff: ['moderator', 'admin', 'superadmin'] },
      params: idParams,
      body: z.object({ reason: z.string().trim().min(3).max(500) }),
      handler: async ({ auth, req, params, body }) => {
        await setBlocked(ctx, params.id, true);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'media.blocked',
            targetType: 'media',
            targetId: params.id,
            metadata: { reason: body.reason },
          },
          req,
        );
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/admin/media/:id/block',
      summary: 'Unblock media (it is reprocessed)',
      tags: ['media', 'moderation'],
      auth: { staff: ['moderator', 'admin', 'superadmin'] },
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await setBlocked(ctx, params.id, false);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'media.unblocked',
            targetType: 'media',
            targetId: params.id,
          },
          req,
        );
      },
    });

    // ------------------------------------------------------------------ serving (local adapter; S3 redirects to signed URLs)
    route(app, ctx, {
      method: 'GET',
      url: '/media/*',
      summary: 'Serve a stored object after an authorization check',
      tags: ['media'],
      auth: 'optional',
      handler: async ({ auth, req, reply }) =>
        serveMedia(ctx, auth?.userId ?? null, req, reply, (req.params as { '*': string })['*']),
    });
  },
};
