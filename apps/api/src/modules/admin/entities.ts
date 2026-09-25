import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { clampLimit, conflict, decodeCursor, encodeCursor, notFound } from '@yapilapi/shared';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import type { AppContext } from '../../lib/context.js';
import { adminRoute } from './rbac.js';
import {
  loadTargetForStaff,
  REPORT_TARGET_TYPES,
  type ReportTargetType,
} from '../safety/targets.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Content types staff may open by id. Private messages are deliberately excluded: they are reachable only as evidence attached to a report. */
const LOOKUP_TYPES = REPORT_TARGET_TYPES.filter((t) => t !== 'message' && t !== 'user');

export function registerAdminEntityRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ------------------------------------------------------------------ content lookup
  adminRoute(app, ctx, 'content.read', {
    method: 'GET',
    url: '/v1/admin/content/:type/:id',
    summary:
      'Look up a piece of content by id (evidence snapshot, owner, moderation state; never private messages)',
    tags: ['admin'],
    params: z.object({ type: z.enum(LOOKUP_TYPES as [string, ...string[]]), id: z.uuid() }),
    handler: async ({ auth, req, params }) => {
      const found = await loadTargetForStaff(ctx.db, params.type as ReportTargetType, params.id);
      if (!found) throw notFound('Content');
      const cases = await ctx.db.query(
        `SELECT id, state, risk_level, categories, decision, created_at FROM moderation_cases WHERE target_type = $1 AND target_id = $2 ORDER BY created_at DESC LIMIT 10`,
        [params.type, params.id],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.content_viewed',
          targetType: params.type,
          targetId: params.id,
        },
        req,
      );
      return {
        type: params.type,
        id: params.id,
        ownerId: found.subjectUserId,
        snapshot: found.snapshot,
        cases: cases.rows,
      };
    },
  });

  // ------------------------------------------------------------------ communities
  adminRoute(app, ctx, 'communities.read', {
    method: 'GET',
    url: '/v1/admin/communities',
    summary: 'Communities (including suspended ones)',
    tags: ['admin'],
    query: pageQuery.extend({
      q: z.string().trim().min(1).max(80).optional(),
      suspended: z.enum(['true', 'false']).optional(),
    }),
    handler: async ({ query }) => {
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
      const { rows } = await ctx.db.query(
        `SELECT c.id, c.slug::text AS slug, c.name, c.visibility, c.member_count, c.created_by, c.created_at, c.created_at::text AS created_raw, c.deleted_at
           FROM communities c
          WHERE ($1::text IS NULL OR c.name ILIKE $1 ESCAPE '\\' OR c.slug::text ILIKE $1 ESCAPE '\\')
            AND ($2::boolean IS NULL OR (c.deleted_at IS NOT NULL) = $2)
            AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid))
          ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`,
        [
          query.q ? like(query.q) : null,
          query.suspended === undefined ? null : query.suspended === 'true',
          cur?.t ?? null,
          cur?.id ?? null,
        ],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          visibility: r.visibility,
          memberCount: r.member_count,
          ownerId: r.created_by,
          createdAt: r.created_at,
          suspended: r.deleted_at !== null,
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
      };
    },
  });

  adminRoute(app, ctx, 'communities.suspend', {
    method: 'POST',
    url: '/v1/admin/communities/:id/suspend',
    summary: 'Suspend a community (it disappears for everyone; reversible)',
    tags: ['admin'],
    params: idParams,
    body: reasonBody,
    rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body }) => {
      const r = await ctx.db.query(
        'UPDATE communities SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING created_by, name',
        [params.id],
      );
      if (!r.rows[0]) {
        const ex = await ctx.db.query('SELECT 1 FROM communities WHERE id = $1', [params.id]);
        if (!ex.rowCount) throw notFound('Community');
        throw conflict('This community is already suspended');
      }
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.community_suspended',
          targetType: 'community',
          targetId: params.id,
          metadata: { reason: body.reason },
        },
        req,
      );
      await notify(ctx, {
        userId: r.rows[0].created_by,
        kind: 'community_suspended',
        actorId: null,
        targetType: 'community',
        targetId: params.id,
        data: { reason: body.reason, name: r.rows[0].name },
      });
      return { id: params.id, suspended: true };
    },
  });

  adminRoute(app, ctx, 'communities.suspend', {
    method: 'POST',
    url: '/v1/admin/communities/:id/restore',
    summary: 'Restore a suspended community',
    tags: ['admin'],
    params: idParams,
    body: reasonBody,
    handler: async ({ auth, req, params, body }) => {
      const r = await ctx.db.query(
        'UPDATE communities SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING created_by, name',
        [params.id],
      );
      if (!r.rows[0]) throw notFound('Suspended community');
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.community_restored',
          targetType: 'community',
          targetId: params.id,
          metadata: { reason: body.reason },
        },
        req,
      );
      await notify(ctx, {
        userId: r.rows[0].created_by,
        kind: 'community_restored',
        actorId: null,
        targetType: 'community',
        targetId: params.id,
        data: { name: r.rows[0].name },
      });
      return { id: params.id, suspended: false };
    },
  });

  // ------------------------------------------------------------------ businesses (actions live in the business module: /v1/staff/businesses/...)
  adminRoute(app, ctx, 'businesses.read', {
    method: 'GET',
    url: '/v1/admin/businesses',
    summary: 'Businesses with verification and status (verify/suspend via /v1/staff/businesses/*)',
    tags: ['admin'],
    query: pageQuery.extend({
      q: z.string().trim().min(1).max(80).optional(),
      status: z.enum(['pending', 'active', 'suspended', 'closed']).optional(),
      verified: z.enum(['true', 'false']).optional(),
    }),
    handler: async ({ query }) => {
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
      const { rows } = await ctx.db.query(
        `SELECT b.id, b.slug::text AS slug, b.name, b.category, b.status, b.verified_at, b.owner_id, b.created_at, b.created_at::text AS created_raw
           FROM businesses b
          WHERE b.deleted_at IS NULL AND ($1::text IS NULL OR b.name ILIKE $1 ESCAPE '\\' OR b.slug::text ILIKE $1 ESCAPE '\\') AND ($2::text IS NULL OR b.status = $2)
            AND ($3::boolean IS NULL OR (b.verified_at IS NOT NULL) = $3)
            AND ($4::timestamptz IS NULL OR (b.created_at, b.id) < ($4::timestamptz, $5::uuid))
          ORDER BY b.created_at DESC, b.id DESC LIMIT ${limit + 1}`,
        [
          query.q ? like(query.q) : null,
          query.status ?? null,
          query.verified === undefined ? null : query.verified === 'true',
          cur?.t ?? null,
          cur?.id ?? null,
        ],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          category: r.category,
          status: r.status,
          verified: r.verified_at !== null,
          ownerId: r.owner_id,
          createdAt: r.created_at,
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
      };
    },
  });

  // ------------------------------------------------------------------ creators
  adminRoute(app, ctx, 'creators.read', {
    method: 'GET',
    url: '/v1/admin/creators',
    summary: 'Creator accounts',
    tags: ['admin'],
    query: pageQuery.extend({
      status: z.enum(['active', 'suspended', 'closed']).optional(),
      kyc: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional(),
    }),
    handler: async ({ query }) => {
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
      const { rows } = await ctx.db.query(
        `SELECT c.user_id, c.status, c.kyc_status, c.category, c.created_at, c.created_at::text AS created_raw, p.username, p.follower_count
           FROM creators c LEFT JOIN profiles p ON p.user_id = c.user_id
          WHERE ($1::text IS NULL OR c.status = $1) AND ($2::text IS NULL OR c.kyc_status = $2)
            AND ($3::timestamptz IS NULL OR (c.created_at, c.user_id) < ($3::timestamptz, $4::uuid))
          ORDER BY c.created_at DESC, c.user_id DESC LIMIT ${limit + 1}`,
        [query.status ?? null, query.kyc ?? null, cur?.t ?? null, cur?.id ?? null],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({
          userId: r.user_id,
          username: r.username,
          status: r.status,
          kycStatus: r.kyc_status,
          category: r.category,
          followers: r.follower_count,
          createdAt: r.created_at,
        })),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ t: last.created_raw, id: last.user_id })
            : null,
      };
    },
  });

  for (const action of ['suspend', 'reinstate'] as const) {
    adminRoute(app, ctx, 'creators.suspend', {
      method: 'POST',
      url: `/v1/admin/creators/:id/${action}`,
      summary: `${action === 'suspend' ? 'Suspend' : 'Reinstate'} a creator's monetisation (the person's account is unaffected)`,
      tags: ['admin'],
      params: idParams,
      body: reasonBody,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        const to = action === 'suspend' ? 'suspended' : 'active';
        const from = action === 'suspend' ? 'active' : 'suspended';
        const r = await ctx.db.query(
          'UPDATE creators SET status = $2 WHERE user_id = $1 AND status = $3 RETURNING user_id',
          [params.id, to, from],
        );
        if (!r.rows[0]) {
          const ex = await ctx.db.query('SELECT status FROM creators WHERE user_id = $1', [
            params.id,
          ]);
          if (!ex.rows[0]) throw notFound('Creator');
          throw conflict(`This creator is ${ex.rows[0].status}`);
        }
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: `admin.creator_${action === 'suspend' ? 'suspended' : 'reinstated'}`,
            targetType: 'creator',
            targetId: params.id,
            metadata: { reason: body.reason },
          },
          req,
        );
        await notify(ctx, {
          userId: params.id,
          kind: action === 'suspend' ? 'creator_suspended' : 'creator_reinstated',
          actorId: null,
          data: { reason: body.reason },
        });
        return { id: params.id, status: to };
      },
    });
  }
}
