import { z } from 'zod';
import {
  AppError,
  COMMUNITY_PERMISSIONS,
  SYSTEM_COMMUNITY_ROLES,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
  usernameSchema,
} from '@yapilapi/shared';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { isBlockedEitherWay, resolveUser } from '../../lib/users.js';
import { postVisibleSql } from '../../lib/visibility.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import {
  COMMUNITY_COLUMNS,
  RESERVED_SLUGS,
  activateMembership,
  can,
  escapeLike,
  getMe,
  getTarget,
  isUuid,
  loadCommunity,
  lockCommunity,
  paymentRequired,
  recountMembers,
  removeUserFromCommunities,
  requireFull,
  requireMember,
  resolveTopicIds,
  slugify,
  toView,
  topicsFor,
  type CommunityRow,
  type Me,
} from './service.js';
import type { DbRow } from '../../lib/db-row.js';

export {
  grantCommunityMembership,
  listCommunityKnowledge,
  removeUserFromCommunities,
} from './service.js';
export type { CommunityKnowledge } from './service.js';

// ------------------------------------------------------------------ schemas
const refParams = z.object({ id: z.string().trim().min(1).max(60) });
const memberParams = refParams.extend({ userId: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const VISIBILITIES = ['public', 'private', 'secret'] as const;
const JOIN_POLICIES = ['open', 'request', 'invite'] as const;
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{3,50}$/, 'Use 3-50 lowercase letters, numbers or hyphens');
const topicsSchema = z.array(z.string().trim().min(1).max(50)).max(10);
const rulesSchema = z
  .array(
    z.object({
      title: z.string().trim().min(1).max(100),
      body: z.string().trim().max(1000).default(''),
    }),
  )
  .max(20);
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');
const priceSchema = z.number().int().min(50).max(10_000_000);
const languageSchema = z.string().trim().min(2).max(10);
const permissionsSchema = z.array(z.enum(COMMUNITY_PERMISSIONS)).max(COMMUNITY_PERMISSIONS.length);

const createBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    slug: slugSchema.optional(),
    description: z.string().trim().max(5000).default(''),
    visibility: z.enum(VISIBILITIES).optional(),
    joinPolicy: z.enum(JOIN_POLICIES).optional(),
    topics: topicsSchema.default([]),
    rules: rulesSchema.default([]),
    language: languageSchema.optional(),
    isPaid: z.boolean().default(false),
    priceCents: priceSchema.optional(),
    currency: currencySchema.optional(),
  })
  .refine((b) => !b.isPaid || (b.priceCents !== undefined && b.currency !== undefined), {
    message: 'Paid communities need priceCents and currency',
  });

const updateBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(5000),
    visibility: z.enum(VISIBILITIES),
    joinPolicy: z.enum(JOIN_POLICIES),
    topics: topicsSchema,
    rules: rulesSchema,
    language: languageSchema.nullable(),
    isPaid: z.boolean(),
    priceCents: priceSchema,
    currency: currencySchema,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const listQuery = pageQuery.extend({
  topic: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  language: languageSchema.optional(),
});

const W = { limit: 60, windowSec: 600, by: 'user' } as const;

type Cursor = { t?: string; id?: string; n?: number; r?: number; u?: string; p?: number };

const notifyMany = async (
  ctx: AppContext,
  userIds: string[],
  n: {
    kind: string;
    actorId: string;
    targetType: string;
    targetId: string;
    data?: Record<string, unknown>;
  },
) => {
  for (const userId of userIds) await notify(ctx, { userId, ...n });
};

