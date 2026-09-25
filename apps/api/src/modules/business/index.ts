import { z } from 'zod';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { isBlockedEitherWay, resolveUser } from '../../lib/users.js';
import { hoursSchema, timezoneSchema } from '../../lib/hours.js';
import { assertOwnedImage } from '../../lib/media-check.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { postVisibleSql } from '../../lib/visibility.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import { createPost } from '../content/service.js';
import type { ApiModule } from '../types.js';
import {
  BUSINESS_PERMISSIONS,
  BUSINESS_ROLES,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  can,
  getBusinessAccess,
  requireBusinessPermission,
  type BusinessRole,
} from './access.js';
import {
  BUSINESS_COLUMNS,
  BookingSettingsPatchSchema,
  BookingSettingsSchema,
  KnowledgeInput,
  lockBusinessForFollowers,
  RESERVED_SLUGS,
  businessView,
  closeBusiness,
  createBooking,
  knowledgeHash,
  loadBusiness,
  mutateKnowledge,
  newEntry,
  parseKnowledge,
  recountFollowers,
  transitionBooking,
  withImages,
  type BusinessRow,
} from './service.js';
import { phoneSchema, websiteSchema, addressSchema } from '../places/service.js';
import { hydrateEvents, loadUserSummaries } from '../events/views.js';
import { eventSelect, eventVisibleSql, type EventRow, EVENT_END_SQL } from '../events/access.js';
import type { DbRow } from '../../lib/db-row.js';

export {
  getAuthorizedBusinessKnowledge,
  expireStaleBookings,
  createBooking,
  transitionBooking,
} from './service.js';
export type { AuthorizedKnowledge } from './service.js';
export {
  getBusinessAccess,
  requireBusinessPermission,
  isBusinessMember,
  ROLE_PERMISSIONS,
  BUSINESS_PERMISSIONS,
} from './access.js';
export type { BusinessAccess, BusinessPermission, BusinessRole } from './access.js';

const idParams = z.object({ id: z.uuid() });
const refParams = z.object({ ref: z.string().trim().min(1).max(60) });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const W = { limit: 60, windowSec: 600, by: 'user' } as const;
const STAFF = ['moderator', 'admin', 'superadmin'] as const;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

type Cursor = { t?: string; id?: string; n?: string };

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{3,50}$/, 'Use 3-50 lowercase letters, numbers or hyphens');
const contactSchema = z
  .object({ email: z.email().max(254), phone: phoneSchema, website: websiteSchema })
  .partial()
  .strict();
const linksSchema = z
  .array(z.object({ label: z.string().trim().min(1).max(60), url: websiteSchema }))
  .max(10);
const inviteRoles = z.enum(['admin', 'editor', 'support']);

const businessFields = {
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60),
  description: z.string().trim().max(5000),
  legalName: z.string().trim().min(2).max(200),
  contact: contactSchema,
  links: linksSchema,
  hours: hoursSchema,
  timezone: timezoneSchema,
  address: addressSchema,
  bookingSettings: BookingSettingsPatchSchema,
};

const createBody = z.object({
  name: businessFields.name,
  slug: slugSchema.optional(),
  category: businessFields.category.default('general'),
  description: businessFields.description.default(''),
  legalName: businessFields.legalName.optional(),
  contact: businessFields.contact.default({}),
  links: businessFields.links.default([]),
  hours: businessFields.hours.default({}),
  timezone: businessFields.timezone.default('UTC'),
  address: businessFields.address.default({}),
  logoMediaId: z.uuid().optional(),
  coverMediaId: z.uuid().optional(),
});
const updateBody = z
  .object({
    ...businessFields,
    legalName: businessFields.legalName.nullable(),
    logoMediaId: z.uuid().nullable(),
    coverMediaId: z.uuid().nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const offerFields = {
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,30}$/, 'Use 3-30 letters, numbers, - or _'),
  discountBps: z.number().int().min(1).max(10_000),
  startsAt: isoDate,
  endsAt: isoDate,
  status: z.enum(['draft', 'active']),
};

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44);
  return s.length >= 3 ? s : `${s}-biz`.replace(/^-/, '').padEnd(3, 'x');
}

const outranks = (actor: BusinessRole, target: BusinessRole) =>
  ROLE_RANK[actor] > ROLE_RANK[target];

