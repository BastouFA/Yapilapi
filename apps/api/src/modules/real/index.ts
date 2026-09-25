import { z } from 'zod';
import { clampLimit, decodeCursor, encodeCursor, notFound } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { loadVisiblePost } from '../../lib/visibility.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { registerExportSection } from '../privacy/index.js';
import { authenticityIndicators } from './authenticity.js';
import {
  REAL_VISIBILITIES,
  createCapture,
  deleteCapture,
  getReminders,
  issueCaptureSession,
  loadTray,
  reactToCapture,
  removeReaction,
  setReminders,
  shareCaptureToProfile,
} from './service.js';
import { CAPTURE_FROM, CAPTURE_SELECT, captureView, loadCapture } from './views.js';

export { realVisibleSql, ownRealSql } from './access.js';
export { screenOwnText } from './screen.js';
export {
  computeAuthenticity,
  authenticityIndicators,
  noneAttestationVerifier,
  type AttestationVerifier,
} from './authenticity.js';
export {
  signCaptureToken,
  verifyCaptureToken,
  captureSigningKey,
  hashDeviceId,
  CAPTURE_TOKEN_TTL_MS,
} from './token.js';
export {
  setAttestationVerifier,
  getAttestationVerifier,
  runRealReminders,
  createCapture,
  loadTray,
} from './service.js';
export { mediaLite, mediaCols, loadCapture } from './views.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const REACTIONS = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'] as const;
const EDITS = z.array(z.string().trim().min(1).max(30)).max(10);

const sessionBody = z.object({
  deviceId: z.string().trim().min(8).max(128),
  /** The client's clock (epoch ms) when it asks for the session. Lets the server estimate clock skew honestly. */
  clientTime: z.number().int().positive().optional(),
});
const createBody = z.object({
  captureToken: z.string().min(20).max(1024),
  deviceId: z.string().trim().min(8).max(128),
  frontMediaId: z.uuid().optional(),
  rearMediaId: z.uuid().optional(),
  caption: z.string().max(500).default(''),
  capturedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  visibility: z.enum(REAL_VISIBILITIES).default('friends'),
  circleId: z.uuid().optional(),
  audience: z.array(z.uuid()).max(100).optional(),
  edits: EDITS.optional(),
  attestation: z.string().max(8192).optional(),
});
const shareBody = z.object({
  visibility: z.enum(['public', 'followers', 'friends', 'circle', 'selected', 'private']),
  circleId: z.uuid().optional(),
  audience: z.array(z.uuid()).max(100).optional(),
  body: z.string().max(2000).optional(),
  include: z.enum(['both', 'front', 'rear']).default('both'),
  includeLocation: z.boolean().default(false),
});
const reminderBody = z.object({
  enabled: z.boolean(),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  localMinute: z
    .number()
    .int()
    .min(0)
    .max(1439)
    .default(18 * 60),
  timezone: z.string().min(1).max(64).default('UTC'),
});

