import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import type { AppContext } from '../../lib/context.js';
import { adminRoute } from '../admin/rbac.js';
import { loadOwnedApp, requireDeveloper } from './apps.js';
import type { DbRow } from '../../lib/db-row.js';

/**
 * Mini apps: third-party experiences listed inside YAPILAPI. Everything is gated by the MINI_APPS feature flag (off by
 * default). What this module provides is the registry, human review workflow, the permission consent model and installs.
 *
 * What it deliberately does NOT provide: the sandboxed runtime (iframe/webview bridge) that would execute a mini app and
 * enforce its granted permissions. Clients own that; this API only records what the developer declared and what each
 * user granted. Until a client runtime exists the flag should stay off.
 */

export const MINI_APP_PERMISSIONS = {
  'profile.basic': 'See your username, display name and avatar.',
  'posts.read_own': 'Read your public posts.',
  'location.coarse': 'See your approximate location (city level) when you allow it.',
} as const;
type MiniAppPermission = keyof typeof MINI_APP_PERMISSIONS;

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'Must be an https URL');
export const manifestSchema = z
  .object({
    entryUrl: httpsUrl,
    iconUrl: httpsUrl.optional(),
    permissions: z
      .array(
        z.enum(Object.keys(MINI_APP_PERMISSIONS) as [MiniAppPermission, ...MiniAppPermission[]]),
      )
      .max(10)
      .default([]),
  })
  .strict();

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'Use 3-40 lowercase letters, numbers or dashes');
const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const versionSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'Use a version like 1.0.0');

const view = (r: DbRow, includeReview = false) => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  version: r.version,
  manifest: r.manifest,
  status: r.status,
  submittedAt: r.submitted_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(includeReview ? { reviewedAt: r.reviewed_at, reviewNote: r.review_note } : {}),
});

const catalogView = (r: DbRow) => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  version: r.version,
  iconUrl: r.manifest?.iconUrl ?? null,
  permissions: ((r.manifest?.permissions ?? []) as string[]).map((p) => ({
    permission: p,
    description: (MINI_APP_PERMISSIONS as Record<string, string>)[p] ?? p,
  })),
  installed: r.installed ?? false,
});