export const businessModule: ApiModule = {
  name: 'business',
  register(app, ctx) {
    // ------------------------------------------------------------------ account deletion
    registerDeletionHook(async (c, tx, userId) => {
      // Businesses owned by the user: hand over to the most senior other team member, or close.
      const owned = await tx.query<{ id: string }>(
        'SELECT id FROM businesses WHERE owner_id = $1 AND deleted_at IS NULL FOR UPDATE',
        [userId],
      );
      for (const b of owned.rows) {
        const heir = await tx.query<{ user_id: string }>(
          `SELECT user_id FROM business_members WHERE business_id = $1 AND user_id <> $2 AND role IN ('admin','editor','support')
            ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, created_at LIMIT 1`,
          [b.id, userId],
        );
        if (heir.rows[0]) {
          await tx.query(
            `UPDATE business_members SET role = 'admin' WHERE business_id = $1 AND user_id = $2 AND role = 'owner'`,
            [b.id, userId],
          );
          await tx.query(
            `UPDATE business_members SET role = 'owner' WHERE business_id = $1 AND user_id = $2`,
            [b.id, heir.rows[0].user_id],
          );
          await tx.query('UPDATE businesses SET owner_id = $2 WHERE id = $1', [
            b.id,
            heir.rows[0].user_id,
          ]);
        } else {
          await closeBusiness(c, tx, b.id, null);
          await tx.query('UPDATE businesses SET owner_id = NULL WHERE id = $1', [b.id]);
        }
      }
      await tx.query('DELETE FROM business_members WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM business_invitations WHERE user_id = $1 OR invited_by = $1', [
        userId,
      ]);
      const followed = await tx.query<{ business_id: string }>(
        'SELECT business_id FROM business_followers WHERE user_id = $1 ORDER BY business_id',
        [userId],
      );
      for (const f of followed.rows) await lockBusinessForFollowers(tx, f.business_id);
      await tx.query('DELETE FROM business_followers WHERE user_id = $1', [userId]);
      for (const f of followed.rows) await recountFollowers(tx, f.business_id);
      // Their own upcoming bookings are cancelled (and the business told); history rows go with the account.
      const bks = await tx.query<{ id: string; business_id: string | null }>(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = 'customer', reason = 'The customer closed their account', decided_at = now()
          WHERE customer_id = $1 AND status IN ('requested','confirmed') AND starts_at > now() RETURNING id, business_id`,
        [userId],
      );
      for (const b of bks.rows) {
        if (!b.business_id) continue;
        const team = await tx.query<{ user_id: string }>(
          `SELECT user_id FROM business_members WHERE business_id = $1 AND role IN ('owner','admin','support') LIMIT 20`,
          [b.business_id],
        );
        for (const t of team.rows)
          await notify(
            c,
            {
              userId: t.user_id,
              kind: 'booking_cancelled',
              actorId: null,
              targetType: 'booking',
              targetId: b.id,
              data: { reason: 'customer_left' },
            },
            tx,
          );
      }
      await tx.query(`UPDATE offers SET created_by = NULL WHERE created_by = $1`, [userId]);
    });

    const publicView = async (viewerId: string | null, ref: string) => {
      const { b, access } = await loadBusiness(ctx.db, ref, viewerId);
      const fol = viewerId
        ? await ctx.db.query(
            'SELECT 1 FROM business_followers WHERE business_id = $1 AND user_id = $2',
            [b.id, viewerId],
          )
        : null;
      const [v] = await withImages(
        ctx,
        [b],
        [businessView(b, access, { following: Boolean(fol?.rowCount) })],
      );
      return v!;
    };

    // ================================================================== profile
    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses',
      summary: 'Create a business profile (you become its owner)',
      tags: ['business'],
      auth: 'user',
      body: createBody,
      rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        if (auth.ageBand === 'teen')
          throw new AppError('unprocessable', 'Accounts under 18 cannot create business profiles');
        assertTextAllowed(body.name, body.description, body.category);
        for (const m of [body.logoMediaId, body.coverMediaId])
          if (m) await assertOwnedImage(ctx.db, m, auth.userId);
        const base = body.slug ?? slugify(body.name);
        if (RESERVED_SLUGS.has(base)) throw invalid('That URL name is reserved');
        const id = await withTransaction(ctx.db, async (tx) => {
          const n = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM businesses WHERE owner_id = $1 AND deleted_at IS NULL`,
            [auth.userId],
          );
          if (n.rows[0]!.n >= 10) throw conflict('You can own at most 10 businesses');
          let slug = base;
          for (let attempt = 0; ; attempt++) {
            const taken = await tx.query(
              'SELECT 1 FROM businesses WHERE slug = $1 AND deleted_at IS NULL',
              [slug],
            );
            if (!taken.rowCount) break;
            if (body.slug) throw conflict('That URL name is taken');
            if (attempt > 8) throw conflict('Could not find a free URL name, please choose one');
            slug = `${base.slice(0, 44)}-${Math.random().toString(36).slice(2, 6)}`;
          }
          const r = await tx.query<{ id: string }>(
            `INSERT INTO businesses (owner_id, slug, name, legal_name, category, description, contact, links, hours, timezone, address, logo_media_id, cover_media_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [
              auth.userId,
              slug,
              body.name,
              body.legalName ?? null,
              body.category,
              body.description,
              JSON.stringify(body.contact),
              JSON.stringify(body.links),
              JSON.stringify(body.hours),
              body.timezone,
              JSON.stringify(body.address),
              body.logoMediaId ?? null,
              body.coverMediaId ?? null,
            ],
          );
          await tx.query(
            `INSERT INTO business_members (business_id, user_id, role) VALUES ($1,$2,'owner')`,
            [r.rows[0]!.id, auth.userId],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'business.created',
              targetType: 'business',
              targetId: r.rows[0]!.id,
              metadata: { slug },
            },
            req,
            tx,
          );
          return r.rows[0]!.id;
        });
        void reply.code(201);
        return publicView(auth.userId, id);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:ref',
      summary: 'A business profile (by id or slug)',
      tags: ['business'],
      auth: 'optional',
      params: refParams,
      handler: async ({ auth, params }) => publicView(auth?.userId ?? null, params.ref),
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/businesses/:id',
      summary: 'Edit the business profile',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: updateBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'profile.edit');
        assertTextAllowed(body.name, body.description, body.category);
        for (const m of [body.logoMediaId, body.coverMediaId])
          if (m) await assertOwnedImage(ctx.db, m, auth.userId);
        const sets: string[] = [];
        const vals: unknown[] = [params.id];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };
        if (body.name !== undefined) set('name', body.name);
        if (body.category !== undefined) set('category', body.category);
        if (body.description !== undefined) set('description', body.description);
        if (body.legalName !== undefined) set('legal_name', body.legalName);
        if (body.contact !== undefined) set('contact', JSON.stringify(body.contact));
        if (body.links !== undefined) set('links', JSON.stringify(body.links));
        if (body.hours !== undefined) set('hours', JSON.stringify(body.hours));
        if (body.timezone !== undefined) set('timezone', body.timezone);
        if (body.address !== undefined) set('address', JSON.stringify(body.address));
        if (body.logoMediaId !== undefined) set('logo_media_id', body.logoMediaId);
        if (body.coverMediaId !== undefined) set('cover_media_id', body.coverMediaId);
        await withTransaction(ctx.db, async (tx) => {
          const { rows } = await tx.query<{ booking_settings: unknown }>(
            'SELECT booking_settings FROM businesses WHERE id = $1 FOR UPDATE',
            [params.id],
          );
          if (body.bookingSettings !== undefined)
            set(
              'booking_settings',
              JSON.stringify({ ...(rows[0]!.booking_settings as object), ...body.bookingSettings }),
            );
          if (sets.length)
            await tx.query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $1`, vals);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'business.updated',
              targetType: 'business',
              targetId: params.id,
              metadata: { fields: Object.keys(body) },
            },
            req,
            tx,
          );
        });
        return publicView(auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id',
      summary:
        'Close the business (owner). Cancels upcoming bookings and events and releases its places.',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'business.delete', {
          allowInactive: true,
        });
        await withTransaction(ctx.db, async (tx) => {
          await closeBusiness(ctx, tx, params.id, auth.userId);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'business.closed',
              targetType: 'business',
              targetId: params.id,
            },
            req,
            tx,
          );
        });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses',
      summary: 'Business directory (active businesses, alphabetical)',
      tags: ['business'],
      auth: 'optional',
      query: pageQuery.extend({
        q: z.string().trim().min(1).max(100).optional(),
        category: z.string().trim().min(1).max(60).optional(),
        verified: boolQuery.optional(),
      }),
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const params: unknown[] = [viewer];
        const where = [
          `b.deleted_at IS NULL`,
          `b.status = 'active'`,
          `($1::uuid IS NULL OR b.owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $1::uuid AND bl.blocked_id = b.owner_id) OR (bl.blocker_id = b.owner_id AND bl.blocked_id = $1::uuid)))`,
        ];
        const p = (v: unknown) => {
          params.push(v);
          return `$${params.length}`;
        };
        if (query.q)
          where.push(
            `(b.name ILIKE ${p(`%${escapeLike(query.q)}%`)} ESCAPE '\\' OR b.search_tsv @@ plainto_tsquery('simple', ${p(query.q)}))`,
          );
        if (query.category) where.push(`lower(b.category) = lower(${p(query.category)})`);
        if (query.verified !== undefined)
          where.push(query.verified ? 'b.verified_at IS NOT NULL' : 'b.verified_at IS NULL');
        if (cur?.n !== undefined)
          where.push(`(lower(b.name), b.id) > (${p(cur.n)}::text, ${p(cur.id)}::uuid)`);
        const { rows } = await ctx.db.query<BusinessRow>(
          `SELECT ${BUSINESS_COLUMNS} FROM businesses b WHERE ${where.join(' AND ')} ORDER BY lower(b.name), b.id LIMIT ${p(limit + 1)}`,
          params,
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const items = await withImages(
          ctx,
          page,
          page.map((b) => businessView(b, null)),
        );
        return {
          items,
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ n: last.name.toLowerCase(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/businesses',
      summary: 'Businesses you belong to',
      tags: ['business'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query<BusinessRow & { my_role: BusinessRole }>(
          `SELECT ${BUSINESS_COLUMNS}, m.role AS my_role FROM business_members m JOIN businesses b ON b.id = m.business_id AND b.deleted_at IS NULL WHERE m.user_id = $1 ORDER BY b.created_at DESC, b.id`,
          [auth.userId],
        );
        const items = await withImages(
          ctx,
          rows,
          rows.map((b) =>
            businessView(b, {
              businessId: b.id,
              role: b.my_role,
              permissions: ROLE_PERMISSIONS[b.my_role],
              status: b.status,
            }),
          ),
        );
        return { items };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/view',
      summary: 'Record a profile view (team members are not counted)',
      tags: ['business'],
      auth: 'optional',
      params: idParams,
      rateLimit: { limit: 120, windowSec: 600, by: 'ip' },
      handler: async ({ auth, params }) => {
        const { b, access } = await loadBusiness(ctx.db, params.id, auth?.userId ?? null);
        if (access) return;
        await ctx.db.query(
          `INSERT INTO business_daily_views (business_id, day, views) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1) ON CONFLICT (business_id, day) DO UPDATE SET views = business_daily_views.views + 1`,
          [b.id],
        );
      },
    });

    // ================================================================== follow
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/businesses/:id/follow',
      summary: 'Follow a business',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, params }) => {
        const { b, access } = await loadBusiness(ctx.db, params.id, auth.userId);
        if (access) throw invalid("You are on this business's team");
        const count = await withTransaction(ctx.db, async (tx) => {
          await lockBusinessForFollowers(tx, b.id);
          await tx.query(
            'INSERT INTO business_followers (business_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [b.id, auth.userId],
          );
          return recountFollowers(tx, b.id);
        });
        return { following: true, followerCount: count };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/follow',
      summary: 'Unfollow a business',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await withTransaction(ctx.db, async (tx) => {
          await lockBusinessForFollowers(tx, params.id);
          await tx.query('DELETE FROM business_followers WHERE business_id = $1 AND user_id = $2', [
            params.id,
            auth.userId,
          ]);
          await recountFollowers(tx, params.id);
        });
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/following-businesses',
      summary: 'Businesses you follow',
      tags: ['business'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<BusinessRow & { followed_at: Date }>(
          `SELECT ${BUSINESS_COLUMNS}, f.created_at AS followed_at FROM business_followers f JOIN businesses b ON b.id = f.business_id AND b.deleted_at IS NULL AND b.status = 'active'
            WHERE f.user_id = $1 AND ($2::timestamptz IS NULL OR (f.created_at, b.id) < ($2::timestamptz, $3::uuid)) ORDER BY f.created_at DESC, b.id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await withImages(
            ctx,
            page,
            page.map((b) => businessView(b, null, { following: true })),
          ),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.followed_at.toISOString(), id: last.id })
              : null,
        };
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/followers',
      summary: 'Followers (owner and admins)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'profile.edit', {
          allowInactive: true,
        });
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<{ user_id: string; created_at: Date }>(
          `SELECT user_id, created_at FROM business_followers WHERE business_id = $1 AND ($2::timestamptz IS NULL OR (created_at, user_id) < ($2::timestamptz, $3::uuid)) ORDER BY created_at DESC, user_id DESC LIMIT $4`,
          [params.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const users = await loadUserSummaries(
          ctx,
          page.map((r) => r.user_id),
        );
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            user: users.get(r.user_id) ?? null,
            since: r.created_at.toISOString(),
          })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.user_id })
              : null,
        };
      },
    });

    // ================================================================== team
    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/team',
      summary: 'Team members and roles (team only)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const a = await getBusinessAccess(ctx.db, params.id, auth.userId);
        if (!a) throw notFound('Business');
        const { rows } = await ctx.db.query<{
          user_id: string;
          role: BusinessRole;
          created_at: Date;
        }>(
          `SELECT user_id, role, created_at FROM business_members WHERE business_id = $1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, created_at`,
          [params.id],
        );
        const users = await loadUserSummaries(
          ctx,
          rows.map((r) => r.user_id),
        );
        return {
          roles: Object.fromEntries(BUSINESS_ROLES.map((r) => [r, ROLE_PERMISSIONS[r]])),
          items: rows.map((r) => ({
            user: users.get(r.user_id) ?? { id: r.user_id },
            role: r.role,
            permissions: ROLE_PERMISSIONS[r.role],
            since: r.created_at.toISOString(),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/invitations',
      summary: 'Invite someone to the team',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: z.object({ username: z.string().trim().min(1).max(40), role: inviteRoles }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const me = await requireBusinessPermission(ctx.db, params.id, auth.userId, 'team.manage');
        if (!outranks(me.role, body.role))
          throw forbidden('You cannot invite someone to a role at or above your own');
        const target = await resolveUser(ctx, auth.userId, body.username);
        if (target.id === auth.userId) throw invalid('You are already on the team');
        const t = await ctx.db.query<{ age_band: string; status: string }>(
          'SELECT age_band, status FROM users WHERE id = $1',
          [target.id],
        );
        if (t.rows[0]?.status !== 'active') throw notFound('User');
        if (t.rows[0]?.age_band === 'teen')
          throw new AppError('unprocessable', 'Accounts under 18 cannot join business teams');
        if (await getBusinessAccess(ctx.db, params.id, target.id))
          throw conflict('That person is already on the team');
        const r = await ctx.db.query(
          `INSERT INTO business_invitations (business_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, status = 'pending', created_at = now()
             WHERE business_invitations.status <> 'pending' OR business_invitations.role <> EXCLUDED.role`,
          [params.id, target.id, body.role, auth.userId],
        );
        if (r.rowCount) {
          const b = await ctx.db.query<{ name: string }>(
            'SELECT name FROM businesses WHERE id = $1',
            [params.id],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'business.team_invited',
              targetType: 'business',
              targetId: params.id,
              metadata: { userId: target.id, role: body.role },
            },
            req,
          );
          await notify(ctx, {
            userId: target.id,
            kind: 'business_team_invitation',
            actorId: auth.userId,
            targetType: 'business',
            targetId: params.id,
            data: { business: b.rows[0]?.name, role: body.role },
          });
        }
        void reply.code(r.rowCount ? 201 : 200);
        return { userId: target.id, role: body.role, status: 'pending' };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/invitations',
      summary: 'Pending team invitations',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'team.manage', {
          allowInactive: true,
        });
        const { rows } = await ctx.db.query<{ user_id: string; role: string; created_at: Date }>(
          `SELECT user_id, role, created_at FROM business_invitations WHERE business_id = $1 AND status = 'pending' ORDER BY created_at`,
          [params.id],
        );
        const users = await loadUserSummaries(
          ctx,
          rows.map((r) => r.user_id),
        );
        return {
          items: rows.map((r) => ({
            user: users.get(r.user_id) ?? null,
            role: r.role,
            invitedAt: r.created_at.toISOString(),
          })),
        };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/invitations/:userId',
      summary: 'Revoke a pending invitation',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      handler: async ({ auth, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'team.manage');
        const r = await ctx.db.query(
          `UPDATE business_invitations SET status = 'revoked' WHERE business_id = $1 AND user_id = $2 AND status = 'pending'`,
          [params.id, params.userId],
        );
        if (!r.rowCount) throw notFound('Invitation');
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/business-invitations',
      summary: 'Team invitations you received',
      tags: ['business'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT i.business_id, i.role, i.created_at, b.name, b.slug FROM business_invitations i JOIN businesses b ON b.id = i.business_id AND b.deleted_at IS NULL AND b.status = 'active'
            WHERE i.user_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`,
          [auth.userId],
        );
        return {
          items: rows.map((r) => ({
            businessId: r.business_id,
            name: r.name,
            slug: r.slug,
            role: r.role,
            invitedAt: r.created_at.toISOString(),
          })),
        };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/invitation/accept',
      summary: 'Accept a team invitation',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        if (auth.ageBand === 'teen')
          throw new AppError('unprocessable', 'Accounts under 18 cannot join business teams');
        const role = await withTransaction(ctx.db, async (tx) => {
          const b = await tx.query(
            `SELECT 1 FROM businesses WHERE id = $1 AND deleted_at IS NULL AND status = 'active' FOR UPDATE`,
            [params.id],
          );
          if (!b.rowCount) throw notFound('Invitation');
          const inv = await tx.query<{ role: BusinessRole }>(
            `UPDATE business_invitations SET status = 'accepted' WHERE business_id = $1 AND user_id = $2 AND status = 'pending' RETURNING role`,
            [params.id, auth.userId],
          );
          if (!inv.rows[0]) throw notFound('Invitation');
          await tx.query(
            `INSERT INTO business_members (business_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (business_id, user_id) DO NOTHING`,
            [params.id, auth.userId, inv.rows[0].role],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'business.team_joined',
              targetType: 'business',
              targetId: params.id,
              metadata: { role: inv.rows[0].role },
            },
            req,
            tx,
          );
          return inv.rows[0].role;
        });
        return { businessId: params.id, role };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/invitation/decline',
      summary: 'Decline a team invitation',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query(
          `UPDATE business_invitations SET status = 'declined' WHERE business_id = $1 AND user_id = $2 AND status = 'pending'`,
          [params.id, auth.userId],
        );
        if (!r.rowCount) throw notFound('Invitation');
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/businesses/:id/team/:userId',
      summary: "Change a team member's role",
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      body: z.object({ role: inviteRoles }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const me = await requireBusinessPermission(ctx.db, params.id, auth.userId, 'team.manage');
        const target = await getBusinessAccess(ctx.db, params.id, params.userId);
        if (!target) throw notFound('Team member');
        if (target.role === 'owner')
          throw forbidden("The owner's role changes only through an ownership transfer");
        if (params.userId === auth.userId) throw forbidden('You cannot change your own role');
        if (!outranks(me.role, target.role) || !outranks(me.role, body.role))
          throw forbidden('You can only manage roles below your own');
        await ctx.db.query(
          'UPDATE business_members SET role = $3 WHERE business_id = $1 AND user_id = $2',
          [params.id, params.userId, body.role],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'business.team_role_changed',
            targetType: 'business',
            targetId: params.id,
            metadata: { userId: params.userId, from: target.role, to: body.role },
          },
          req,
        );
        await notify(ctx, {
          userId: params.userId,
          kind: 'business_role_changed',
          actorId: auth.userId,
          targetType: 'business',
          targetId: params.id,
          data: { role: body.role },
        });
        return { userId: params.userId, role: body.role };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/team/:userId',
      summary: 'Remove a team member, or leave the team yourself',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const me = await getBusinessAccess(ctx.db, params.id, auth.userId);
        if (!me) throw notFound('Business');
        const target = await getBusinessAccess(ctx.db, params.id, params.userId);
        if (!target) throw notFound('Team member');
        if (target.role === 'owner')
          throw forbidden('The owner cannot be removed: transfer ownership first');
        if (params.userId !== auth.userId) {
          if (!can(me, 'team.manage')) throw forbidden('Your role does not allow that');
          if (!outranks(me.role, target.role))
            throw forbidden('You can only remove members below your own role');
        }
        await ctx.db.query('DELETE FROM business_members WHERE business_id = $1 AND user_id = $2', [
          params.id,
          params.userId,
        ]);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: params.userId === auth.userId ? 'business.team_left' : 'business.team_removed',
            targetType: 'business',
            targetId: params.id,
            metadata: { userId: params.userId },
          },
          req,
        );
        if (params.userId !== auth.userId)
          await notify(ctx, {
            userId: params.userId,
            kind: 'business_team_removed',
            actorId: auth.userId,
            targetType: 'business',
            targetId: params.id,
          });
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/transfer-ownership',
      summary: 'Hand the business over to another team member (owner only)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: z.object({ userId: z.uuid() }),
      rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'business.delete');
        if (body.userId === auth.userId) throw invalid('You already own this business');
        await withTransaction(ctx.db, async (tx) => {
          await tx.query('SELECT 1 FROM businesses WHERE id = $1 FOR UPDATE', [params.id]);
          const t = await tx.query(
            `SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2`,
            [params.id, body.userId],
          );
          if (!t.rowCount) throw notFound('Team member');
          await tx.query(
            `UPDATE business_members SET role = 'admin' WHERE business_id = $1 AND user_id = $2 AND role = 'owner'`,
            [params.id, auth.userId],
          );
          await tx.query(
            `UPDATE business_members SET role = 'owner' WHERE business_id = $1 AND user_id = $2`,
            [params.id, body.userId],
          );
          await tx.query('UPDATE businesses SET owner_id = $2 WHERE id = $1', [
            params.id,
            body.userId,
          ]);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'business.ownership_transferred',
              targetType: 'business',
              targetId: params.id,
              metadata: { to: body.userId },
            },
            req,
            tx,
          );
        });
        await notify(ctx, {
          userId: body.userId,
          kind: 'business_ownership_received',
          actorId: auth.userId,
          targetType: 'business',
          targetId: params.id,
        });
        return { ownerId: body.userId };
      },
    });

    // ================================================================== offers
    const offerView = (o: DbRow) => {
      const expired = o.status === 'active' && o.ends_at && o.ends_at <= new Date();
      return {
        id: o.id,
        title: o.title,
        description: o.description,
        code: o.code,
        discountBps: o.discount_bps,
        startsAt: o.starts_at.toISOString(),
        endsAt: o.ends_at?.toISOString() ?? null,
        status: expired ? 'expired' : o.status,
        createdAt: o.created_at.toISOString(),
      };
    };

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/offers',
      summary: 'Offers of a business (public: only running offers; team: all)',
      tags: ['business'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const { b, access } = await loadBusiness(ctx.db, params.id, auth?.userId ?? null);
        const all = can(access, 'offers.manage');
        const { rows } = await ctx.db.query(
          `SELECT * FROM offers WHERE business_id = $1 ${all ? '' : `AND status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`} ORDER BY created_at DESC, id`,
          [b.id],
        );
        return { items: rows.map(offerView) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/offers',
      summary: 'Create an offer',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: z
        .object({
          title: offerFields.title,
          description: offerFields.description.default(''),
          code: offerFields.code.optional(),
          discountBps: offerFields.discountBps.optional(),
          startsAt: offerFields.startsAt.optional(),
          endsAt: offerFields.endsAt.optional(),
          status: offerFields.status.default('active'),
        })
        .refine((b) => !b.endsAt || b.endsAt > (b.startsAt ?? new Date()), {
          message: 'endsAt must be after startsAt',
        }),
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'offers.manage');
        assertTextAllowed(body.title, body.description);
        const { rows } = await ctx.db.query(
          `INSERT INTO offers (business_id, title, description, code, discount_bps, starts_at, ends_at, status, created_by) VALUES ($1,$2,$3,$4,$5,COALESCE($6, now()),$7,$8,$9) RETURNING *`,
          [
            params.id,
            body.title,
            body.description,
            body.code ?? null,
            body.discountBps ?? null,
            body.startsAt ?? null,
            body.endsAt ?? null,
            body.status,
            auth.userId,
          ],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'offer.created',
            targetType: 'business',
            targetId: params.id,
            metadata: { offerId: rows[0].id },
          },
          req,
        );
        void reply.code(201);
        return offerView(rows[0]);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/businesses/:id/offers/:offerId',
      summary: 'Edit an offer',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), offerId: z.uuid() }),
      body: z
        .object({
          title: offerFields.title,
          description: offerFields.description,
          code: offerFields.code.nullable(),
          discountBps: offerFields.discountBps.nullable(),
          startsAt: offerFields.startsAt,
          endsAt: offerFields.endsAt.nullable(),
          status: offerFields.status,
        })
        .partial()
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'offers.manage');
        assertTextAllowed(body.title, body.description);
        const cur = await ctx.db.query('SELECT * FROM offers WHERE id = $1 AND business_id = $2', [
          params.offerId,
          params.id,
        ]);
        if (!cur.rows[0] || cur.rows[0].status === 'cancelled') throw notFound('Offer');
        const start = body.startsAt ?? cur.rows[0].starts_at;
        const end = body.endsAt === undefined ? cur.rows[0].ends_at : body.endsAt;
        if (end && end <= start) throw invalid('endsAt must be after startsAt');
        const sets: string[] = [];
        const vals: unknown[] = [params.offerId];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };
        if (body.title !== undefined) set('title', body.title);
        if (body.description !== undefined) set('description', body.description);
        if (body.code !== undefined) set('code', body.code);
        if (body.discountBps !== undefined) set('discount_bps', body.discountBps);
        if (body.startsAt !== undefined) set('starts_at', body.startsAt);
        if (body.endsAt !== undefined) set('ends_at', body.endsAt);
        if (body.status !== undefined) set('status', body.status);
        const { rows } = await ctx.db.query(
          `UPDATE offers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
          vals,
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'offer.updated',
            targetType: 'business',
            targetId: params.id,
            metadata: { offerId: params.offerId, fields: Object.keys(body) },
          },
          req,
        );
        return offerView(rows[0]);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/offers/:offerId',
      summary: 'Cancel an offer',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), offerId: z.uuid() }),
      handler: async ({ auth, req, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'offers.manage');
        const r = await ctx.db.query(
          `UPDATE offers SET status = 'cancelled' WHERE id = $1 AND business_id = $2 AND status <> 'cancelled'`,
          [params.offerId, params.id],
        );
        if (!r.rowCount) throw notFound('Offer');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'offer.cancelled',
            targetType: 'business',
            targetId: params.id,
            metadata: { offerId: params.offerId },
          },
          req,
        );
      },
    });

    // ================================================================== services (bookable products of kind 'service')
    // Services are rows of the shared `products` table (kind 'service'): commerce owns payment/checkout for them, this module owns their
    // catalogue entry and their bookings.
    const serviceView = (r: DbRow) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      priceCents: r.price_cents,
      currency: r.currency,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    });
    const serviceFields = {
      title: z.string().trim().min(2).max(160),
      description: z.string().trim().max(5000),
      priceCents: z.number().int().min(0).max(100_000_000),
      currency: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
      status: z.enum(['draft', 'active']),
    };

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/services',
      summary: 'Services of a business (public: active ones; team: all except archived)',
      tags: ['business'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const { b, access } = await loadBusiness(ctx.db, params.id, auth?.userId ?? null);
        const all = can(access, 'offers.manage');
        const { rows } = await ctx.db.query(
          `SELECT * FROM products WHERE business_id = $1 AND kind = 'service' AND deleted_at IS NULL AND ${all ? `status IN ('draft','active')` : `status = 'active'`} ORDER BY title, id`,
          [b.id],
        );
        return { items: rows.map(serviceView) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/services',
      summary: 'Create a bookable service',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: z.object({
        title: serviceFields.title,
        description: serviceFields.description.default(''),
        priceCents: serviceFields.priceCents.default(0),
        currency: serviceFields.currency.default('USD'),
        status: serviceFields.status.default('active'),
      }),
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'offers.manage');
        assertTextAllowed(body.title, body.description);
        const n = await ctx.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM products WHERE business_id = $1 AND kind = 'service' AND deleted_at IS NULL AND status IN ('draft','active')`,
          [params.id],
        );
        if (n.rows[0]!.n >= 100) throw conflict('A business can list at most 100 services');
        const { rows } = await ctx.db.query(
          `INSERT INTO products (business_id, kind, title, description, price_cents, currency, status) VALUES ($1,'service',$2,$3,$4,$5,$6) RETURNING *`,
          [params.id, body.title, body.description, body.priceCents, body.currency, body.status],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'service.created',
            targetType: 'business',
            targetId: params.id,
            metadata: { serviceId: rows[0].id },
          },
          req,
        );
        void reply.code(201);
        return serviceView(rows[0]);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/businesses/:id/services/:serviceId',
      summary: 'Edit a service',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), serviceId: z.uuid() }),
      body: z
        .object(serviceFields)
        .partial()
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'offers.manage');
        assertTextAllowed(body.title, body.description);
        const sets: string[] = [];
        const vals: unknown[] = [params.serviceId, params.id];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };
        if (body.title !== undefined) set('title', body.title);
        if (body.description !== undefined) set('description', body.description);
        if (body.priceCents !== undefined) set('price_cents', body.priceCents);
        if (body.currency !== undefined) set('currency', body.currency);
        if (body.status !== undefined) set('status', body.status);
        const { rows } = await ctx.db.query(
          `UPDATE products SET ${sets.join(', ')} WHERE id = $1 AND business_id = $2 AND kind = 'service' AND deleted_at IS NULL AND status IN ('draft','active') RETURNING *`,
          vals,
        );
        if (!rows[0]) throw notFound('Service');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'service.updated',
            targetType: 'business',
            targetId: params.id,
            metadata: { serviceId: params.serviceId, fields: Object.keys(body) },
          },
          req,
        );
        return serviceView(rows[0]);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/services/:serviceId',
      summary: 'Archive a service (existing bookings are kept)',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), serviceId: z.uuid() }),
      handler: async ({ auth, req, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'offers.manage');
        const r = await ctx.db.query(
          `UPDATE products SET status = 'archived' WHERE id = $1 AND business_id = $2 AND kind = 'service' AND deleted_at IS NULL AND status <> 'archived'`,
          [params.serviceId, params.id],
        );
        if (!r.rowCount) throw notFound('Service');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'service.archived',
            targetType: 'business',
            targetId: params.id,
            metadata: { serviceId: params.serviceId },
          },
          req,
        );
      },
    });

    // ================================================================== bookings
    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/bookable',
      summary: 'What can be booked: places with bookings enabled and service products',
      tags: ['business'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const { b } = await loadBusiness(ctx.db, params.id, auth?.userId ?? null);
        const places = await ctx.db.query(
          `SELECT id, name, kind, capacity, timezone, hours FROM places WHERE business_id = $1 AND booking_enabled AND deleted_at IS NULL ORDER BY name`,
          [b.id],
        );
        let services: Array<DbRow> = [];
        try {
          services = (
            await ctx.db.query(
              `SELECT id, title, description, price_cents, currency FROM products WHERE business_id = $1 AND kind IN ('service','booking') AND status = 'active' AND deleted_at IS NULL ORDER BY title`,
              [b.id],
            )
          ).rows;
        } catch (err) {
          if ((err as { code?: string }).code !== '42P01') throw err;
        }
        return {
          settings: BookingSettingsSchema.parse(b.booking_settings ?? {}),
          places: places.rows.map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.kind,
            capacity: p.capacity,
            timezone: p.timezone,
            hasHours: Object.keys(p.hours ?? {}).length > 0,
          })),
          services: services.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            priceCents: s.price_cents,
            currency: s.currency,
            timezone: b.timezone,
          })),
        };
      },
    });

    const bookingView = (r: DbRow) => ({
      id: r.id,
      status: r.status,
      placeId: r.place_id,
      productId: r.product_id,
      businessId: r.business_id,
      customerId: r.customer_id,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      partySize: r.party_size,
      notes: r.notes,
      reason: r.reason,
      cancelledBy: r.cancelled_by,
      orderId: r.order_id,
      decidedAt: r.decided_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      ...(r.business_name
        ? { business: { id: r.business_id, name: r.business_name, slug: r.business_slug } }
        : {}),
      ...(r.customer_username
        ? {
            customer: {
              id: r.customer_id,
              username: r.customer_username,
              displayName: r.customer_display_name,
            },
          }
        : {}),
      ...(r.target_name ? { targetName: r.target_name } : {}),
    });
    const BOOKING_SELECT = `SELECT bk.*, b.name AS business_name, b.slug AS business_slug, pr.username AS customer_username, pr.display_name AS customer_display_name,
        COALESCE(pl.name, prod.title) AS target_name
      FROM bookings bk LEFT JOIN businesses b ON b.id = bk.business_id LEFT JOIN profiles pr ON pr.user_id = bk.customer_id
      LEFT JOIN places pl ON pl.id = bk.place_id LEFT JOIN products prod ON prod.id = bk.product_id`;

    route(app, ctx, {
      method: 'POST',
      url: '/v1/bookings',
      summary: 'Request a booking for a bookable place or service',
      tags: ['business'],
      auth: 'user',
      body: z.object({
        placeId: z.uuid().optional(),
        productId: z.uuid().optional(),
        startsAt: isoDate,
        durationMinutes: z.number().int().min(5).max(1440).default(60),
        partySize: z.number().int().min(1).max(500).default(1),
        notes: z.string().trim().max(1000).default(''),
      }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        const b = await createBooking(ctx, auth.userId, body);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'booking.created',
            targetType: 'booking',
            targetId: b.id,
            metadata: { businessId: b.businessId, status: b.status },
          },
          req,
        );
        const { rows } = await ctx.db.query(`${BOOKING_SELECT} WHERE bk.id = $1`, [b.id]);
        void reply.code(201);
        return bookingView(rows[0]!);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/bookings/:id',
      summary: 'A booking (the customer, or the business team)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const { rows } = await ctx.db.query<DbRow>(`${BOOKING_SELECT} WHERE bk.id = $1`, [
          params.id,
        ]);
        const r = rows[0];
        if (!r) throw notFound('Booking');
        if (r.customer_id !== auth.userId) {
          const a = r.business_id
            ? await getBusinessAccess(ctx.db, r.business_id, auth.userId)
            : null;
          if (!can(a, 'bookings.manage')) throw notFound('Booking');
        }
        return bookingView(r);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/bookings',
      summary: 'Your bookings',
      tags: ['business'],
      auth: 'user',
      query: pageQuery.extend({
        when: z.enum(['upcoming', 'past']).default('upcoming'),
        status: z
          .enum(['requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show'])
          .optional(),
      }),
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const up = query.when === 'upcoming';
        const { rows } = await ctx.db.query(
          `${BOOKING_SELECT} WHERE bk.customer_id = $1 AND (bk.ends_at ${up ? '>' : '<='} now()) AND ($2::text IS NULL OR bk.status = $2)
             AND ($3::timestamptz IS NULL OR (bk.starts_at, bk.id) ${up ? '>' : '<'} ($3::timestamptz, $4::uuid))
           ORDER BY bk.starts_at ${up ? 'ASC' : 'DESC'}, bk.id ${up ? 'ASC' : 'DESC'} LIMIT $5`,
          [auth.userId, query.status ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(bookingView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.starts_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/bookings',
      summary: 'Bookings received by a business (team with booking access)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      query: pageQuery.extend({
        status: z
          .enum(['requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show'])
          .optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      }),
      handler: async ({ auth, params, query }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'bookings.manage', {
          allowInactive: true,
        });
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `${BOOKING_SELECT} WHERE bk.business_id = $1 AND ($2::text IS NULL OR bk.status = $2) AND ($3::timestamptz IS NULL OR bk.starts_at >= $3) AND ($4::timestamptz IS NULL OR bk.starts_at < $4)
             AND ($5::timestamptz IS NULL OR (bk.starts_at, bk.id) > ($5::timestamptz, $6::uuid))
           ORDER BY bk.starts_at, bk.id LIMIT $7`,
          [
            params.id,
            query.status ?? null,
            query.from ?? null,
            query.to ?? null,
            cur?.t ?? null,
            cur?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(bookingView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.starts_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    for (const [path, action] of [
      ['confirm', 'confirm'],
      ['decline', 'decline'],
      ['cancel', 'cancel'],
      ['complete', 'complete'],
      ['no-show', 'no_show'],
    ] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/bookings/:id/${path}`,
        summary: `Booking transition: ${path}`,
        tags: ['business'],
        auth: 'user',
        params: idParams,
        body: z.object({ reason: z.string().trim().max(500).optional() }),
        rateLimit: W,
        handler: async ({ auth, req, params, body }) => {
          const r = await transitionBooking(ctx, {
            bookingId: params.id,
            userId: auth.userId,
            action,
            reason: body.reason,
          });
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: `booking.${r.status}`,
              targetType: 'booking',
              targetId: params.id,
              metadata: { by: r.actor },
            },
            req,
          );
          const { rows } = await ctx.db.query(`${BOOKING_SELECT} WHERE bk.id = $1`, [params.id]);
          return bookingView(rows[0]!);
        },
      });
    }

    // ================================================================== analytics
    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/analytics',
      summary: 'Business analytics from real data (owner only)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      handler: async ({ auth, params, query }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'analytics.view', {
          allowInactive: true,
        });
        const since = new Date(Date.now() - query.days * 86_400_000);
        const q = async <T = DbRow>(sql: string, args: unknown[] = [params.id, since]) =>
          (await ctx.db.query<T & DbRow>(sql, args)).rows;
        const [
          views,
          daily,
          followers,
          newFollowers,
          bookings,
          upcomingBookings,
          events,
          attendees,
          posts,
          reviews,
          offers,
        ] = await Promise.all([
          q(
            `SELECT COALESCE(sum(views),0)::int AS n FROM business_daily_views WHERE business_id = $1 AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date`,
          ),
          q(
            `SELECT day::text AS day, views::int AS views FROM business_daily_views WHERE business_id = $1 AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date ORDER BY day`,
          ),
          q(`SELECT count(*)::int AS n FROM business_followers WHERE business_id = $1`, [
            params.id,
          ]),
          q(
            `SELECT count(*)::int AS n FROM business_followers WHERE business_id = $1 AND created_at >= $2`,
          ),
          q(
            `SELECT status, count(*)::int AS n FROM bookings WHERE business_id = $1 AND created_at >= $2 GROUP BY status`,
          ),
          q(
            `SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND status IN ('requested','confirmed') AND starts_at > now()`,
            [params.id],
          ),
          q(`SELECT count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('published','completed'))::int AS hosted,
                    count(*) FILTER (WHERE deleted_at IS NULL AND status = 'published' AND ends_at IS NOT NULL AND ends_at > now() OR (deleted_at IS NULL AND status = 'published' AND ends_at IS NULL AND starts_at > now()))::int AS upcoming,
                    count(*) FILTER (WHERE deleted_at IS NULL AND status = 'completed')::int AS completed
               FROM events WHERE host_business_id = $1 AND created_at >= $2`),
          q(
            `SELECT COALESCE(sum(going_count),0)::int AS n FROM events WHERE host_business_id = $1 AND deleted_at IS NULL AND status IN ('published','completed') AND created_at >= $2`,
          ),
          q(`SELECT count(*)::int AS n, COALESCE(sum(like_count),0)::int AS likes, COALESCE(sum(comment_count),0)::int AS comments, COALESCE(sum(view_count),0)::bigint AS views
               FROM posts WHERE business_id = $1 AND deleted_at IS NULL AND created_at >= $2`),
          q(`SELECT count(*)::int AS n, COALESCE(round(avg(r.rating)::numeric, 2), 0)::float AS avg FROM reviews r JOIN places p ON p.id = r.target_id AND r.target_type = 'place'
              WHERE p.business_id = $1 AND p.deleted_at IS NULL AND r.deleted_at IS NULL AND r.moderation_status = 'approved' AND r.created_at >= $2`),
          q(
            `SELECT count(*)::int AS n FROM offers WHERE business_id = $1 AND status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`,
            [params.id],
          ),
        ]);
        const byStatus = Object.fromEntries(bookings.map((r) => [r.status, r.n]));
        return {
          periodDays: query.days,
          since: since.toISOString(),
          views: { total: views[0]!.n, daily },
          followers: { total: followers[0]!.n, new: newFollowers[0]!.n },
          bookings: {
            total: bookings.reduce((n, r) => n + r.n, 0),
            byStatus,
            upcoming: upcomingBookings[0]!.n,
          },
          events: {
            hosted: events[0]!.hosted,
            upcoming: events[0]!.upcoming,
            completed: events[0]!.completed,
            goingTotal: attendees[0]!.n,
          },
          posts: {
            count: posts[0]!.n,
            likes: posts[0]!.likes,
            comments: posts[0]!.comments,
            views: Number(posts[0]!.views),
          },
          reviews: { count: reviews[0]!.n, average: reviews[0]!.avg },
          offers: { active: offers[0]!.n },
        };
      },
    });

    // ================================================================== AI knowledge base
    const entryView = (e: ReturnType<typeof parseKnowledge>[number]) => ({
      id: e.id,
      title: e.title,
      content: e.content,
      category: e.category ?? null,
      status: e.status,
      approvedAt: e.approvedAt ?? null,
      approvedBy: e.approvedBy ?? null,
      updatedAt: e.updatedAt,
      // an approved entry whose text was tampered with is reported as stale rather than served
      stale: e.status === 'approved' && e.approvedHash !== knowledgeHash(e.title, e.content),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/ai',
      summary: 'AI assistant settings and knowledge entries (owner/admin)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'ai.manage', {
          allowInactive: true,
        });
        const { rows } = await ctx.db.query<{
          ai_assistant_enabled: boolean;
          ai_knowledge: unknown;
        }>('SELECT ai_assistant_enabled, ai_knowledge FROM businesses WHERE id = $1', [params.id]);
        return {
          enabled: rows[0]!.ai_assistant_enabled,
          entries: parseKnowledge(rows[0]!.ai_knowledge).map(entryView),
        };
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/businesses/:id/ai',
      summary: 'Switch the business AI assistant on or off (owner)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: z.object({ enabled: z.boolean() }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'ai.approve');
        await ctx.db.query('UPDATE businesses SET ai_assistant_enabled = $2 WHERE id = $1', [
          params.id,
          body.enabled,
        ]);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: body.enabled ? 'business.ai_enabled' : 'business.ai_disabled',
            targetType: 'business',
            targetId: params.id,
          },
          req,
        );
        return { enabled: body.enabled };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/ai/knowledge',
      summary: 'Add a knowledge entry (draft until an owner approves it)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: KnowledgeInput,
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'ai.manage');
        assertTextAllowed(body.title, body.content);
        const entry = newEntry(auth.userId, body);
        await mutateKnowledge(ctx, params.id, (entries) => ({
          entries: [...entries, entry],
          result: null,
        }));
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'business.ai_knowledge_added',
            targetType: 'business',
            targetId: params.id,
            metadata: { entryId: entry.id },
          },
          req,
        );
        void reply.code(201);
        return entryView(entry);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/businesses/:id/ai/knowledge/:entryId',
      summary: 'Edit an entry (an approved entry goes back to draft)',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), entryId: z.uuid() }),
      body: KnowledgeInput.partial().refine((b) => Object.keys(b).length > 0, {
        message: 'Nothing to update',
      }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'ai.manage');
        assertTextAllowed(body.title, body.content);
        const updated = await mutateKnowledge(ctx, params.id, (entries) => {
          const i = entries.findIndex((e) => e.id === params.entryId);
          if (i < 0) throw notFound('Knowledge entry');
          const cur = entries[i]!;
          const e = {
            ...cur,
            title: body.title ?? cur.title,
            content: body.content ?? cur.content,
            category: body.category ?? cur.category,
            updatedAt: new Date().toISOString(),
          };
          if (e.title !== cur.title || e.content !== cur.content)
            Object.assign(e, {
              status: 'draft',
              approvedBy: null,
              approvedAt: null,
              approvedHash: null,
            });
          const next = [...entries];
          next[i] = e;
          return { entries: next, result: e };
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'business.ai_knowledge_updated',
            targetType: 'business',
            targetId: params.id,
            metadata: { entryId: params.entryId },
          },
          req,
        );
        return entryView(updated);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/ai/knowledge/:entryId',
      summary: 'Delete an entry',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), entryId: z.uuid() }),
      handler: async ({ auth, req, params }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'ai.manage');
        await mutateKnowledge(ctx, params.id, (entries) => {
          if (!entries.some((e) => e.id === params.entryId)) throw notFound('Knowledge entry');
          return { entries: entries.filter((e) => e.id !== params.entryId), result: null };
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'business.ai_knowledge_deleted',
            targetType: 'business',
            targetId: params.id,
            metadata: { entryId: params.entryId },
          },
          req,
        );
      },
    });

    for (const decision of ['approve', 'revoke'] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/businesses/:id/ai/knowledge/:entryId/${decision}`,
        summary: `${decision === 'approve' ? 'Approve' : 'Revoke approval of'} an entry (owner only)`,
        tags: ['business'],
        auth: 'user',
        params: z.object({ id: z.uuid(), entryId: z.uuid() }),
        rateLimit: W,
        handler: async ({ auth, req, params }) => {
          await requireBusinessPermission(ctx.db, params.id, auth.userId, 'ai.approve');
          const updated = await mutateKnowledge(ctx, params.id, (entries) => {
            const i = entries.findIndex((e) => e.id === params.entryId);
            if (i < 0) throw notFound('Knowledge entry');
            const cur = entries[i]!;
            const e =
              decision === 'approve'
                ? {
                    ...cur,
                    status: 'approved' as const,
                    approvedBy: auth.userId,
                    approvedAt: new Date().toISOString(),
                    approvedHash: knowledgeHash(cur.title, cur.content),
                  }
                : {
                    ...cur,
                    status: 'draft' as const,
                    approvedBy: null,
                    approvedAt: null,
                    approvedHash: null,
                  };
            const next = [...entries];
            next[i] = e;
            return { entries: next, result: e };
          });
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: `business.ai_knowledge_${decision === 'approve' ? 'approved' : 'revoked'}`,
              targetType: 'business',
              targetId: params.id,
              metadata: { entryId: params.entryId },
            },
            req,
          );
          return entryView(updated);
        },
      });
    }

    // ================================================================== posts on behalf of the business
    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/posts',
      summary: 'Post on behalf of the business (team members with publishing rights)',
      tags: ['business'],
      auth: 'user',
      params: idParams,
      body: z.object({
        body: z.string().max(10_000).default(''),
        mediaIds: z.array(z.uuid()).max(10).optional(),
        linkUrl: z
          .url({ protocol: /^https?$/ })
          .max(2000)
          .optional(),
        topics: z.array(z.string().min(1).max(50)).max(10).optional(),
        language: z.string().min(2).max(10).optional(),
        placeId: z.uuid().optional(),
      }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        await requireBusinessPermission(ctx.db, params.id, auth.userId, 'posts.publish');
        const id = await createPost(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          { ...body, visibility: 'public', businessId: params.id },
        );
        ctx.metrics.events.inc({ name: 'business_post_created' });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'business.post_created',
            targetType: 'post',
            targetId: id,
            metadata: { businessId: params.id },
          },
          req,
        );
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2`,
          [auth.userId, id],
        );
        void reply.code(201);
        return {
          business: { id: params.id },
          post: (await hydratePosts(ctx, auth.userId, rows))[0],
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/posts',
      summary: 'Posts published on behalf of a business',
      tags: ['business'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const { b } = await loadBusiness(ctx.db, params.id, viewer);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.business_id = $2 AND ${postVisibleSql('$1::uuid')} AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
           ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
          [viewer, b.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydratePosts(ctx, viewer, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/businesses/:id/posts/:postId',
      summary: 'Delete a business post (its author, or owner/admin)',
      tags: ['business'],
      auth: 'user',
      params: z.object({ id: z.uuid(), postId: z.uuid() }),
      handler: async ({ auth, req, params }) => {
        const a = await requireBusinessPermission(ctx.db, params.id, auth.userId, 'posts.publish');
        const r = await ctx.db.query(
          `UPDATE posts SET deleted_at = now() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL AND (author_id = $3 OR $4::boolean)`,
          [params.postId, params.id, auth.userId, a.role === 'owner' || a.role === 'admin'],
        );
        if (!r.rowCount) throw notFound('Post');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'business.post_deleted',
            targetType: 'post',
            targetId: params.postId,
            metadata: { businessId: params.id },
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/events',
      summary: 'Upcoming events hosted by a business (only those you may see)',
      tags: ['business'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const { b } = await loadBusiness(ctx.db, params.id, viewer);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<EventRow>(
          `SELECT ${eventSelect('$1::uuid')} FROM events e WHERE e.host_business_id = $2 AND e.status = 'published' AND ${EVENT_END_SQL} >= now() AND ${eventVisibleSql('$1::uuid')}
             AND ($3::timestamptz IS NULL OR (e.starts_at, e.id) > ($3::timestamptz, $4::uuid)) ORDER BY e.starts_at, e.id LIMIT $5`,
          [viewer, b.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydrateEvents(ctx, viewer, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.starts_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    // ================================================================== staff: verification and suspension
    for (const action of ['verify', 'unverify'] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/staff/businesses/:id/${action}`,
        summary: `Staff: ${action} a business`,
        tags: ['business', 'staff'],
        auth: { staff: STAFF },
        params: idParams,
        body: z.object({ note: z.string().trim().max(1000).optional() }),
        rateLimit: { limit: 120, windowSec: 600, by: 'user' },
        handler: async ({ auth, req, params, body }) => {
          const r = await withTransaction(ctx.db, async (tx) => {
            const cur = await tx.query<{ verified_at: Date | null; owner_id: string | null }>(
              'SELECT verified_at, owner_id FROM businesses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
              [params.id],
            );
            if (!cur.rows[0]) throw notFound('Business');
            const was = Boolean(cur.rows[0].verified_at);
            if (was === (action === 'verify'))
              return { changed: false, owner: cur.rows[0].owner_id };
            await tx.query(
              action === 'verify'
                ? 'UPDATE businesses SET verified_at = now(), verified_by = $2 WHERE id = $1'
                : 'UPDATE businesses SET verified_at = NULL, verified_by = NULL WHERE id = $1 AND $2::uuid IS NOT NULL',
              [params.id, auth.userId],
            );
            await audit(
              ctx,
              {
                actorId: auth.userId,
                actorType: 'staff',
                action: `business.${action === 'verify' ? 'verified' : 'unverified'}`,
                targetType: 'business',
                targetId: params.id,
                metadata: { note: body.note ?? null },
              },
              req,
              tx,
            );
            return { changed: true, owner: cur.rows[0].owner_id };
          });
          if (r.changed && r.owner)
            await notify(ctx, {
              userId: r.owner,
              kind: `business_${action === 'verify' ? 'verified' : 'unverified'}`,
              actorId: null,
              targetType: 'business',
              targetId: params.id,
            });
          return { id: params.id, verified: action === 'verify' };
        },
      });
    }

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/staff/businesses/:id/status',
      summary: 'Staff: suspend or reinstate a business',
      tags: ['business', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({
        status: z.enum(['active', 'suspended']),
        reason: z.string().trim().min(3).max(1000),
      }),
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        const r = await ctx.db.query<{ owner_id: string | null }>(
          `UPDATE businesses SET status = $2 WHERE id = $1 AND deleted_at IS NULL AND status IN ('active','suspended') RETURNING owner_id`,
          [params.id, body.status],
        );
        if (!r.rows[0]) throw notFound('Business');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: `business.${body.status === 'suspended' ? 'suspended' : 'reinstated'}`,
            targetType: 'business',
            targetId: params.id,
            metadata: { reason: body.reason },
          },
          req,
        );
        if (r.rows[0].owner_id)
          await notify(ctx, {
            userId: r.rows[0].owner_id,
            kind: `business_${body.status === 'suspended' ? 'suspended' : 'reinstated'}`,
            actorId: null,
            targetType: 'business',
            targetId: params.id,
            data: { reason: body.reason },
          });
        return { id: params.id, status: body.status };
      },
    });

    void BUSINESS_PERMISSIONS;
    void isBlockedEitherWay;
  },
};
