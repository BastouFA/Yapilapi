import { z } from 'zod';
import { clampLimit, decodeCursor, encodeCursor, notFound } from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { resolveUser } from '../../lib/users.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { momentVisibleSql } from '../../lib/visibility.js';
import type { ApiModule } from '../types.js';
import {
  MOMENT_VISIBILITIES,
  createMoment,
  deleteMomentAsAuthor,
  loadMomentView,
  loadTray,
  momentFrom,
  momentSelect,
  momentView,
} from './service.js';

export { expireMoments } from './service.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const REACTIONS = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'] as const;

const createBody = z.object({
  kind: z.enum(['photo', 'video', 'text', 'audio']),
  body: z.string().max(2000).default(''),
  mediaId: z.uuid().optional(),
  music: z
    .object({
      title: z.string().trim().min(1).max(120),
      artist: z.string().trim().max(120).optional(),
      provider: z.string().trim().max(40).optional(),
      externalId: z.string().trim().max(120).optional(),
      startMs: z.number().int().min(0).max(3_600_000).optional(),
      durationMs: z.number().int().min(1000).max(60_000).optional(),
    })
    .optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  placeId: z.uuid().optional(),
  visibility: z.enum(MOMENT_VISIBILITIES).optional(),
  circleId: z.uuid().optional(),
  audience: z.array(z.uuid()).max(100).optional(),
  expiry: z.enum(['1h', '24h', 'custom', 'permanent']).default('24h'),
  expiresAt: z.iso
    .datetime()
    .transform((s) => new Date(s))
    .optional(),
});