export const realModule: ApiModule = {
  name: 'real',
  register(app, ctx: AppContext) {
    const gate = (userId: string) => ctx.flags.require('REAL', userId);
    const W = { limit: 60, windowSec: 3600, by: 'user' } as const;
    const R = { limit: 600, windowSec: 600, by: 'user' } as const;

    registerExportSection({
      key: 'real',
      description:
        'Your Real captures with their authenticity receipts, your reactions and reminder settings',
      collect: async (_c, db, u) => ({
        captures: (
          await db.query(
            `SELECT id, caption, latitude, longitude, captured_at, received_at, authenticity, visibility, shared_post_id, front_media_id, rear_media_id
             FROM real_captures WHERE author_id = $1 AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT 20000`,
            [u],
          )
        ).rows,
        reactions: (
          await db.query(
            'SELECT capture_id, kind, created_at FROM real_reactions WHERE user_id = $1',
            [u],
          )
        ).rows,
        reminders:
          (
            await db.query(
              'SELECT enabled, days, local_minute, timezone FROM real_reminder_settings WHERE user_id = $1',
              [u],
            )
          ).rows[0] ?? null,
      }),
    });
    registerDeletionHook(async (_c, tx, userId) => {
      // The core privacy hook already blanks captions/locations and soft-deletes captures; finish the module-owned rest.
      await tx.query(
        'DELETE FROM real_reactions WHERE user_id = $1 OR capture_id IN (SELECT id FROM real_captures WHERE author_id = $1)',
        [userId],
      );
      await tx.query('DELETE FROM real_reminder_settings WHERE user_id = $1', [userId]);
      await tx.query(
        'DELETE FROM real_capture_audience WHERE user_id = $1 OR capture_id IN (SELECT id FROM real_captures WHERE author_id = $1)',
        [userId],
      );
      await tx.query('DELETE FROM real_capture_sessions WHERE user_id = $1', [userId]);
      await tx.query(
        `DELETE FROM memory_items WHERE item_type = 'real_capture' AND item_id IN (SELECT id FROM real_captures WHERE author_id = $1)`,
        [userId],
      );
      await tx.query(
        'UPDATE shared_experience_contributions SET deleted_at = COALESCE(deleted_at, now()) WHERE real_capture_id IN (SELECT id FROM real_captures WHERE author_id = $1)',
        [userId],
      );
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/real/capture-sessions',
      summary:
        'Start a capture: returns a short-lived, single-use token bound to your account and device',
      tags: ['real'],
      auth: 'user',
      body: sessionBody,
      rateLimit: { limit: 120, windowSec: 3600, by: 'user' },
      handler: async ({ auth, body, reply }) => {
        await gate(auth.userId);
        void reply.code(201);
        return issueCaptureSession(ctx, auth.userId, body);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/real/captures',
      summary:
        'Save a Real (front and/or rear capture) with a server-computed authenticity receipt',
      tags: ['real'],
      auth: 'user',
      body: createBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const id = await createCapture(ctx, { userId: auth.userId, ageBand: auth.ageBand }, body);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'real.created',
            targetType: 'real_capture',
            targetId: id,
            metadata: { visibility: body.visibility },
          },
          req,
        );
        void reply.code(201);
        return (await loadCapture(ctx, auth.userId, id))!;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/real/captures',
      summary: 'My Reals, newest first',
      tags: ['real'],
      auth: 'user',
      query: pageQuery,
      rateLimit: R,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${CAPTURE_SELECT('$1::uuid')} FROM ${CAPTURE_FROM}
            WHERE r.author_id = $1 AND r.deleted_at IS NULL AND ($2::timestamptz IS NULL OR (r.captured_at, r.id) < ($2::timestamptz, $3::uuid))
            ORDER BY r.captured_at DESC, r.id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => captureView(ctx, r, auth.userId)),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.captured_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/real/tray',
      summary: "Friends' Reals from the last 48 hours (no unread counts, no pressure)",
      tags: ['real'],
      auth: 'user',
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
      rateLimit: R,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        return loadTray(ctx, auth.userId, query.limit ?? 30);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/real/reminders',
      summary: 'My Real reminder settings (off by default)',
      tags: ['real'],
      auth: 'user',
      rateLimit: R,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        return getReminders(ctx, auth.userId);
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/real/reminders',
      summary:
        'Opt in to (or out of) a gentle reminder on days and a time you choose. Quiet hours are respected.',
      tags: ['real'],
      auth: 'user',
      body: reminderBody,
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        await gate(auth.userId);
        const r = await setReminders(ctx, auth.userId, body);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'real.reminders_updated',
            targetType: 'user',
            targetId: auth.userId,
            metadata: { enabled: r.enabled },
          },
          req,
        );
        return r;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/real/captures/:id',
      summary: 'A Real (404 unless you may see it)',
      tags: ['real'],
      auth: 'optional',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('REAL');
        const v = await loadCapture(ctx, auth?.userId ?? null, params.id);
        if (!v) throw notFound('Real');
        return v;
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/real/captures/:id',
      summary: 'Delete my Real (removes its media, its place in shared experiences and memories)',
      tags: ['real'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await deleteCapture(ctx, auth.userId, params.id, req);
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/real/captures/:id/reaction',
      summary: 'React to a Real',
      tags: ['real'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(REACTIONS).default('like') }),
      rateLimit: { limit: 300, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        return reactToCapture(ctx, auth.userId, params.id, body.kind);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/real/captures/:id/reaction',
      summary: 'Remove my reaction',
      tags: ['real'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        await removeReaction(ctx, auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/real/captures/:id/share',
      summary:
        'Share my Real to my profile as a post (explicit; you choose the audience). The post carries the authenticity receipt.',
      tags: ['real'],
      auth: 'user',
      params: idParams,
      body: shareBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const postId = await shareCaptureToProfile(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          params.id,
          body,
          req,
        );
        void reply.code(201);
        return { postId };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/real/posts/:id',
      summary:
        'The authenticity receipt of a post that was shared from a Real (404 unless you may see the post)',
      tags: ['real'],
      auth: 'optional',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('REAL');
        const post = await loadVisiblePost<{
          metadata: {
            real?: { captureId: string; capturedAt: string; authenticity: Record<string, unknown> };
          };
        }>(ctx.db, auth?.userId ?? null, params.id);
        if (!post) throw notFound('Post');
        const real = post.metadata?.real;
        return real
          ? {
              postId: params.id,
              real: {
                captureId: real.captureId,
                capturedAt: real.capturedAt,
                authenticity: real.authenticity,
                indicators: authenticityIndicators(real.authenticity),
              },
            }
          : { postId: params.id, real: null };
      },
    });
  },
};
