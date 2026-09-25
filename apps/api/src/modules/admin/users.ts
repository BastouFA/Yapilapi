import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  PLATFORM_ROLES,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  notFound,
  type PlatformRole,
} from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import type { AppContext } from '../../lib/context.js';
import {
  adminRoute,
  outranks,
  PERMISSION_MATRIX,
  roleHas,
  STAFF_ROLES,
  ROLE_RANK,
} from './rbac.js';
import {
  applySuspension,
  reinstateIfClear,
  revokeAllAccess,
  APPEAL_WINDOW_DAYS,
} from '../safety/service.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const reasonSchema = z.string().trim().min(3).max(500);

/** o***@gmail.com : enough for support to confirm they have the right account, not enough to harvest addresses. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface Target {
  id: string;
  role: PlatformRole;
  status: string;
  email: string;
  mfaEnabled: boolean;
  ageBand: string;
}
async function loadTarget(ctx: AppContext, id: string, lock = false): Promise<Target> {
  const { rows } = await ctx.db.query(
    `SELECT id, platform_role, status, email::text AS email, mfa_enabled, age_band FROM users WHERE id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('User');
  return {
    id: rows[0].id,
    role: rows[0].platform_role,
    status: rows[0].status,
    email: rows[0].email,
    mfaEnabled: rows[0].mfa_enabled,
    ageBand: rows[0].age_band,
  };
}

export function registerAdminUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  route(app, ctx, {
    method: 'GET',
    url: '/v1/admin/me',
    summary: "The signed-in staff member's role and permissions",
    tags: ['admin'],
    auth: { staff: STAFF_ROLES },
    handler: ({ auth }) => ({
      userId: auth.userId,
      role: auth.platformRole,
      permissions: [...PERMISSION_MATRIX[auth.platformRole]].sort(),
    }),
  });

  adminRoute(app, ctx, 'users.read', {
    method: 'GET',
    url: '/v1/admin/users',
    summary: 'Find users by username prefix, exact email or id',
    tags: ['admin'],
    query: pageQuery.extend({
      q: z.string().trim().min(2).max(120),
      status: z
        .enum(['active', 'suspended', 'deactivated', 'pending_deletion', 'deleted'])
        .optional(),
      role: z.enum(PLATFORM_ROLES).optional(),
    }),
    handler: async ({ auth, req, query }) => {
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
      const isEmail = query.q.includes('@');
      const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.q);
      const match = isId
        ? 'u.id = $5::uuid'
        : isEmail
          ? 'u.email = $5::citext'
          : `p.username::text ILIKE $5 ESCAPE '\\'`;
      const { rows } = await ctx.db.query(
        `SELECT u.id, u.email::text AS email, u.status, u.platform_role, u.age_band, u.created_at, u.created_at::text AS created_raw, p.username, p.display_name
           FROM users u LEFT JOIN profiles p ON p.user_id = u.id
          WHERE ${match} AND ($1::text IS NULL OR u.status = $1) AND ($2::text IS NULL OR u.platform_role = $2)
            AND ($3::timestamptz IS NULL OR (u.created_at, u.id) < ($3::timestamptz, $4::uuid))
          ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit + 1}`,
        [
          query.status ?? null,
          query.role ?? null,
          cur?.t ?? null,
          cur?.id ?? null,
          isId || isEmail ? query.q : `${escapeLike(query.q)}%`,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.user_search',
          metadata: {
            kind: isId ? 'id' : isEmail ? 'email' : 'username',
            results: Math.min(rows.length, limit),
          },
        },
        req,
      );
      const pii = roleHas(auth.platformRole, 'users.read_pii');
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          status: r.status,
          role: r.platform_role,
          ageBand: r.age_band,
          createdAt: r.created_at,
          email: pii ? r.email : maskEmail(r.email),
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
      };
    },
  });

  adminRoute(app, ctx, 'users.read', {
    method: 'GET',
    url: '/v1/admin/users/:id',
    summary: 'One account: status, enforcement history, counts (email masked below admin)',
    tags: ['admin'],
    params: idParams,
    handler: async ({ auth, req, params }) => {
      const { rows } = await ctx.db.query(
        `SELECT u.id, u.email::text AS email, u.email_verified_at, u.status, u.platform_role, u.age_band, u.mfa_enabled, u.created_at, u.last_login_at, u.deletion_scheduled_for, u.country_code,
                p.username, p.display_name, p.is_private, p.follower_count,
                (SELECT count(*)::int FROM posts WHERE author_id = u.id AND deleted_at IS NULL) AS posts,
                (SELECT count(*)::int FROM comments WHERE author_id = u.id AND deleted_at IS NULL) AS comments,
                (SELECT count(*)::int FROM sessions WHERE user_id = u.id AND revoked_at IS NULL AND expires_at > now()) AS active_sessions,
                (SELECT count(*)::int FROM reports r JOIN report_cases rc ON rc.report_id = r.id JOIN moderation_cases mc ON mc.id = rc.case_id WHERE mc.subject_user_id = u.id) AS reports_against,
                (SELECT count(*)::int FROM admin_user_notes WHERE user_id = u.id) AS notes
           FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
        [params.id],
      );
      const r = rows[0];
      if (!r) throw notFound('User');
      const enforcements = await ctx.db.query(
        `SELECT id, kind, reason, starts_at, ends_at, revoked_at, created_by, strike_points FROM enforcements WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [params.id],
      );
      const pii = roleHas(auth.platformRole, 'users.read_pii');
      // Looking at an account is itself an auditable act; seeing unmasked contact data doubly so.
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: pii ? 'admin.user_viewed_pii' : 'admin.user_viewed',
          targetType: 'user',
          targetId: params.id,
        },
        req,
      );
      return {
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        status: r.status,
        role: r.platform_role,
        ageBand: r.age_band,
        mfaEnabled: r.mfa_enabled,
        email: pii ? r.email : maskEmail(r.email),
        emailVerified: r.email_verified_at !== null,
        countryCode: pii ? r.country_code : null,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
        deletionScheduledFor: r.deletion_scheduled_for,
        private: r.is_private,
        followers: r.follower_count,
        counts: {
          posts: r.posts,
          comments: r.comments,
          activeSessions: r.active_sessions,
          reportsAgainst: r.reports_against,
          notes: r.notes,
        },
        enforcements: enforcements.rows.map((e) => ({
          id: e.id,
          kind: e.kind,
          reason: e.reason,
          startsAt: e.starts_at,
          endsAt: e.ends_at,
          revokedAt: e.revoked_at,
          strikePoints: e.strike_points,
        })),
        actions: {
          canSuspend:
            roleHas(auth.platformRole, 'users.suspend') &&
            outranks(auth.platformRole, r.platform_role) &&
            r.id !== auth.userId,
          canReactivate:
            roleHas(auth.platformRole, 'users.reactivate') &&
            outranks(auth.platformRole, r.platform_role),
          canChangeRole: roleHas(auth.platformRole, 'users.role_change') && r.id !== auth.userId,
        },
      };
    },
  });

  adminRoute(app, ctx, 'users.read', {
    method: 'GET',
    url: '/v1/admin/users/:id/notes',
    summary: 'Internal notes on an account',
    tags: ['admin'],
    params: idParams,
    handler: async ({ params }) => {
      await loadTarget(ctx, params.id);
      const { rows } = await ctx.db.query(
        `SELECT n.id, n.body, n.created_at, n.author_id, p.username AS author FROM admin_user_notes n LEFT JOIN profiles p ON p.user_id = n.author_id WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`,
        [params.id],
      );
      return {
        items: rows.map((n) => ({
          id: n.id,
          body: n.body,
          createdAt: n.created_at,
          authorId: n.author_id,
          author: n.author,
        })),
      };
    },
  });

  adminRoute(app, ctx, 'users.note', {
    method: 'POST',
    url: '/v1/admin/users/:id/notes',
    summary: 'Add an internal note (never shown to the user)',
    tags: ['admin'],
    params: idParams,
    body: z.object({ body: z.string().trim().min(1).max(2000) }),
    rateLimit: { limit: 120, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body, reply }) => {
      await loadTarget(ctx, params.id);
      const { rows } = await ctx.db.query(
        'INSERT INTO admin_user_notes (user_id, author_id, body) VALUES ($1,$2,$3) RETURNING id, created_at',
        [params.id, auth.userId, body.body],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          actorType: 'staff',
          action: 'admin.user_note_added',
          targetType: 'user',
          targetId: params.id,
        },
        req,
      );
      void reply.code(201);
      return { id: rows[0].id, createdAt: rows[0].created_at };
    },
  });

  adminRoute(app, ctx, 'users.suspend', {
    method: 'POST',
    url: '/v1/admin/users/:id/suspend',
    summary: 'Suspend an account for a fixed time (permanent bans go through a moderation case)',
    tags: ['admin'],
    params: idParams,
    body: z.object({ reason: reasonSchema, days: z.number().int().min(1).max(90) }),
    rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body }) => {
      if (params.id === auth.userId) throw forbidden('You cannot act on your own account');
      const target = await loadTarget(ctx, params.id);
      // Staff may only act on accounts ranking below them: a moderator cannot suspend an admin, an admin cannot suspend a peer.
      if (!outranks(auth.platformRole, target.role)) throw notFound('User'); // do not disclose rank structure to lower staff
      if (target.status === 'suspended') throw conflict('This account is already suspended');
      if (!['active', 'deactivated'].includes(target.status))
        throw conflict(`An account that is ${target.status} cannot be suspended`);
      const s = await withTransaction(ctx.db, async (tx) => {
        const applied = await applySuspension(tx, {
          userId: params.id,
          kind: 'suspension',
          days: body.days,
          reason: body.reason,
          actorId: auth.userId,
          scope: 'account',
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'admin.user_suspended',
            targetType: 'user',
            targetId: params.id,
            metadata: {
              days: body.days,
              reason: body.reason,
              enforcementId: applied.enforcementId,
            },
          },
          req,
          tx,
        );
        return applied;
      });
      await notify(ctx, {
        userId: params.id,
        kind: 'account_suspended',
        actorId: null,
        data: { reason: body.reason, appealable: true, endsAt: s.endsAt?.toISOString() ?? null },
      });
      await ctx.email
        .send({
          to: target.email,
          subject: 'Your YAPILAPI account has been suspended',
          text: `We suspended your account: ${body.reason}\n\nYou can appeal within ${APPEAL_WINDOW_DAYS} days: ${ctx.config.WEB_PUBLIC_URL}/appeal?token=${s.appealToken}\n\nThis link is personal to you. Do not share it.`,
        })
        .catch((err: unknown) => ctx.log.warn({ err }, 'suspension email failed'));
      return {
        id: params.id,
        status: 'suspended',
        endsAt: s.endsAt,
        enforcementId: s.enforcementId,
      };
    },
  });

  adminRoute(app, ctx, 'users.reactivate', {
    method: 'POST',
    url: '/v1/admin/users/:id/reactivate',
    summary: 'Lift a suspension or ban (admin and above)',
    tags: ['admin'],
    params: idParams,
    body: z.object({ reason: reasonSchema }),
    rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body }) => {
      const target = await loadTarget(ctx, params.id);
      if (!outranks(auth.platformRole, target.role)) throw notFound('User');
      if (target.status !== 'suspended') throw conflict('This account is not suspended');
      await withTransaction(ctx.db, async (tx) => {
        await tx.query(
          `UPDATE enforcements SET revoked_at = now() WHERE user_id = $1 AND kind IN ('suspension','ban') AND revoked_at IS NULL`,
          [params.id],
        );
        await reinstateIfClear(tx, params.id);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'admin.user_reactivated',
            targetType: 'user',
            targetId: params.id,
            metadata: { reason: body.reason },
          },
          req,
          tx,
        );
      });
      await notify(ctx, { userId: params.id, kind: 'account_reinstated', actorId: null, data: {} });
      return { id: params.id, status: 'active' };
    },
  });

  adminRoute(app, ctx, 'users.role_change', {
    method: 'PUT',
    url: '/v1/admin/users/:id/role',
    summary: 'Change a platform role (superadmin only; the target needs MFA before becoming staff)',
    tags: ['admin'],
    params: idParams,
    body: z.object({ role: z.enum(PLATFORM_ROLES), reason: reasonSchema }),
    rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body }) => {
      if (params.id === auth.userId) throw forbidden('You cannot change your own role');
      const target = await loadTarget(ctx, params.id);
      if (target.role === body.role) throw conflict("That is already this account's role");
      if (target.status !== 'active') throw conflict('Only active accounts can hold a staff role');
      if (body.role !== 'user') {
        if (target.ageBand !== 'adult')
          throw forbidden('Accounts under 18 cannot hold a staff role');
        if (!target.mfaEnabled)
          throw conflict(
            'Enable multi-factor authentication on this account before granting a staff role',
          );
      }
      await withTransaction(ctx.db, async (tx) => {
        await tx.query('UPDATE users SET platform_role = $2 WHERE id = $1', [params.id, body.role]);
        // Sessions were minted under the old privileges: end them so the new role applies from a fresh, MFA-verified sign-in.
        await revokeAllAccess(tx, params.id);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'admin.role_changed',
            targetType: 'user',
            targetId: params.id,
            metadata: {
              from: target.role,
              to: body.role,
              reason: body.reason,
              direction: ROLE_RANK[body.role] > ROLE_RANK[target.role] ? 'promotion' : 'demotion',
            },
          },
          req,
          tx,
        );
      });
      await notify(ctx, {
        userId: params.id,
        kind: 'role_changed',
        actorId: null,
        data: { role: body.role },
      });
      return { id: params.id, role: body.role };
    },
  });
}