export const momentsModule: ApiModule = {
  name: 'moments',
  register(app, ctx) {
    registerDeletionHook(async (_ctx, tx, userId) => {
      await tx.query(
        "UPDATE moments SET deleted_at = now(), body = '', music = NULL, latitude = NULL, longitude = NULL WHERE author_id = $1 AND deleted_at IS NULL",
        [userId],
      );
      await tx.query('DELETE FROM moment_views WHERE viewer_id = $1', [userId]);
      await tx.query('DELETE FROM moment_audience WHERE user_id = $1', [userId]);
      // Reactions by the user are removed by the content module's hook (all target types). Media is soft-deleted by the media hook.
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/moments',
      summary: 'Share a moment',
      tags: ['moments'],
      auth: 'user',
      body: createBody,
      rateLimit: { limit: 60, windowSec: 86_400, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        const id = await createMoment(ctx, { userId: auth.userId, ageBand: auth.ageBand }, body);
        ctx.metrics.events.inc({ name: 'moment_created' });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'moment.created',
            targetType: 'moment',
            targetId: id,
            metadata: { visibility: body.visibility ?? 'friends' },
          },
          req,
        );
        void reply.code(201);
        // The author may read their own moment even while it is held for review (it is not visible to anyone else).
        return loadMomentView(ctx, auth.userId, id, { ignoreVisibility: true });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/moments/tray',
      summary: 'Moment tray: live moments from people you follow or are friends with, unseen first',
      tags: ['moments'],
      auth: 'user',
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
      handler: async ({ auth, query }) => loadTray(ctx, auth.userId, query.limit ?? 30),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/moments/:id',
      summary: 'Get a moment',
      tags: ['moments'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const v = await loadMomentView(ctx, auth?.userId ?? null, params.id);
        if (!v) throw notFound('Moment');
        return v;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username/moments',
      summary: "A user's live moments (only those you may see)",
      tags: ['moments'],
      auth: 'optional',
      params: z.object({ username: z.string().min(1).max(40) }),
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const target = await resolveUser(ctx, viewer, params.username);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${momentSelect('$1::uuid')} FROM ${momentFrom}
            WHERE m.author_id = $2 AND ${momentVisibleSql('$1::uuid')}
              AND ($3::timestamptz IS NULL OR (m.created_at, m.id) < ($3::timestamptz, $4::uuid))
            ORDER BY m.created_at DESC, m.id DESC LIMIT $5`,
          [viewer, target.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => momentView(ctx, r, viewer)),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/moments/:id/view',
      summary: 'Mark a moment as viewed',
      tags: ['moments'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 3000, windowSec: 3600, by: 'user' },
      handler: async ({ auth, params }) => {
        const { rows } = await ctx.db.query<{ author_id: string }>(
          `SELECT m.author_id FROM moments m WHERE m.id = $2 AND ${momentVisibleSql('$1::uuid')}`,
          [auth.userId, params.id],
        );
        if (!rows[0]) throw notFound('Moment');
        if (rows[0].author_id === auth.userId) return; // your own moments are not "views"
        await ctx.db.query(
          'INSERT INTO moment_views (moment_id, viewer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [params.id, auth.userId],
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/moments/:id/viewers',
      summary: 'Who viewed your moment (author only)',
      tags: ['moments'],
      auth: 'user',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const own = await ctx.db.query(
          `SELECT 1 FROM moments WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
          [params.id, auth.userId],
        );
        if (!own.rowCount) throw notFound('Moment');
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT v.viewer_id, v.viewed_at, pr.username, pr.display_name, pr.avatar_url,
                  (SELECT r.kind FROM reactions r WHERE r.user_id = v.viewer_id AND r.target_type = 'moment' AND r.target_id = v.moment_id) AS reaction
             FROM moment_views v JOIN profiles pr ON pr.user_id = v.viewer_id JOIN users u ON u.id = v.viewer_id AND u.deleted_at IS NULL
            WHERE v.moment_id = $1
              AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = v.viewer_id) OR (b.blocker_id = v.viewer_id AND b.blocked_id = $2))
              AND ($3::timestamptz IS NULL OR (v.viewed_at, v.viewer_id) < ($3::timestamptz, $4::uuid))
            ORDER BY v.viewed_at DESC, v.viewer_id DESC LIMIT $5`,
          [params.id, auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            user: {
              id: r.viewer_id,
              username: r.username,
              displayName: r.display_name,
              avatarUrl: r.avatar_url,
            },
            viewedAt: (r.viewed_at as Date).toISOString(),
            reaction: r.reaction ?? null,
          })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.viewed_at as Date).toISOString(), id: last.viewer_id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/moments/:id',
      summary: 'Delete your moment (and its media)',
      tags: ['moments'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await deleteMomentAsAuthor(ctx, params.id, auth.userId);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'moment.deleted',
            targetType: 'moment',
            targetId: params.id,
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/moments/:id/reaction',
      summary: 'React to a moment',
      tags: ['moments'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(REACTIONS).default('like') }),
      rateLimit: { limit: 300, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) => {
        const { rows } = await ctx.db.query<{ author_id: string }>(
          `SELECT m.author_id FROM moments m WHERE m.id = $2 AND ${momentVisibleSql('$1::uuid')}`,
          [auth.userId, params.id],
        );
        const m = rows[0];
        if (!m) throw notFound('Moment');
        const inserted = await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query<{ inserted: boolean }>(
            `INSERT INTO reactions (user_id, target_type, target_id, kind) VALUES ($1,'moment',$2,$3)
             ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING (xmax = 0) AS inserted`,
            [auth.userId, params.id, body.kind],
          );
          return r.rows[0]!.inserted;
        });
        if (inserted)
          await notify(ctx, {
            userId: m.author_id,
            kind: 'moment_reaction',
            actorId: auth.userId,
            targetType: 'moment',
            targetId: params.id,
            data: { reaction: body.kind },
          });
        return { reaction: body.kind };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/moments/:id/reaction',
      summary: 'Remove your reaction',
      tags: ['moments'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const vis = await ctx.db.query(
          `SELECT 1 FROM moments m WHERE m.id = $2 AND ${momentVisibleSql('$1::uuid')}`,
          [auth.userId, params.id],
        );
        if (!vis.rowCount) throw notFound('Moment');
        await ctx.db.query(
          `DELETE FROM reactions WHERE user_id = $1 AND target_type = 'moment' AND target_id = $2`,
          [auth.userId, params.id],
        );
      },
    });
  },
};
