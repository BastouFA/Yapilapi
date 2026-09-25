import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { FEATURE_FLAGS, notFound } from '@yapilapi/shared';
import { audit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import { adminRoute } from './rbac.js';
import type { DbRow } from '../../lib/db-row.js';

const keyParams = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Z0-9_]+$/),
});

/**
 * Feature-flag administration. Every change is audited and clears this process's flag cache; other processes pick the
 * change up when their short cache TTL (5 s) expires.
 */
export function registerFlagRoutes(app: FastifyInstance, ctx: AppContext): void {
  const load = async (key: string) => {
    const { rows } = await ctx.db.query(
      'SELECT key, description, enabled, rollout_pct, updated_at FROM feature_flags WHERE key = $1',
      [key],
    );
    if (!rows[0]) throw notFound('Feature flag');
    return rows[0];
  };
  const view = (r: DbRow, overrides?: number) => ({
    key: r.key,
    description: r.description,
    enabled: r.enabled,
    rolloutPct: r.rollout_pct,
    updatedAt: r.updated_at,
    known: (FEATURE_FLAGS as readonly string[]).includes(r.key),
    ...(overrides !== undefined ? { overrides } : {}),
  });

  adminRoute(app, ctx, 'flags.read', {
    method: 'GET',
    url: '/v1/admin/flags',
    summary: 'All feature flags with rollout state',
    tags: ['admin', 'flags'],
    handler: async () => {
      const { rows } = await ctx.db.query(
        `SELECT f.key, f.description, f.enabled, f.rollout_pct, f.updated_at, (SELECT count(*)::int FROM feature_flag_overrides o WHERE o.flag_key = f.key) AS overrides FROM feature_flags f ORDER BY f.key`,
      );
      return { items: rows.map((r) => view(r, r.overrides)) };
    },
  });

  adminRoute(app, ctx, 'flags.write', {
    method: 'PUT',
    url: '/v1/admin/flags/:key',
    summary: 'Turn a flag on/off or change its percentage rollout',
    tags: ['admin', 'flags'],
    params: keyParams,
    body: z
      .object({
        enabled: z.boolean().optional(),
        rolloutPct: z.number().int().min(0).max(100).optional(),
        reason: z.string().trim().min(3).max(300),
      })
      .refine((b) => b.enabled !== undefined || b.rolloutPct !== undefined, {
        message: 'Provide enabled and/or rolloutPct',
      }),
    rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body }) => {
      const before = await load(params.key);
      const { rows } = await ctx.db.query(
        `UPDATE feature_flags SET enabled = COALESCE($2, enabled), rollout_pct = COALESCE($3, rollout_pct) WHERE key = $1 RETURNING key, description, enabled, rollout_pct, updated_at`,
        [params.key, body.enabled ?? null, body.rolloutPct ?? null],
      );
      ctx.flags.invalidate();
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.flag_updated',
          targetType: 'feature_flag',
          targetId: params.key,
          metadata: {
            from: { enabled: before.enabled, rolloutPct: before.rollout_pct },
            to: { enabled: rows[0].enabled, rolloutPct: rows[0].rollout_pct },
            reason: body.reason,
          },
        },
        req,
      );
      return view(rows[0]);
    },
  });

  adminRoute(app, ctx, 'flags.read', {
    method: 'GET',
    url: '/v1/admin/flags/:key/overrides',
    summary: 'Per-user overrides of a flag',
    tags: ['admin', 'flags'],
    params: keyParams,
    handler: async ({ params }) => {
      await load(params.key);
      const { rows } = await ctx.db.query(
        `SELECT o.user_id, o.enabled, p.username FROM feature_flag_overrides o LEFT JOIN profiles p ON p.user_id = o.user_id WHERE o.flag_key = $1 ORDER BY p.username LIMIT 200`,
        [params.key],
      );
      return {
        items: rows.map((r) => ({ userId: r.user_id, username: r.username, enabled: r.enabled })),
      };
    },
  });

  adminRoute(app, ctx, 'flags.write', {
    method: 'PUT',
    url: '/v1/admin/flags/:key/overrides/:userId',
    summary: 'Force a flag on or off for one user (e.g. internal testers)',
    tags: ['admin', 'flags'],
    params: keyParams.extend({ userId: z.uuid() }),
    body: z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(300) }),
    handler: async ({ auth, req, params, body }) => {
      await load(params.key);
      const u = await ctx.db.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [
        params.userId,
      ]);
      if (!u.rowCount) throw notFound('User');
      await ctx.db.query(
        `INSERT INTO feature_flag_overrides (flag_key, user_id, enabled) VALUES ($1,$2,$3) ON CONFLICT (flag_key, user_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [params.key, params.userId, body.enabled],
      );
      ctx.flags.invalidate();
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.flag_override_set',
          targetType: 'feature_flag',
          targetId: params.key,
          metadata: { userId: params.userId, enabled: body.enabled, reason: body.reason },
        },
        req,
      );
      return { key: params.key, userId: params.userId, enabled: body.enabled };
    },
  });

  adminRoute(app, ctx, 'flags.write', {
    method: 'DELETE',
    url: '/v1/admin/flags/:key/overrides/:userId',
    summary: 'Remove a per-user override',
    tags: ['admin', 'flags'],
    params: keyParams.extend({ userId: z.uuid() }),
    handler: async ({ auth, req, params }) => {
      const r = await ctx.db.query(
        'DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND user_id = $2',
        [params.key, params.userId],
      );
      if (!r.rowCount) throw notFound('Override');
      ctx.flags.invalidate();
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.flag_override_removed',
          targetType: 'feature_flag',
          targetId: params.key,
          metadata: { userId: params.userId },
        },
        req,
      );
    },
  });
}