/** Users who can act on the approval queue: active members holding manage_members or moderate (capped). */
async function approvers(db: Queryable, communityId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT m.user_id FROM community_members m JOIN community_roles r ON r.community_id = m.community_id AND r.key = m.role_key
      WHERE m.community_id = $1 AND m.status = 'active' AND r.permissions && ARRAY['manage_members','moderate']::text[]
      ORDER BY r.rank DESC LIMIT 20`,
    [communityId],
  );
  return rows.map((r) => r.user_id);
}

/** Rank hierarchy: an actor may only act on members whose rank is strictly lower than their own. */
function assertOutranks(me: Me, target: { rank: number } | null): void {
  if (target && target.rank >= me.rank)
    throw forbidden('You cannot act on a member with a rank equal to or above yours');
}

const MEMBER_ADMIN = ['manage_members', 'moderate'] as const;

export const communitiesModule: ApiModule = {
  name: 'communities',
  register(app, ctx) {
    registerDeletionHook(async (_c, tx, userId) => removeUserFromCommunities(tx, userId));

    // ================================================================== create / read / update
    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities',
      summary: 'Create a community',
      tags: ['communities'],
      auth: 'user',
      body: createBody,
      rateLimit: { limit: 10, windowSec: 86_400, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        const teen = auth.ageBand === 'teen';
        // Accounts under 18 may only create private communities (never public or secret) and no paid ones, so that
        // adult moderators/owners are always visible to members and the community cannot be discovered publicly.
        const visibility = body.visibility ?? (teen ? 'private' : 'public');
        if (teen && visibility !== 'private')
          throw new AppError(
            'unprocessable',
            'Accounts under 18 can only create private communities',
          );
        if (teen && body.isPaid)
          throw new AppError('unprocessable', 'Accounts under 18 cannot create paid communities');
        const joinPolicy =
          body.joinPolicy ??
          (visibility === 'secret' ? 'invite' : visibility === 'private' ? 'request' : 'open');
        if (visibility === 'secret' && joinPolicy !== 'invite')
          throw invalid('Secret communities are invite-only');
        if (body.isPaid) await ctx.flags.require('COMMERCE', auth.userId);
        const topicIds = await resolveTopicIds(ctx.db, body.topics);

        let slug = body.slug ?? slugify(body.name);
        if (isUuid(slug) || RESERVED_SLUGS.has(slug)) {
          if (body.slug) throw invalid('That community address is not available');
          slug = `${slug}-${Math.random().toString(16).slice(2, 6)}`;
        }
        const taken = async (s: string) =>
          (
            await ctx.db.query(
              'SELECT 1 FROM communities WHERE slug = $1::citext AND deleted_at IS NULL',
              [s],
            )
          ).rowCount! > 0;
        if (await taken(slug)) {
          if (body.slug) throw conflict('That community address is already taken');
          for (let i = 0; i < 5 && (await taken(slug)); i++)
            slug = `${slugify(body.name).slice(0, 44)}-${Math.random().toString(16).slice(2, 6)}`;
        }

        const id = await withTransaction(ctx.db, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO communities (slug, name, description, visibility, join_policy, created_by, rules, language, is_paid, price_cents, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              slug,
              body.name,
              body.description,
              visibility,
              joinPolicy,
              auth.userId,
              JSON.stringify(body.rules),
              body.language ?? null,
              body.isPaid,
              body.isPaid ? body.priceCents : null,
              body.isPaid ? body.currency : null,
            ],
          );
          const cid = rows[0]!.id;
          for (const r of SYSTEM_COMMUNITY_ROLES) {
            await tx.query(
              `INSERT INTO community_roles (community_id, key, name, permissions, is_system, rank) VALUES ($1,$2,$3,$4,true,$5)`,
              [cid, r.key, r.name, r.permissions, r.rank],
            );
          }
          await tx.query(
            `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'owner','active',now())`,
            [cid, auth.userId],
          );
          if (topicIds.length)
            await tx.query(
              'INSERT INTO community_topics (community_id, topic_id) SELECT $1, unnest($2::uuid[])',
              [cid, topicIds],
            );
          await tx.query(
            `INSERT INTO conversations (kind, title, community_id, channel_name, channel_kind, created_by) VALUES ('community_channel','general',$1,'general','text',$2)`,
            [cid, auth.userId],
          );
          await recountMembers(tx, cid);
          return cid;
        });
        ctx.metrics.events.inc({ name: 'community_created' });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.created',
            targetType: 'community',
            targetId: id,
            metadata: { visibility, joinPolicy, isPaid: body.isPaid },
          },
          req,
        );
        const l = await loadCommunity(ctx.db, id, auth.userId);
        void reply.code(201);
        return toView(l.c, (await topicsFor(ctx.db, [id])).get(id) ?? [], l.me, l.full);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities',
      summary: 'Browse public communities',
      tags: ['communities'],
      auth: 'optional',
      query: listQuery,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<CommunityRow & { my_status: string | null }>(
          `SELECT ${COMMUNITY_COLUMNS}, m.status AS my_status
             FROM communities c LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = $1::uuid
            WHERE c.deleted_at IS NULL AND c.visibility = 'public'
              AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM community_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.community_id = c.id AND t.slug = $2::citext))
              AND ($3::text IS NULL OR c.search_tsv @@ websearch_to_tsquery('simple', $3::text) OR c.name ILIKE $4::text)
              AND ($5::text IS NULL OR c.language = $5::text)
              AND ($6::int IS NULL OR (c.member_count, c.id) < ($6::int, $7::uuid))
            ORDER BY c.member_count DESC, c.id DESC LIMIT $8`,
          [
            viewer,
            query.topic ?? null,
            query.q ?? null,
            query.q ? `%${escapeLike(query.q)}%` : null,
            query.language ?? null,
            cur?.n ?? null,
            cur?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const topics = await topicsFor(
          ctx.db,
          page.map((r) => r.id),
        );
        const last = page[page.length - 1];
        return {
          items: page.map((r) => {
            const { rules: _rules, ...view } = toView(r, topics.get(r.id) ?? [], null, false);
            return { ...view, viewer: r.my_status ? { status: r.my_status } : null };
          }),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ n: last.member_count, id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/communities',
      summary: 'Communities I belong to',
      tags: ['communities'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<
          CommunityRow & { role_key: string; rank: number; joined_at: Date }
        >(
          `SELECT ${COMMUNITY_COLUMNS}, m.role_key, r.rank, m.joined_at
             FROM community_members m JOIN communities c ON c.id = m.community_id AND c.deleted_at IS NULL
             JOIN community_roles r ON r.community_id = m.community_id AND r.key = m.role_key
            WHERE m.user_id = $1 AND m.status = 'active'
              AND ($2::timestamptz IS NULL OR (m.joined_at, c.id) < ($2::timestamptz, $3::uuid))
            ORDER BY m.joined_at DESC, c.id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const topics = await topicsFor(
          ctx.db,
          page.map((r) => r.id),
        );
        const last = page[page.length - 1];
        return {
          items: page.map((r) =>
            toView(
              r,
              topics.get(r.id) ?? [],
              { status: 'active', roleKey: r.role_key, rank: r.rank, permissions: [] },
              true,
            ),
          ),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.joined_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/community-invitations',
      summary: 'Pending community invitations for me',
      tags: ['communities'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<CommunityRow & { invited_at: Date }>(
          `SELECT ${COMMUNITY_COLUMNS}, m.created_at AS invited_at
             FROM community_members m JOIN communities c ON c.id = m.community_id AND c.deleted_at IS NULL
            WHERE m.user_id = $1 AND m.status = 'invited' AND NOT ($2::boolean AND c.visibility = 'secret')
              AND ($3::timestamptz IS NULL OR (m.created_at, c.id) < ($3::timestamptz, $4::uuid))
            ORDER BY m.created_at DESC, c.id DESC LIMIT $5`,
          [auth.userId, auth.ageBand === 'teen', cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const topics = await topicsFor(
          ctx.db,
          page.map((r) => r.id),
        );
        const last = page[page.length - 1];
        return {
          items: page.map((r) => {
            const { rules: _rules, ...view } = toView(
              r,
              topics.get(r.id) ?? [],
              { status: 'invited', roleKey: 'member', rank: 0, permissions: [] },
              false,
            );
            return { ...view, invitedAt: r.invited_at.toISOString() };
          }),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.invited_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id',
      summary: 'Get a community by id or slug',
      tags: ['communities'],
      auth: 'optional',
      params: refParams,
      handler: async ({ auth, params }) => {
        const l = await loadCommunity(ctx.db, params.id, auth?.userId ?? null);
        return toView(l.c, (await topicsFor(ctx.db, [l.c.id])).get(l.c.id) ?? [], l.me, l.full);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/communities/:id',
      summary: 'Update community settings',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: updateBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'manage_settings');
        const owner = me.roleKey === 'owner';
        const touchesAccess = body.visibility !== undefined || body.joinPolicy !== undefined;
        const touchesPaid =
          body.isPaid !== undefined || body.priceCents !== undefined || body.currency !== undefined;
        if (body.visibility !== undefined && body.visibility !== c.visibility && !owner)
          throw forbidden('Only the owner can change visibility');
        if (touchesPaid && !owner)
          throw forbidden('Only the owner can change paid membership settings');

        const visibility = body.visibility ?? c.visibility;
        if (auth.ageBand === 'teen' && visibility !== 'private')
          throw new AppError('unprocessable', 'Accounts under 18 can only run private communities');
        let joinPolicy = body.joinPolicy ?? c.join_policy;
        if (visibility === 'secret') {
          if (body.joinPolicy !== undefined && body.joinPolicy !== 'invite')
            throw invalid('Secret communities are invite-only');
          joinPolicy = 'invite';
        }
        let isPaid = c.is_paid;
        let price = c.price_cents;
        let currency = c.currency;
        if (touchesPaid) {
          if (auth.ageBand === 'teen')
            throw new AppError('unprocessable', 'Accounts under 18 cannot run paid communities');
          await ctx.flags.require('COMMERCE', auth.userId);
          isPaid = body.isPaid ?? c.is_paid;
          price = body.priceCents ?? c.price_cents;
          currency = body.currency ?? c.currency;
          if (isPaid && (price === null || currency === null))
            throw invalid('Paid communities need priceCents and currency');
          if (!isPaid) {
            price = null;
            currency = null;
          }
        }
        const topicIds = body.topics ? await resolveTopicIds(ctx.db, body.topics) : null;

        const sets: string[] = [];
        const vals: unknown[] = [c.id];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };
        if (body.name !== undefined) set('name', body.name);
        if (body.description !== undefined) set('description', body.description);
        if (touchesAccess || visibility !== c.visibility) {
          set('visibility', visibility);
          set('join_policy', joinPolicy);
        }
        if (body.rules !== undefined) set('rules', JSON.stringify(body.rules));
        if (body.language !== undefined) set('language', body.language);
        if (touchesPaid) {
          set('is_paid', isPaid);
          set('price_cents', price);
          set('currency', currency);
        }
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          if (sets.length)
            await tx.query(`UPDATE communities SET ${sets.join(', ')} WHERE id = $1`, vals);
          if (topicIds) {
            await tx.query('DELETE FROM community_topics WHERE community_id = $1', [c.id]);
            if (topicIds.length)
              await tx.query(
                'INSERT INTO community_topics (community_id, topic_id) SELECT $1, unnest($2::uuid[])',
                [c.id, topicIds],
              );
          }
        });
        const meta: Record<string, unknown> = { fields: Object.keys(body) };
        if (touchesAccess || touchesPaid)
          Object.assign(meta, { visibility, joinPolicy, isPaid, priceCents: price, currency });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.updated',
            targetType: 'community',
            targetId: c.id,
            metadata: meta,
          },
          req,
        );
        const l = await loadCommunity(ctx.db, c.id, auth.userId);
        return toView(l.c, (await topicsFor(ctx.db, [c.id])).get(c.id) ?? [], l.me, l.full);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id',
      summary: 'Delete a community (owner only)',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId);
        if (me.roleKey !== 'owner') throw forbidden('Only the owner can delete a community');
        await ctx.db.query(
          'UPDATE communities SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
          [c.id],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.deleted',
            targetType: 'community',
            targetId: c.id,
            metadata: { memberCount: c.member_count },
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/feed',
      summary: 'Community post feed',
      tags: ['communities'],
      auth: 'optional',
      params: refParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const { c } = await requireFull(ctx.db, params.id, viewer);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom}
            WHERE p.community_id = $2 AND p.visibility = 'community' AND ${postVisibleSql('$1::uuid')}
              AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
            ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
          [viewer, c.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
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

    // ================================================================== membership
    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/join',
      summary: 'Join (or request to join) a community',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        const { c, me } = await loadCommunity(ctx.db, params.id, auth.userId);
        if (me?.status === 'banned') throw forbidden('You cannot join this community');
        if (me?.status === 'active') return { status: 'active' };
        if (auth.ageBand === 'teen' && c.visibility === 'secret')
          throw forbidden('Accounts under 18 cannot join secret communities');
        // Paid communities are only ever entered through grantCommunityMembership() after a successful payment.
        if (c.is_paid) throw paymentRequired(c);
        const invited = me?.status === 'invited';
        if (!invited && c.join_policy === 'invite')
          throw forbidden('This community is invite-only');

        if (invited || c.join_policy === 'open') {
          await withTransaction(ctx.db, async (tx) => {
            await lockCommunity(tx, c.id);
            const cur = await getMe(tx, c.id, auth.userId);
            if (cur?.status === 'banned') throw forbidden('You cannot join this community');
            await activateMembership(tx, c.id, auth.userId);
          });
          return { status: 'active' };
        }
        // join_policy = 'request'
        if (me?.status === 'pending') return { status: 'pending' };
        const created = await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const r = await tx.query(
            `INSERT INTO community_members (community_id, user_id, role_key, status) VALUES ($1,$2,'member','pending')
             ON CONFLICT (community_id, user_id) DO UPDATE SET status = 'pending', role_key = 'member' WHERE community_members.status = 'left'`,
            [c.id, auth.userId],
          );
          return (r.rowCount ?? 0) > 0;
        });
        if (created) {
          await notifyMany(ctx, await approvers(ctx.db, c.id), {
            kind: 'community_join_request',
            actorId: auth.userId,
            targetType: 'community',
            targetId: c.id,
          });
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'community.join_requested',
              targetType: 'community',
              targetId: c.id,
            },
            req,
          );
        }
        return { status: 'pending' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/leave',
      summary: 'Leave a community, or cancel a request/decline an invite',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        const { c, me } = await loadCommunity(ctx.db, params.id, auth.userId);
        if (!me || !['active', 'pending', 'invited'].includes(me.status))
          throw notFound('Membership');
        if (me.status === 'active' && me.roleKey === 'owner')
          throw conflict('Transfer ownership before leaving this community');
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          await tx.query(
            `UPDATE community_members SET status = 'left', role_key = 'member' WHERE community_id = $1 AND user_id = $2 AND status IN ('active','pending','invited')`,
            [c.id, auth.userId],
          );
          await recountMembers(tx, c.id);
        });
        return { status: 'left' };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/members',
      summary: 'List members (or pending/invited/banned for moderators)',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      query: pageQuery.extend({
        status: z.enum(['active', 'pending', 'invited', 'banned']).default('active'),
      }),
      handler: async ({ auth, params, query }) => {
        const l =
          query.status === 'active'
            ? await requireFull(ctx.db, params.id, auth.userId)
            : await requireMember(ctx.db, params.id, auth.userId, ...MEMBER_ADMIN);
        const isMember = l.me?.status === 'active';
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT m.user_id, m.role_key, m.status, m.joined_at, r.rank, r.name AS role_name, p.username, p.display_name, p.avatar_url
             FROM community_members m
             JOIN community_roles r ON r.community_id = m.community_id AND r.key = m.role_key
             JOIN profiles p ON p.user_id = m.user_id
             JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL AND u.status IN ('active','pending_deletion')
            WHERE m.community_id = $1 AND m.status = $2
              AND NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $3 AND bl.blocked_id = m.user_id) OR (bl.blocker_id = m.user_id AND bl.blocked_id = $3))
              AND ($4::boolean OR u.age_band = 'adult' OR m.user_id = $3)
              AND ($5::int IS NULL OR (r.rank < $5::int OR (r.rank = $5::int AND m.user_id > $6::uuid)))
            ORDER BY r.rank DESC, m.user_id ASC LIMIT $7`,
          [l.c.id, query.status, auth.userId, isMember, cur?.r ?? null, cur?.u ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            user: {
              id: r.user_id,
              username: r.username,
              displayName: r.display_name,
              avatarUrl: r.avatar_url,
            },
            status: r.status,
            roleKey: r.role_key,
            roleName: r.role_name,
            rank: r.rank,
            joinedAt: r.joined_at ? (r.joined_at as Date).toISOString() : null,
          })),
          nextCursor:
            rows.length > limit && last ? encodeCursor({ r: last.rank, u: last.user_id }) : null,
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/members/:userId',
      summary: 'Remove a member (kick)',
      tags: ['communities'],
      auth: 'user',
      params: memberParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, ...MEMBER_ADMIN);
        if (params.userId === auth.userId) throw invalid('Use leave to leave a community');
        const target = await getTarget(ctx.db, c.id, params.userId);
        if (!target || !['active', 'pending', 'invited'].includes(target.status))
          throw notFound('Member');
        assertOutranks(me, target);
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          await tx.query(
            `UPDATE community_members SET status = 'left', role_key = 'member' WHERE community_id = $1 AND user_id = $2 AND status IN ('active','pending','invited')`,
            [c.id, params.userId],
          );
          await recountMembers(tx, c.id);
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.member.removed',
            targetType: 'community',
            targetId: c.id,
            metadata: {
              userId: params.userId,
              previousStatus: target.status,
              roleKey: target.roleKey,
            },
          },
          req,
        );
        if (target.status === 'active')
          await notify(ctx, {
            userId: params.userId,
            kind: 'community_removed',
            actorId: auth.userId,
            targetType: 'community',
            targetId: c.id,
          });
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/members/:userId/ban',
      summary: 'Ban a user from the community',
      tags: ['communities'],
      auth: 'user',
      params: memberParams,
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, ...MEMBER_ADMIN);
        if (params.userId === auth.userId) throw invalid('You cannot ban yourself');
        const exists = await ctx.db.query(
          `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [params.userId],
        );
        if (!exists.rowCount) throw notFound('User');
        const target = await getTarget(ctx.db, c.id, params.userId);
        assertOutranks(me, target);
        if (target?.status === 'banned') return { status: 'banned' };
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          await tx.query(
            `INSERT INTO community_members (community_id, user_id, role_key, status) VALUES ($1,$2,'member','banned')
             ON CONFLICT (community_id, user_id) DO UPDATE SET status = 'banned'`,
            [c.id, params.userId],
          );
          await recountMembers(tx, c.id);
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.member.banned',
            targetType: 'community',
            targetId: c.id,
            metadata: {
              userId: params.userId,
              reason: body.reason ?? null,
              previousStatus: target?.status ?? null,
            },
          },
          req,
        );
        await notify(ctx, {
          userId: params.userId,
          kind: 'community_banned',
          actorId: auth.userId,
          targetType: 'community',
          targetId: c.id,
        });
        return { status: 'banned' };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/members/:userId/ban',
      summary: 'Lift a ban',
      tags: ['communities'],
      auth: 'user',
      params: memberParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, ...MEMBER_ADMIN);
        const target = await getTarget(ctx.db, c.id, params.userId);
        if (target?.status !== 'banned') throw notFound('Ban');
        assertOutranks(me, target);
        await ctx.db.query(
          `DELETE FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'banned'`,
          [c.id, params.userId],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.member.unbanned',
            targetType: 'community',
            targetId: c.id,
            metadata: { userId: params.userId },
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/requests/:userId/approve',
      summary: 'Approve a join request',
      tags: ['communities'],
      auth: 'user',
      params: memberParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, ...MEMBER_ADMIN);
        if (c.is_paid) throw conflict('Paid communities can only be entered through payment');
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const cur = await getMe(tx, c.id, params.userId);
          if (cur?.status !== 'pending') throw notFound('Join request');
          await activateMembership(tx, c.id, params.userId);
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.request.approved',
            targetType: 'community',
            targetId: c.id,
            metadata: { userId: params.userId },
          },
          req,
        );
        await notify(ctx, {
          userId: params.userId,
          kind: 'community_request_approved',
          actorId: auth.userId,
          targetType: 'community',
          targetId: c.id,
        });
        return { status: 'active' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/requests/:userId/reject',
      summary: 'Reject a join request',
      tags: ['communities'],
      auth: 'user',
      params: memberParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, ...MEMBER_ADMIN);
        const r = await ctx.db.query(
          `UPDATE community_members SET status = 'left' WHERE community_id = $1 AND user_id = $2 AND status = 'pending'`,
          [c.id, params.userId],
        );
        if (!r.rowCount) throw notFound('Join request');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.request.rejected',
            targetType: 'community',
            targetId: c.id,
            metadata: { userId: params.userId },
          },
          req,
        );
        return { status: 'left' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/invitations',
      summary: 'Invite a user',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: z
        .object({ userId: z.uuid().optional(), username: usernameSchema.optional() })
        .refine((b) => Boolean(b.userId) !== Boolean(b.username), {
          message: 'Provide userId or username',
        }),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body, reply }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'invite');
        let targetId: string;
        if (body.username) targetId = (await resolveUser(ctx, auth.userId, body.username)).id;
        else {
          targetId = body.userId!;
          const u = await ctx.db.query(
            `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
            [targetId],
          );
          if (
            !u.rowCount ||
            (targetId !== auth.userId && (await isBlockedEitherWay(ctx.db, auth.userId, targetId)))
          )
            throw notFound('User');
        }
        if (targetId === auth.userId) throw invalid('You cannot invite yourself');
        const created = await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const cur = await getMe(tx, c.id, targetId);
          if (cur?.status === 'banned') throw forbidden('This person is banned from the community');
          if (cur?.status === 'active') throw conflict('Already a member');
          if (cur?.status === 'pending')
            throw conflict('This person already asked to join; approve their request instead');
          if (cur?.status === 'invited') return false;
          await tx.query(
            `INSERT INTO community_members (community_id, user_id, role_key, status) VALUES ($1,$2,'member','invited')
             ON CONFLICT (community_id, user_id) DO UPDATE SET status = 'invited', role_key = 'member' WHERE community_members.status = 'left'`,
            [c.id, targetId],
          );
          return true;
        });
        if (created) {
          await notify(ctx, {
            userId: targetId,
            kind: 'community_invite',
            actorId: auth.userId,
            targetType: 'community',
            targetId: c.id,
            data: { name: c.name },
          });
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'community.invited',
              targetType: 'community',
              targetId: c.id,
              metadata: { userId: targetId },
            },
            req,
          );
        }
        void reply.code(created ? 201 : 200);
        return { status: 'invited' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/invitation/accept',
      summary: 'Accept my invitation',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        const { c, me } = await loadCommunity(ctx.db, params.id, auth.userId);
        if (me?.status !== 'invited') throw notFound('Invitation');
        if (auth.ageBand === 'teen' && c.visibility === 'secret')
          throw forbidden('Accounts under 18 cannot join secret communities');
        if (c.is_paid) throw paymentRequired(c);
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          if ((await getMe(tx, c.id, auth.userId))?.status !== 'invited')
            throw notFound('Invitation');
          await activateMembership(tx, c.id, auth.userId);
        });
        return { status: 'active' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/invitation/decline',
      summary: 'Decline my invitation',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        const { c, me } = await loadCommunity(ctx.db, params.id, auth.userId);
        if (me?.status !== 'invited') throw notFound('Invitation');
        await ctx.db.query(
          `UPDATE community_members SET status = 'left' WHERE community_id = $1 AND user_id = $2 AND status = 'invited'`,
          [c.id, auth.userId],
        );
        return { status: 'left' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/transfer-ownership',
      summary: 'Transfer ownership to another member',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: z.object({ userId: z.uuid() }),
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId);
        if (me.roleKey !== 'owner') throw forbidden('Only the owner can transfer ownership');
        if (body.userId === auth.userId) throw invalid('You already own this community');
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const cur = await getMe(tx, c.id, auth.userId);
          if (cur?.roleKey !== 'owner') throw forbidden('Only the owner can transfer ownership');
          const t = await getMe(tx, c.id, body.userId);
          if (t?.status !== 'active') throw notFound('Member');
          await tx.query(
            `UPDATE community_members SET role_key = 'admin' WHERE community_id = $1 AND user_id = $2`,
            [c.id, auth.userId],
          );
          await tx.query(
            `UPDATE community_members SET role_key = 'owner' WHERE community_id = $1 AND user_id = $2`,
            [c.id, body.userId],
          );
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.ownership_transferred',
            targetType: 'community',
            targetId: c.id,
            metadata: { to: body.userId },
          },
          req,
        );
        await notify(ctx, {
          userId: body.userId,
          kind: 'community_ownership',
          actorId: auth.userId,
          targetType: 'community',
          targetId: c.id,
        });
        return { ownerId: body.userId };
      },
    });

    // ================================================================== roles & permissions
    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/roles',
      summary: 'List roles',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      handler: async ({ auth, params }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId);
        const { rows } = await ctx.db.query(
          `SELECT key, name, permissions, is_system, rank FROM community_roles WHERE community_id = $1 ORDER BY rank DESC, key`,
          [c.id],
        );
        return {
          items: rows.map((r) => ({
            key: r.key,
            name: r.name,
            permissions: r.permissions,
            isSystem: r.is_system,
            rank: r.rank,
          })),
        };
      },
    });

    const roleBody = z.object({
      name: z.string().trim().min(2).max(40),
      permissions: permissionsSchema,
      rank: z.number().int().min(1).max(99),
    });

    /** A role may only carry permissions its creator holds, and rank strictly below the creator's own. */
    const assertGrantable = (me: Me, perms: readonly string[], rank: number) => {
      if (rank >= me.rank)
        throw forbidden('You cannot create or edit a role at or above your own rank');
      for (const p of perms)
        if (!me.permissions.includes(p))
          throw forbidden(`You cannot grant a permission you do not have (${p})`);
    };

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/roles',
      summary: 'Create a custom role',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: roleBody.extend({
        key: z.string().regex(/^[a-z_]{3,30}$/, 'Use 3-30 lowercase letters or underscores'),
      }),
      rateLimit: W,
      handler: async ({ auth, req, params, body, reply }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'manage_roles');
        assertGrantable(me, body.permissions, body.rank);
        const perms = [...new Set(body.permissions)];
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const n = await tx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM community_roles WHERE community_id = $1',
            [c.id],
          );
          if (n.rows[0]!.n >= 24) throw conflict('This community has reached its role limit');
          await tx.query(
            `INSERT INTO community_roles (community_id, key, name, permissions, is_system, rank) VALUES ($1,$2,$3,$4,false,$5)`,
            [c.id, body.key, body.name, perms, body.rank],
          );
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.role.created',
            targetType: 'community',
            targetId: c.id,
            metadata: { key: body.key, permissions: perms, rank: body.rank },
          },
          req,
        );
        void reply.code(201);
        return {
          key: body.key,
          name: body.name,
          permissions: perms,
          isSystem: false,
          rank: body.rank,
        };
      },
    });

    const roleParams = refParams.extend({ key: z.string().regex(/^[a-z_]{3,30}$/) });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/communities/:id/roles/:key',
      summary: 'Update a custom role',
      tags: ['communities'],
      auth: 'user',
      params: roleParams,
      body: roleBody
        .partial()
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'manage_roles');
        const cur = await ctx.db.query<{
          name: string;
          permissions: string[];
          rank: number;
          is_system: boolean;
        }>(
          'SELECT name, permissions, rank, is_system FROM community_roles WHERE community_id = $1 AND key = $2',
          [c.id, params.key],
        );
        const role = cur.rows[0];
        if (!role) throw notFound('Role');
        if (role.is_system) throw forbidden('System roles cannot be modified');
        if (role.rank >= me.rank)
          throw forbidden('You cannot edit a role at or above your own rank');
        const perms = body.permissions ? [...new Set(body.permissions)] : role.permissions;
        const rank = body.rank ?? role.rank;
        assertGrantable(me, perms, rank);
        const name = body.name ?? role.name;
        await ctx.db.query(
          'UPDATE community_roles SET name = $3, permissions = $4, rank = $5 WHERE community_id = $1 AND key = $2 AND NOT is_system',
          [c.id, params.key, name, perms, rank],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.role.updated',
            targetType: 'community',
            targetId: c.id,
            metadata: { key: params.key, permissions: perms, rank },
          },
          req,
        );
        return { key: params.key, name, permissions: perms, isSystem: false, rank };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/roles/:key',
      summary: 'Delete a custom role (its members become plain members)',
      tags: ['communities'],
      auth: 'user',
      params: roleParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'manage_roles');
        await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const cur = await tx.query<{ rank: number; is_system: boolean }>(
            'SELECT rank, is_system FROM community_roles WHERE community_id = $1 AND key = $2',
            [c.id, params.key],
          );
          const role = cur.rows[0];
          if (!role) throw notFound('Role');
          if (role.is_system) throw forbidden('System roles cannot be deleted');
          if (role.rank >= me.rank)
            throw forbidden('You cannot delete a role at or above your own rank');
          await tx.query(
            `UPDATE community_members SET role_key = 'member' WHERE community_id = $1 AND role_key = $2`,
            [c.id, params.key],
          );
          await tx.query(
            'DELETE FROM community_roles WHERE community_id = $1 AND key = $2 AND NOT is_system',
            [c.id, params.key],
          );
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.role.deleted',
            targetType: 'community',
            targetId: c.id,
            metadata: { key: params.key },
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/communities/:id/members/:userId/role',
      summary: "Assign a member's role",
      tags: ['communities'],
      auth: 'user',
      params: memberParams,
      body: z.object({ roleKey: z.string().regex(/^[a-z_]{3,30}$/) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'manage_roles');
        const result = await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const target = await getTarget(tx, c.id, params.userId);
          if (target?.status !== 'active') throw notFound('Member');
          assertOutranks(me, target);
          const role = await tx.query<{ rank: number }>(
            'SELECT rank FROM community_roles WHERE community_id = $1 AND key = $2',
            [c.id, body.roleKey],
          );
          if (!role.rows[0]) throw notFound('Role');
          if (role.rows[0].rank >= me.rank)
            throw forbidden('You cannot assign a role at or above your own rank');
          await tx.query(
            'UPDATE community_members SET role_key = $3 WHERE community_id = $1 AND user_id = $2',
            [c.id, params.userId, body.roleKey],
          );
          return target.roleKey;
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.role.assigned',
            targetType: 'community',
            targetId: c.id,
            metadata: { userId: params.userId, from: result, to: body.roleKey },
          },
          req,
        );
        await notify(ctx, {
          userId: params.userId,
          kind: 'community_role_changed',
          actorId: auth.userId,
          targetType: 'community',
          targetId: c.id,
          data: { roleKey: body.roleKey },
        });
        return { userId: params.userId, roleKey: body.roleKey };
      },
    });

    // ================================================================== governance: resources
    const resourceBody = z.object({
      title: z.string().trim().min(1).max(200),
      url: z
        .url({ protocol: /^https?$/ })
        .max(2000)
        .optional(),
      body: z.string().trim().max(5000).default(''),
    });
    const resourceParams = refParams.extend({ rid: z.uuid() });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/resources',
      summary: 'List community resources (pinned first)',
      tags: ['communities'],
      auth: 'optional',
      params: refParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const { c } = await requireFull(ctx.db, params.id, auth?.userId ?? null);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT id, title, url, body, pinned, created_by, created_at FROM community_resources
            WHERE community_id = $1 AND deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR (pinned, created_at, id) < ($3::boolean, $2::timestamptz, $4::uuid))
            ORDER BY pinned DESC, created_at DESC, id DESC LIMIT $5`,
          [c.id, cur?.t ?? null, cur?.p === 1, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            id: r.id,
            title: r.title,
            url: r.url,
            body: r.body,
            pinned: r.pinned,
            createdBy: r.created_by,
            createdAt: (r.created_at as Date).toISOString(),
          })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({
                  p: last.pinned ? 1 : 0,
                  t: (last.created_at as Date).toISOString(),
                  id: last.id,
                })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/resources',
      summary: 'Add a resource',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: resourceBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body, reply }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'manage_resources');
        const { rows } = await ctx.db.query(
          `INSERT INTO community_resources (community_id, title, url, body, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, url, body, pinned, created_at`,
          [c.id, body.title, body.url ?? null, body.body, auth.userId],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.resource.created',
            targetType: 'community',
            targetId: c.id,
            metadata: { resourceId: rows[0]!.id },
          },
          req,
        );
        void reply.code(201);
        const r = rows[0]!;
        return {
          id: r.id,
          title: r.title,
          url: r.url,
          body: r.body,
          pinned: r.pinned,
          createdBy: auth.userId,
          createdAt: r.created_at.toISOString(),
        };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/communities/:id/resources/:rid',
      summary: 'Edit a resource',
      tags: ['communities'],
      auth: 'user',
      params: resourceParams,
      body: resourceBody
        .partial()
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'manage_resources');
        const { rows } = await ctx.db.query(
          `UPDATE community_resources SET title = COALESCE($3, title), url = CASE WHEN $4::boolean THEN $5 ELSE url END, body = COALESCE($6, body)
            WHERE id = $2 AND community_id = $1 AND deleted_at IS NULL RETURNING id, title, url, body, pinned`,
          [
            c.id,
            params.rid,
            body.title ?? null,
            body.url !== undefined,
            body.url ?? null,
            body.body ?? null,
          ],
        );
        if (!rows[0]) throw notFound('Resource');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.resource.updated',
            targetType: 'community',
            targetId: c.id,
            metadata: { resourceId: params.rid },
          },
          req,
        );
        return rows[0];
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/communities/:id/resources/:rid/pin',
      summary: 'Pin or unpin a resource',
      tags: ['communities'],
      auth: 'user',
      params: resourceParams,
      body: z.object({ pinned: z.boolean() }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'pin');
        const r = await ctx.db.query(
          `UPDATE community_resources SET pinned = $3 WHERE id = $2 AND community_id = $1 AND deleted_at IS NULL`,
          [c.id, params.rid, body.pinned],
        );
        if (!r.rowCount) throw notFound('Resource');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: body.pinned ? 'community.resource.pinned' : 'community.resource.unpinned',
            targetType: 'community',
            targetId: c.id,
            metadata: { resourceId: params.rid },
          },
          req,
        );
        return { pinned: body.pinned };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/resources/:rid',
      summary: 'Delete a resource',
      tags: ['communities'],
      auth: 'user',
      params: resourceParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'manage_resources');
        const r = await ctx.db.query(
          `UPDATE community_resources SET deleted_at = now() WHERE id = $2 AND community_id = $1 AND deleted_at IS NULL`,
          [c.id, params.rid],
        );
        if (!r.rowCount) throw notFound('Resource');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.resource.deleted',
            targetType: 'community',
            targetId: c.id,
            metadata: { resourceId: params.rid },
          },
          req,
        );
      },
    });

    // ================================================================== governance: decisions / FAQ (human-authored only)
    const decisionBody = z.object({
      kind: z.enum(['faq', 'decision', 'rule']),
      question: z.string().trim().min(1).max(300).optional(),
      body: z.string().trim().min(1).max(5000),
    });
    const decisionParams = refParams.extend({ did: z.uuid() });
    const decisionOut = (r: DbRow) => ({
      id: r.id,
      kind: r.kind,
      question: r.question,
      body: r.body,
      decidedBy: r.decided_by,
      createdAt: (r.created_at as Date).toISOString(),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/decisions',
      summary: 'List decisions and FAQ entries',
      tags: ['communities'],
      auth: 'optional',
      params: refParams,
      query: pageQuery.extend({ kind: z.enum(['faq', 'decision', 'rule']).optional() }),
      handler: async ({ auth, params, query }) => {
        const { c } = await requireFull(ctx.db, params.id, auth?.userId ?? null);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT id, kind, question, body, decided_by, created_at FROM community_decisions
            WHERE community_id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR kind = $2::text)
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC LIMIT $5`,
          [c.id, query.kind ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(decisionOut),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/decisions',
      summary: 'Record a decision or FAQ entry (moderators/admins only)',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: decisionBody.refine((b) => b.kind !== 'faq' || Boolean(b.question), {
        message: 'FAQ entries need a question',
      }),
      rateLimit: W,
      handler: async ({ auth, req, params, body, reply }) => {
        const { c } = await requireMember(
          ctx.db,
          params.id,
          auth.userId,
          'moderate',
          'manage_settings',
        );
        const { rows } = await ctx.db.query(
          `INSERT INTO community_decisions (community_id, kind, question, body, decided_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, question, body, decided_by, created_at`,
          [c.id, body.kind, body.question ?? null, body.body, auth.userId],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.decision.created',
            targetType: 'community',
            targetId: c.id,
            metadata: { decisionId: rows[0]!.id, kind: body.kind },
          },
          req,
        );
        void reply.code(201);
        return decisionOut(rows[0]!);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/communities/:id/decisions/:did',
      summary: 'Edit a decision or FAQ entry',
      tags: ['communities'],
      auth: 'user',
      params: decisionParams,
      body: decisionBody
        .partial()
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c } = await requireMember(
          ctx.db,
          params.id,
          auth.userId,
          'moderate',
          'manage_settings',
        );
        const { rows } = await ctx.db.query(
          `UPDATE community_decisions SET kind = COALESCE($3, kind), question = CASE WHEN $4::boolean THEN $5 ELSE question END, body = COALESCE($6, body)
            WHERE id = $2 AND community_id = $1 AND deleted_at IS NULL RETURNING id, kind, question, body, decided_by, created_at`,
          [
            c.id,
            params.did,
            body.kind ?? null,
            body.question !== undefined,
            body.question ?? null,
            body.body ?? null,
          ],
        );
        if (!rows[0]) throw notFound('Decision');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.decision.updated',
            targetType: 'community',
            targetId: c.id,
            metadata: { decisionId: params.did },
          },
          req,
        );
        return decisionOut(rows[0]);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/decisions/:did',
      summary: 'Delete a decision or FAQ entry',
      tags: ['communities'],
      auth: 'user',
      params: decisionParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c } = await requireMember(
          ctx.db,
          params.id,
          auth.userId,
          'moderate',
          'manage_settings',
        );
        const r = await ctx.db.query(
          `UPDATE community_decisions SET deleted_at = now() WHERE id = $2 AND community_id = $1 AND deleted_at IS NULL`,
          [c.id, params.did],
        );
        if (!r.rowCount) throw notFound('Decision');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.decision.deleted',
            targetType: 'community',
            targetId: c.id,
            metadata: { decisionId: params.did },
          },
          req,
        );
      },
    });

    // ================================================================== channels (rows in `conversations`; messaging module owns messages)
    const channelName = z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use 1-40 lowercase letters, numbers or hyphens');
    const channelOut = (r: DbRow) => ({
      id: r.id,
      name: r.channel_name,
      kind: r.channel_kind,
      archived: r.archived_at !== null,
      createdAt: (r.created_at as Date).toISOString(),
    });
    const CHANNEL_COLS = 'id, channel_name, channel_kind, archived_at, created_at';

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/channels',
      summary: 'List channels (members only)',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      handler: async ({ auth, params }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId);
        const { rows } = await ctx.db.query(
          `SELECT ${CHANNEL_COLS} FROM conversations WHERE community_id = $1 AND kind = 'community_channel' AND ($2::boolean OR archived_at IS NULL) ORDER BY created_at, id LIMIT 100`,
          [c.id, can(me, 'manage_channels')],
        );
        return { items: rows.map(channelOut) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/channels',
      summary: 'Create a channel',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      body: z.object({ name: channelName, kind: z.enum(['text', 'voice']).default('text') }),
      rateLimit: W,
      handler: async ({ auth, req, params, body, reply }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'manage_channels');
        const row = await withTransaction(ctx.db, async (tx) => {
          await lockCommunity(tx, c.id);
          const n = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM conversations WHERE community_id = $1 AND kind = 'community_channel' AND archived_at IS NULL`,
            [c.id],
          );
          if (n.rows[0]!.n >= 50) throw conflict('This community has reached its channel limit');
          const r = await tx.query(
            `INSERT INTO conversations (kind, title, community_id, channel_name, channel_kind, created_by) VALUES ('community_channel',$1,$2,$1,$3,$4) RETURNING ${CHANNEL_COLS}`,
            [body.name, c.id, body.kind, auth.userId],
          );
          return r.rows[0]!;
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.channel.created',
            targetType: 'community',
            targetId: c.id,
            metadata: { channelId: row.id, name: body.name, kind: body.kind },
          },
          req,
        );
        void reply.code(201);
        return channelOut(row);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/communities/:id/channels/:cid',
      summary: 'Rename, archive or unarchive a channel',
      tags: ['communities'],
      auth: 'user',
      params: refParams.extend({ cid: z.uuid() }),
      body: z
        .object({ name: channelName.optional(), archived: z.boolean().optional() })
        .refine((b) => b.name !== undefined || b.archived !== undefined, {
          message: 'Nothing to update',
        }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'manage_channels');
        const { rows } = await ctx.db.query(
          `UPDATE conversations SET channel_name = COALESCE($3, channel_name), title = COALESCE($3, title),
                  archived_at = CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4::boolean THEN COALESCE(archived_at, now()) ELSE NULL END
            WHERE id = $2 AND community_id = $1 AND kind = 'community_channel' RETURNING ${CHANNEL_COLS}`,
          [c.id, params.cid, body.name ?? null, body.archived ?? null],
        );
        if (!rows[0]) throw notFound('Channel');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.channel.updated',
            targetType: 'community',
            targetId: c.id,
            metadata: { channelId: params.cid, ...body },
          },
          req,
        );
        return channelOut(rows[0]);
      },
    });

    // ================================================================== community moderation
    const stateQuery = pageQuery.extend({
      state: z.enum(['pending_review', 'restricted']).optional(),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/communities/:id/moderation/queue',
      summary: 'Community posts awaiting review',
      tags: ['communities'],
      auth: 'user',
      params: refParams,
      query: stateQuery,
      handler: async ({ auth, params, query }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'moderate');
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const states = query.state ? [query.state] : ['pending_review', 'restricted'];
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom}
            WHERE p.community_id = $2 AND p.visibility = 'community' AND p.deleted_at IS NULL AND p.moderation_status = ANY($3::text[])
              AND ($4::timestamptz IS NULL OR (p.created_at, p.id) < ($4::timestamptz, $5::uuid))
            ORDER BY p.created_at DESC, p.id DESC LIMIT $6`,
          [auth.userId, c.id, states, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydratePosts(ctx, auth.userId, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    const postParams = refParams.extend({ postId: z.uuid() });
    const reasonBody = z.object({ reason: z.string().trim().max(500).optional() });

    /** Moderators cannot moderate content authored by a member who outranks (or equals) them. */
    const assertCanModerateAuthor = async (
      communityId: string,
      me: Me,
      actorId: string,
      authorId: string,
    ) => {
      if (authorId === actorId) return;
      const t = await getTarget(ctx.db, communityId, authorId);
      if (t?.status === 'active' && t.rank >= me.rank)
        throw forbidden('You cannot moderate content from a member who outranks you');
    };

    const removePost = async (
      communityId: string,
      postId: string,
      me: Me,
      actorId: string,
      req: Parameters<typeof audit>[2],
      reason: string | undefined,
      action: string,
    ) => {
      const p = await ctx.db.query<{ author_id: string }>(
        `SELECT author_id FROM posts WHERE id = $1 AND community_id = $2 AND visibility = 'community' AND deleted_at IS NULL`,
        [postId, communityId],
      );
      if (!p.rows[0]) throw notFound('Post');
      await assertCanModerateAuthor(communityId, me, actorId, p.rows[0].author_id);
      await ctx.db.query(
        `UPDATE posts SET deleted_at = now(), moderation_status = 'removed' WHERE id = $1 AND deleted_at IS NULL`,
        [postId],
      );
      await audit(
        ctx,
        {
          actorId,
          action,
          targetType: 'post',
          targetId: postId,
          metadata: { communityId, authorId: p.rows[0].author_id, reason: reason ?? null },
        },
        req,
      );
      await notify(ctx, {
        userId: p.rows[0].author_id,
        kind: 'community_content_removed',
        actorId,
        targetType: 'post',
        targetId: postId,
        data: { communityId },
      });
    };

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/posts/:postId',
      summary: 'Remove a community post (moderator)',
      tags: ['communities'],
      auth: 'user',
      params: postParams,
      body: reasonBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'moderate');
        await removePost(
          c.id,
          params.postId,
          me,
          auth.userId,
          req,
          body.reason,
          'community.post.removed',
        );
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/communities/:id/comments/:commentId',
      summary: 'Remove a comment on a community post (moderator)',
      tags: ['communities'],
      auth: 'user',
      params: refParams.extend({ commentId: z.uuid() }),
      body: reasonBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'moderate');
        const f = await ctx.db.query<{
          post_id: string;
          parent_id: string | null;
          author_id: string;
        }>(
          `SELECT cm.post_id, cm.parent_id, cm.author_id FROM comments cm JOIN posts po ON po.id = cm.post_id
            WHERE cm.id = $1 AND po.community_id = $2 AND po.visibility = 'community' AND cm.deleted_at IS NULL`,
          [params.commentId, c.id],
        );
        const cm = f.rows[0];
        if (!cm) throw notFound('Comment');
        await assertCanModerateAuthor(c.id, me, auth.userId, cm.author_id);
        await withTransaction(ctx.db, async (tx) => {
          await tx.query(
            `UPDATE comments SET deleted_at = now(), moderation_status = 'removed' WHERE id = $1`,
            [params.commentId],
          );
          await tx.query(
            'UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1',
            [cm.post_id],
          );
          if (cm.parent_id)
            await tx.query(
              'UPDATE comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1',
              [cm.parent_id],
            );
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.comment.removed',
            targetType: 'comment',
            targetId: params.commentId,
            metadata: {
              communityId: c.id,
              postId: cm.post_id,
              authorId: cm.author_id,
              reason: body.reason ?? null,
            },
          },
          req,
        );
        await notify(ctx, {
          userId: cm.author_id,
          kind: 'community_content_removed',
          actorId: auth.userId,
          targetType: 'comment',
          targetId: params.commentId,
          data: { communityId: c.id },
        });
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/moderation/posts/:postId/approve',
      summary: 'Approve a queued post',
      tags: ['communities'],
      auth: 'user',
      params: postParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const { c } = await requireMember(ctx.db, params.id, auth.userId, 'moderate');
        const r = await ctx.db.query<{ author_id: string }>(
          `UPDATE posts SET moderation_status = 'approved' WHERE id = $1 AND community_id = $2 AND visibility = 'community' AND deleted_at IS NULL
              AND moderation_status IN ('pending_review','restricted') RETURNING author_id`,
          [params.postId, c.id],
        );
        if (!r.rows[0]) throw notFound('Queued post');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'community.post.approved',
            targetType: 'post',
            targetId: params.postId,
            metadata: { communityId: c.id },
          },
          req,
        );
        await notify(ctx, {
          userId: r.rows[0].author_id,
          kind: 'community_post_approved',
          actorId: auth.userId,
          targetType: 'post',
          targetId: params.postId,
          data: { communityId: c.id },
        });
        return { moderationStatus: 'approved' };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:id/moderation/posts/:postId/reject',
      summary: 'Reject (remove) a queued post',
      tags: ['communities'],
      auth: 'user',
      params: postParams,
      body: reasonBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const { c, me } = await requireMember(ctx.db, params.id, auth.userId, 'moderate');
        const q = await ctx.db.query(
          `SELECT 1 FROM posts WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL AND moderation_status IN ('pending_review','restricted')`,
          [params.postId, c.id],
        );
        if (!q.rowCount) throw notFound('Queued post');
        await removePost(
          c.id,
          params.postId,
          me,
          auth.userId,
          req,
          body.reason,
          'community.post.rejected',
        );
        return { moderationStatus: 'removed' };
      },
    });
  },
};