export function registerMiniAppRoutes(app: FastifyInstance, ctx: AppContext): void {
  const flag = (userId: string) => ctx.flags.require('MINI_APPS', userId);

  const loadOwnedMini = async (userId: string, id: string) => {
    const { rows } = await ctx.db.query(
      `SELECT m.* FROM mini_apps m JOIN developer_apps a ON a.id = m.developer_app_id WHERE m.id = $1 AND a.owner_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Mini app');
    return rows[0];
  };

  // ------------------------------------------------------------------ developer side
  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/apps/:id/mini-apps',
    summary: 'Create a mini app draft',
    tags: ['mini-apps'],
    auth: 'user',
    params: idParams,
    body: z.object({
      slug: slugSchema,
      name: z.string().trim().min(2).max(60),
      description: z.string().trim().max(500).default(''),
      version: versionSchema.default('1.0.0'),
      manifest: manifestSchema,
    }),
    rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body, reply }) => {
      await flag(auth.userId);
      requireDeveloper(auth);
      const a = await loadOwnedApp(ctx, auth.userId, params.id);
      if (a.status !== 'active') throw forbidden('This app is suspended');
      const { rows } = await ctx.db.query(
        `INSERT INTO mini_apps (developer_app_id, slug, name, description, version, manifest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          params.id,
          body.slug,
          body.name,
          body.description,
          body.version,
          JSON.stringify(body.manifest),
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'mini_app.created',
          targetType: 'mini_app',
          targetId: rows[0].id,
          metadata: { slug: body.slug },
        },
        req,
      );
      void reply.code(201);
      return view(rows[0], true);
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/apps/:id/mini-apps',
    summary: 'Mini apps of my developer app',
    tags: ['mini-apps'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, params }) => {
      await flag(auth.userId);
      await loadOwnedApp(ctx, auth.userId, params.id);
      const { rows } = await ctx.db.query(
        `SELECT * FROM mini_apps WHERE developer_app_id = $1 ORDER BY created_at DESC`,
        [params.id],
      );
      return { items: rows.map((r) => view(r, true)) };
    },
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/v1/developer/mini-apps/:id',
    summary: 'Edit a draft or rejected mini app (withdraw a published one first)',
    tags: ['mini-apps'],
    auth: 'user',
    params: idParams,
    body: z.object({
      name: z.string().trim().min(2).max(60).optional(),
      description: z.string().trim().max(500).optional(),
      version: versionSchema.optional(),
      manifest: manifestSchema.optional(),
    }),
    handler: async ({ auth, req, params, body }) => {
      await flag(auth.userId);
      requireDeveloper(auth);
      const m = await loadOwnedMini(auth.userId, params.id);
      if (!['draft', 'rejected'].includes(m.status))
        throw conflict(`A mini app that is ${m.status} cannot be edited`);
      const { rows } = await ctx.db.query(
        `UPDATE mini_apps SET name = COALESCE($2, name), description = COALESCE($3, description), version = COALESCE($4, version), manifest = COALESCE($5::jsonb, manifest),
                status = 'draft'
          WHERE id = $1 RETURNING *`,
        [
          params.id,
          body.name ?? null,
          body.description ?? null,
          body.version ?? null,
          body.manifest ? JSON.stringify(body.manifest) : null,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'mini_app.updated',
          targetType: 'mini_app',
          targetId: params.id,
          metadata: { fields: Object.keys(body) },
        },
        req,
      );
      return view(rows[0], true);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/mini-apps/:id/submit',
    summary: 'Submit a mini app for human review',
    tags: ['mini-apps'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, req, params }) => {
      await flag(auth.userId);
      requireDeveloper(auth);
      const m = await loadOwnedMini(auth.userId, params.id);
      const parsed = manifestSchema.safeParse(m.manifest);
      if (!parsed.success) throw invalid('The manifest is not valid');
      const r = await ctx.db.query(
        `UPDATE mini_apps SET status = 'in_review', submitted_at = now(), review_note = NULL WHERE id = $1 AND status IN ('draft','rejected') RETURNING *`,
        [params.id],
      );
      if (!r.rows[0]) throw conflict(`A mini app that is ${m.status} cannot be submitted`);
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'mini_app.submitted',
          targetType: 'mini_app',
          targetId: params.id,
        },
        req,
      );
      return view(r.rows[0], true);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/mini-apps/:id/withdraw',
    summary: 'Pull a mini app back to draft (removes it from the catalog)',
    tags: ['mini-apps'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, req, params }) => {
      await flag(auth.userId);
      const m = await loadOwnedMini(auth.userId, params.id);
      const r = await ctx.db.query(
        `UPDATE mini_apps SET status = 'draft' WHERE id = $1 AND status IN ('in_review','published') RETURNING *`,
        [params.id],
      );
      if (!r.rows[0]) throw conflict(`A mini app that is ${m.status} cannot be withdrawn`);
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'mini_app.withdrawn',
          targetType: 'mini_app',
          targetId: params.id,
        },
        req,
      );
      return view(r.rows[0], true);
    },
  });

  // ------------------------------------------------------------------ staff review
  adminRoute(app, ctx, 'miniapps.review', {
    method: 'GET',
    url: '/v1/staff/mini-apps',
    summary: 'Mini apps awaiting (or past) review',
    tags: ['mini-apps', 'admin'],
    query: pageQuery.extend({
      status: z
        .enum(['draft', 'in_review', 'published', 'rejected', 'suspended'])
        .default('in_review'),
    }),
    handler: async ({ auth, query }) => {
      await flag(auth.userId);
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
      const { rows } = await ctx.db.query(
        `SELECT m.*, m.created_at::text AS created_raw, a.name AS app_name, p.username AS developer
           FROM mini_apps m JOIN developer_apps a ON a.id = m.developer_app_id LEFT JOIN profiles p ON p.user_id = a.owner_id
          WHERE m.status = $1 AND ($2::timestamptz IS NULL OR (m.created_at, m.id) > ($2::timestamptz, $3::uuid))
          ORDER BY m.created_at, m.id LIMIT $4`,
        [query.status, cur?.t ?? null, cur?.id ?? null, limit + 1],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({
          ...view(r, true),
          appName: r.app_name,
          developer: r.developer,
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
      };
    },
  });

  adminRoute(app, ctx, 'miniapps.review', {
    method: 'PUT',
    url: '/v1/staff/mini-apps/:id/review',
    summary: 'Approve, reject, suspend or reinstate a mini app',
    tags: ['mini-apps', 'admin'],
    params: idParams,
    body: z
      .object({
        decision: z.enum(['approve', 'reject', 'suspend', 'reinstate']),
        note: z.string().trim().max(1000).optional(),
      })
      .refine(
        (b) =>
          b.decision === 'approve' || b.decision === 'reinstate' || (b.note && b.note.length >= 3),
        { message: 'A note is required to reject or suspend', path: ['note'] },
      ),
    handler: async ({ auth, req, params, body }) => {
      await flag(auth.userId);
      const FROM: Record<typeof body.decision, [string, string]> = {
        approve: ['in_review', 'published'],
        reject: ['in_review', 'rejected'],
        suspend: ['published', 'suspended'],
        reinstate: ['suspended', 'published'],
      };
      const [from, to] = FROM[body.decision];
      const r = await ctx.db.query(
        `UPDATE mini_apps SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5 WHERE id = $1 AND status = $2 RETURNING *`,
        [params.id, from, to, auth.userId, body.note ?? null],
      );
      if (!r.rows[0]) {
        const { rows } = await ctx.db.query('SELECT status FROM mini_apps WHERE id = $1', [
          params.id,
        ]);
        if (!rows[0]) throw notFound('Mini app');
        throw conflict(`Cannot ${body.decision} a mini app that is ${rows[0].status}`);
      }
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: `mini_app.${body.decision}`,
          targetType: 'mini_app',
          targetId: params.id,
          metadata: { note: body.note },
        },
        req,
      );
      const { rows: owner } = await ctx.db.query(
        `SELECT a.owner_id FROM developer_apps a WHERE a.id = $1`,
        [r.rows[0].developer_app_id],
      );
      if (owner[0])
        await notify(ctx, {
          userId: owner[0].owner_id,
          kind: 'mini_app_review',
          targetType: 'mini_app',
          targetId: params.id,
          data: { decision: body.decision, name: r.rows[0].name },
        });
      return view(r.rows[0], true);
    },
  });

  // ------------------------------------------------------------------ user side
  route(app, ctx, {
    method: 'GET',
    url: '/v1/mini-apps',
    summary: 'Published mini apps',
    tags: ['mini-apps'],
    auth: 'user',
    query: pageQuery,
    handler: async ({ auth, query }) => {
      await flag(auth.userId);
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ n: string; id: string }>(query.cursor);
      const { rows } = await ctx.db.query(
        `SELECT m.*, EXISTS (SELECT 1 FROM mini_app_installs i WHERE i.mini_app_id = m.id AND i.user_id = $1) AS installed
           FROM mini_apps m JOIN developer_apps a ON a.id = m.developer_app_id AND a.status = 'active'
          WHERE m.status = 'published' AND ($2::text IS NULL OR (m.name, m.id) > ($2::text, $3::uuid))
          ORDER BY m.name, m.id LIMIT $4`,
        [auth.userId, cur?.n ?? null, cur?.id ?? null, limit + 1],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map(catalogView),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ n: last.name, id: last.id }) : null,
      };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/mini-apps/installed',
    summary: 'Mini apps I installed',
    tags: ['mini-apps'],
    auth: 'user',
    handler: async ({ auth }) => {
      await flag(auth.userId);
      const { rows } = await ctx.db.query(
        `SELECT m.*, true AS installed, i.granted_permissions, i.installed_at
           FROM mini_app_installs i JOIN mini_apps m ON m.id = i.mini_app_id WHERE i.user_id = $1 ORDER BY i.installed_at DESC`,
        [auth.userId],
      );
      return {
        items: rows.map((r) => ({
          ...catalogView(r),
          status: r.status,
          grantedPermissions: r.granted_permissions,
          installedAt: r.installed_at,
        })),
      };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/mini-apps/:slug',
    summary: 'A published mini app and the permissions it asks for',
    tags: ['mini-apps'],
    auth: 'user',
    params: z.object({ slug: slugSchema }),
    handler: async ({ auth, params }) => {
      await flag(auth.userId);
      const { rows } = await ctx.db.query(
        `SELECT m.*, EXISTS (SELECT 1 FROM mini_app_installs i WHERE i.mini_app_id = m.id AND i.user_id = $2) AS installed
           FROM mini_apps m JOIN developer_apps a ON a.id = m.developer_app_id AND a.status = 'active' WHERE m.slug = $1 AND m.status = 'published'`,
        [params.slug, auth.userId],
      );
      if (!rows[0]) throw notFound('Mini app');
      return catalogView(rows[0]);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/mini-apps/:slug/install',
    summary: 'Install a mini app, granting a chosen subset of its declared permissions',
    tags: ['mini-apps'],
    auth: 'user',
    params: z.object({ slug: slugSchema }),
    body: z.object({ grantedPermissions: z.array(z.string().max(50)).max(10) }),
    rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body, reply }) => {
      await flag(auth.userId);
      if (auth.ageBand !== 'adult')
        throw forbidden('Mini apps are not available for teen accounts');
      const { rows } = await ctx.db.query(
        `SELECT m.id, m.manifest FROM mini_apps m JOIN developer_apps a ON a.id = m.developer_app_id AND a.status = 'active' WHERE m.slug = $1 AND m.status = 'published'`,
        [params.slug],
      );
      if (!rows[0]) throw notFound('Mini app');
      const declared: string[] = rows[0].manifest?.permissions ?? [];
      const granted = [...new Set(body.grantedPermissions)];
      if (!granted.every((p) => declared.includes(p)))
        throw invalid('You can only grant permissions the mini app declares', { declared });
      await ctx.db.query(
        `INSERT INTO mini_app_installs (mini_app_id, user_id, granted_permissions) VALUES ($1,$2,$3)
         ON CONFLICT (mini_app_id, user_id) DO UPDATE SET granted_permissions = EXCLUDED.granted_permissions`,
        [rows[0].id, auth.userId, granted],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'mini_app.installed',
          targetType: 'mini_app',
          targetId: rows[0].id,
          metadata: { granted },
        },
        req,
      );
      void reply.code(201);
      return { installed: true, grantedPermissions: granted };
    },
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/v1/mini-apps/:slug/install',
    summary: 'Uninstall a mini app and drop its permissions',
    tags: ['mini-apps'],
    auth: 'user',
    params: z.object({ slug: slugSchema }),
    handler: async ({ auth, req, params }) => {
      await flag(auth.userId);
      const r = await ctx.db.query(
        `DELETE FROM mini_app_installs i USING mini_apps m WHERE i.mini_app_id = m.id AND m.slug = $1 AND i.user_id = $2 RETURNING m.id`,
        [params.slug, auth.userId],
      );
      if (!r.rows[0]) throw notFound('Installation');
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'mini_app.uninstalled',
          targetType: 'mini_app',
          targetId: r.rows[0].id,
        },
        req,
      );
    },
  });
}
