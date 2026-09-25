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
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { screenText } from '../../lib/moderation-hook.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { boundsSql, geoBounds, haversineSql } from '../../lib/geo.js';
import { isOpenNow } from '../../lib/hours.js';
import { assertOwnedImage } from '../../lib/media-check.js';
import { mediaUrl } from '../../lib/media-url.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { getBusinessAccess, can, requireBusinessPermission } from '../business/access.js';
import { EVENT_END_SQL, eventSelect, eventVisibleSql, type EventRow } from '../events/access.js';
import { hydrateEvents, loadUserSummaries } from '../events/views.js';
import type { ApiModule } from '../types.js';
import {
  PLACE_COLUMNS,
  PLACE_KINDS,
  applyPlacePatch,
  hydratePlaces,
  isPlaceReviewer,
  isPlaceStaff,
  loadPlace,
  lockPlace,
  placeCreateBody,
  placePatchBody,
  placeRole,
  recomputePlaceRating,
  requireEditor,
  suggestionChangesSchema,
  unprocessable,
  STAFF_REVIEWERS,
  type PlacePatch,
  type PlaceRow,
} from './service.js';
import type { FastifyRequest } from 'fastify';
import type { DbRow } from '../../lib/db-row.js';

export { recomputePlaceRating } from './service.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const W = { limit: 60, windowSec: 600, by: 'user' } as const;
const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual_content',
  'self_harm',
  'misinformation',
  'scam',
  'impersonation',
  'minor_safety',
  'illegal',
  'ip_violation',
  'other',
] as const;

type Cursor = { t?: string; id?: string; d?: number; n?: string };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

const listQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(PLACE_KINDS).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  businessId: z.uuid().optional(),
});
const nearbyQuery = pageQuery.extend({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.1).max(200).default(5),
  kind: z.enum(PLACE_KINDS).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  openNow: boolQuery.optional(),
  minRating: z.coerce.number().min(1).max(5).optional(),
});

export const placesModule: ApiModule = {
  name: 'places',
  register(app, ctx) {
    registerDeletionHook(async (_c, tx, userId) => {
      const { rows } = await tx.query<{ target_id: string }>(
        `SELECT DISTINCT target_id FROM reviews WHERE author_id = $1 AND target_type = 'place'`,
        [userId],
      );
      for (const r of rows)
        await tx.query('SELECT 1 FROM places WHERE id = $1 FOR UPDATE', [r.target_id]);
      await tx.query(`DELETE FROM reviews WHERE author_id = $1 AND target_type = 'place'`, [
        userId,
      ]);
      for (const r of rows) await recomputePlaceRating(tx, r.target_id);
      await tx.query('DELETE FROM place_edit_suggestions WHERE suggested_by = $1', [userId]);
      await tx.query(`DELETE FROM saves WHERE user_id = $1 AND target_type = 'place'`, [userId]);
      await tx.query(`DELETE FROM place_media WHERE added_by = $1`, [userId]);
      await tx.query(
        `UPDATE place_claims SET status = 'withdrawn' WHERE claimant_id = $1 AND status = 'pending'`,
        [userId],
      );
    });

    const placeView = async (
      viewerId: string | null,
      id: string,
      extra: Record<string, unknown> = {},
    ) => {
      const place = await loadPlace(ctx.db, id);
      const [v] = await hydratePlaces(ctx, viewerId, [place], { detail: true });
      return { ...v!, ...extra };
    };

    // ================================================================== CRUD
    route(app, ctx, {
      method: 'POST',
      url: '/v1/places',
      summary: 'Add a place (restaurant, store, venue, attraction, service)',
      tags: ['places'],
      auth: 'user',
      body: placeCreateBody,
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        if (auth.ageBand === 'teen') throw unprocessable('Accounts under 18 cannot add places');
        assertTextAllowed(body.name, body.description);
        // Duplicate guard: same name within 100 m.
        const params: unknown[] = [body.name, body.latitude, body.longitude];
        const bounds = boundsSql(
          'p.latitude',
          'p.longitude',
          geoBounds(body.latitude, body.longitude, 0.1),
          params,
        );
        const dup = await ctx.db.query<{ id: string }>(
          `SELECT p.id FROM places p WHERE p.deleted_at IS NULL AND lower(p.name) = lower($1) AND ${bounds} AND ${haversineSql('p.latitude', 'p.longitude', '$2', '$3')} <= 0.1 LIMIT 1`,
          params,
        );
        if (dup.rows[0])
          throw conflict('A place with this name already exists here', {
            reason: 'duplicate_place',
            placeId: dup.rows[0].id,
          });
        const { rows } = await ctx.db.query<{ id: string }>(
          `INSERT INTO places (name, kind, description, latitude, longitude, address, hours, timezone, phone, website, capacity, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            body.name,
            body.kind,
            body.description,
            body.latitude,
            body.longitude,
            JSON.stringify(body.address),
            JSON.stringify(body.hours),
            body.timezone,
            body.phone ?? null,
            body.website ?? null,
            body.capacity ?? null,
            auth.userId,
          ],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'place.created',
            targetType: 'place',
            targetId: rows[0]!.id,
            metadata: { kind: body.kind },
          },
          req,
        );
        void reply.code(201);
        return placeView(auth.userId, rows[0]!.id);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/:id',
      summary: 'Get a place (with isOpenNow computed in its own timezone)',
      tags: ['places'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const place = await loadPlace(ctx.db, params.id);
        const role = await placeRole(ctx.db, place, auth);
        const [v] = await hydratePlaces(ctx, auth?.userId ?? null, [place], { detail: true });
        const mine = auth
          ? await ctx.db.query<{ id: string }>(
              `SELECT id FROM reviews WHERE author_id = $1 AND target_type = 'place' AND target_id = $2 AND deleted_at IS NULL`,
              [auth.userId, params.id],
            )
          : null;
        return {
          ...v!,
          viewer: {
            ...v!.viewer,
            canEdit: role !== null,
            editRole: role,
            myReviewId: mine?.rows[0]?.id ?? null,
          },
        };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/places/:id',
      summary: 'Edit a place (owner team, staff, or the creator while unclaimed)',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: placePatchBody.and(z.object({ bookingEnabled: z.boolean().optional() })),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const place = await loadPlace(ctx.db, params.id);
        const role = await requireEditor(ctx.db, place, auth);
        const { bookingEnabled, ...patch } = body as PlacePatch & { bookingEnabled?: boolean };
        if (!Object.keys(patch).length && bookingEnabled === undefined)
          throw invalid('Nothing to update');
        if (bookingEnabled !== undefined && role !== 'owner_team' && role !== 'staff')
          throw forbidden('Only the owning business can change booking settings');
        if (bookingEnabled && !place.business_id)
          throw unprocessable('Claim this place with a business before enabling bookings');
        assertTextAllowed(patch.name, patch.description);
        await withTransaction(ctx.db, async (tx) => {
          await lockPlace(tx, params.id);
          await applyPlacePatch(tx, params.id, patch);
          if (bookingEnabled !== undefined)
            await tx.query('UPDATE places SET booking_enabled = $2 WHERE id = $1', [
              params.id,
              bookingEnabled,
            ]);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              actorType: role === 'staff' ? 'staff' : 'user',
              action: 'place.updated',
              targetType: 'place',
              targetId: params.id,
              metadata: { fields: Object.keys(body), role },
            },
            req,
            tx,
          );
        });
        return placeView(auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/places/:id',
      summary:
        'Delete a place (staff; owning business admins; or its creator while unclaimed and unreviewed)',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const place = await loadPlace(ctx.db, params.id);
        const role = await placeRole(ctx.db, place, auth);
        let allowed = role === 'staff' || (role === 'creator' && place.rating_count === 0);
        if (role === 'owner_team')
          allowed = can(
            await getBusinessAccess(ctx.db, place.business_id!, auth.userId),
            'claims.manage',
          );
        if (!allowed) throw forbidden('You cannot delete this place');
        await ctx.db.query(
          'UPDATE places SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
          [params.id],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: role === 'staff' ? 'staff' : 'user',
            action: 'place.deleted',
            targetType: 'place',
            targetId: params.id,
            metadata: { role },
          },
          req,
        );
      },
    });

    // ================================================================== search
    route(app, ctx, {
      method: 'GET',
      url: '/v1/places',
      summary: 'Search places by name/kind/city (alphabetical, keyset)',
      tags: ['places'],
      auth: 'optional',
      query: listQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const params: unknown[] = [];
        const where = ['p.deleted_at IS NULL'];
        const p = (v: unknown) => {
          params.push(v);
          return `$${params.length}`;
        };
        if (query.kind) where.push(`p.kind = ${p(query.kind)}`);
        if (query.city) where.push(`lower(p.address->>'city') = lower(${p(query.city)})`);
        if (query.businessId) where.push(`p.business_id = ${p(query.businessId)}`);
        if (query.q)
          where.push(
            `(p.name ILIKE ${p(`%${escapeLike(query.q)}%`)} ESCAPE '\\' OR p.search_tsv @@ plainto_tsquery('simple', ${p(query.q)}))`,
          );
        if (cur?.n !== undefined)
          where.push(`(lower(p.name), p.id) > (${p(cur.n)}::text, ${p(cur.id)}::uuid)`);
        const { rows } = await ctx.db.query<PlaceRow>(
          `SELECT ${PLACE_COLUMNS} FROM places p WHERE ${where.join(' AND ')} ORDER BY lower(p.name), p.id LIMIT ${p(limit + 1)}`,
          params,
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydratePlaces(ctx, auth?.userId ?? null, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ n: last.name.toLowerCase(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/nearby',
      summary:
        "Places within a radius, nearest first (haversine, keyset). openNow uses each place's own timezone.",
      tags: ['places'],
      auth: 'optional',
      query: nearbyQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        let cur = decodeCursor<Cursor>(query.cursor);
        const dist = haversineSql('p.latitude', 'p.longitude', '$1', '$2');
        const fetchBatch = async (after: Cursor | null, size: number) => {
          const params: unknown[] = [query.lat, query.lng, query.radiusKm];
          const where = [
            'p.deleted_at IS NULL',
            boundsSql(
              'p.latitude',
              'p.longitude',
              geoBounds(query.lat, query.lng, query.radiusKm),
              params,
            ),
          ];
          if (query.kind) {
            params.push(query.kind);
            where.push(`p.kind = $${params.length}`);
          }
          if (query.minRating) {
            params.push(query.minRating);
            where.push(`p.rating_count > 0 AND p.rating_avg >= $${params.length}`);
          }
          if (query.q) {
            params.push(`%${escapeLike(query.q)}%`, query.q);
            where.push(
              `(p.name ILIKE $${params.length - 1} ESCAPE '\\' OR p.search_tsv @@ plainto_tsquery('simple', $${params.length}))`,
            );
          }
          const outer = ['x.distance_km <= $3'];
          if (after && after.d !== undefined) {
            params.push(after.d, after.id);
            outer.push(
              `(x.distance_km, x.id) > ($${params.length - 1}::float8, $${params.length}::uuid)`,
            );
          }
          params.push(size);
          const { rows } = await ctx.db.query<PlaceRow & { distance_km: number }>(
            `SELECT * FROM (SELECT ${PLACE_COLUMNS}, ${dist} AS distance_km FROM places p WHERE ${where.join(' AND ')}) x WHERE ${outer.join(' AND ')} ORDER BY x.distance_km, x.id LIMIT $${params.length}`,
            params,
          );
          return rows;
        };
        const collected: Array<PlaceRow & { distance_km: number }> = [];
        let exhausted = false;
        let lastExamined: (PlaceRow & { distance_km: number }) | null = null;
        for (let i = 0; i < 8 && collected.length < limit + 1; i++) {
          const size = query.openNow ? (limit + 1) * 3 : limit + 1;
          const rows = await fetchBatch(cur, size);
          const now = new Date();
          for (const r of rows)
            if (!query.openNow || isOpenNow(r.hours, r.timezone, now) === true) collected.push(r);
          if (rows.length < size) {
            exhausted = true;
            break;
          }
          lastExamined = rows[rows.length - 1]!;
          cur = { d: lastExamined.distance_km, id: lastExamined.id };
        }
        let page = collected;
        let next: { d: number; id: string } | null = null;
        if (collected.length > limit) {
          page = collected.slice(0, limit);
          const last = page[page.length - 1]!;
          next = { d: last.distance_km, id: last.id };
        } else if (!exhausted && lastExamined)
          next = { d: lastExamined.distance_km, id: lastExamined.id };
        return {
          items: await hydratePlaces(ctx, auth?.userId ?? null, page),
          nextCursor: next ? encodeCursor(next) : null,
        };
      },
    });

    // ================================================================== saves
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/places/:id/save',
      summary: 'Save a place',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 300, windowSec: 600, by: 'user' },
      handler: async ({ auth, params }) => {
        await loadPlace(ctx.db, params.id);
        await ctx.db.query(
          `INSERT INTO saves (user_id, target_type, target_id) VALUES ($1,'place',$2) ON CONFLICT DO NOTHING`,
          [auth.userId, params.id],
        );
        return { saved: true };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/places/:id/save',
      summary: 'Unsave a place',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await ctx.db.query(
          `DELETE FROM saves WHERE user_id = $1 AND target_type = 'place' AND target_id = $2`,
          [auth.userId, params.id],
        );
      },
    });

    // ================================================================== photos
    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/:id/photos',
      summary: 'Approved photos (reviewers can list pending ones)',
      tags: ['places'],
      auth: 'optional',
      params: idParams,
      query: z.object({ status: z.enum(['approved', 'pending_review']).default('approved') }),
      handler: async ({ auth, params, query }) => {
        const place = await loadPlace(ctx.db, params.id);
        if (query.status === 'pending_review' && !(await isPlaceReviewer(ctx.db, place, auth)))
          throw forbidden('Only the place owner or staff can review photos');
        const { rows } = await ctx.db.query<{
          media_id: string;
          storage_key: string;
          caption: string | null;
          moderation_status: string;
          added_by: string | null;
        }>(
          `SELECT pm.media_id, m.storage_key, pm.caption, pm.moderation_status, pm.added_by FROM place_media pm JOIN media m ON m.id = pm.media_id AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')
            WHERE pm.place_id = $1 AND pm.moderation_status = $2 ORDER BY pm.position, pm.created_at`,
          [params.id, query.status],
        );
        return {
          items: rows.map((r) => ({
            mediaId: r.media_id,
            url: mediaUrl(ctx.config, r.storage_key),
            caption: r.caption,
            status: r.moderation_status,
            ...(query.status === 'pending_review' ? { addedBy: r.added_by } : {}),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/places/:id/photos',
      summary:
        "Add a photo (media you uploaded with purpose public). Non-owners' photos await review.",
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z.object({ mediaId: z.uuid(), caption: z.string().trim().max(300).optional() }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const place = await loadPlace(ctx.db, params.id);
        if (auth.ageBand === 'teen')
          throw unprocessable('Accounts under 18 cannot add place photos');
        await assertOwnedImage(ctx.db, body.mediaId, auth.userId);
        assertTextAllowed(body.caption);
        const role = await placeRole(ctx.db, place, auth);
        const status = role ? 'approved' : 'pending_review';
        await withTransaction(ctx.db, async (tx) => {
          await lockPlace(tx, params.id);
          const n = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM place_media WHERE place_id = $1 AND moderation_status IN ('approved','pending_review')`,
            [params.id],
          );
          if (n.rows[0]!.n >= 40)
            throw conflict('This place already has the maximum number of photos');
          const r = await tx.query(
            `INSERT INTO place_media (place_id, media_id, position, added_by, caption, moderation_status) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [params.id, body.mediaId, n.rows[0]!.n, auth.userId, body.caption ?? null, status],
          );
          if (!r.rowCount) throw conflict('That photo is already on this place');
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'place.photo_added',
              targetType: 'place',
              targetId: params.id,
              metadata: { mediaId: body.mediaId, status },
            },
            req,
            tx,
          );
        });
        void reply.code(201);
        return { mediaId: body.mediaId, status };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/places/:id/photos/:mediaId',
      summary: 'Approve or remove a photo (owner team / staff)',
      tags: ['places'],
      auth: 'user',
      params: z.object({ id: z.uuid(), mediaId: z.uuid() }),
      body: z.object({ status: z.enum(['approved', 'removed']) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const place = await loadPlace(ctx.db, params.id);
        if (!(await isPlaceReviewer(ctx.db, place, auth)))
          throw forbidden('Only the place owner or staff can review photos');
        const r = await ctx.db.query(
          'UPDATE place_media SET moderation_status = $3 WHERE place_id = $1 AND media_id = $2',
          [params.id, params.mediaId, body.status],
        );
        if (!r.rowCount) throw notFound('Photo');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: `place.photo_${body.status}`,
            targetType: 'place',
            targetId: params.id,
            metadata: { mediaId: params.mediaId },
          },
          req,
        );
        return { mediaId: params.mediaId, status: body.status };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/places/:id/photos/:mediaId',
      summary: 'Remove a photo you added (or any photo, as owner team / staff)',
      tags: ['places'],
      auth: 'user',
      params: z.object({ id: z.uuid(), mediaId: z.uuid() }),
      handler: async ({ auth, req, params }) => {
        const place = await loadPlace(ctx.db, params.id);
        const reviewer = await isPlaceReviewer(ctx.db, place, auth);
        const r = await ctx.db.query(
          'DELETE FROM place_media WHERE place_id = $1 AND media_id = $2 AND ($4::boolean OR added_by = $3)',
          [params.id, params.mediaId, auth.userId, reviewer],
        );
        if (!r.rowCount) throw notFound('Photo');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'place.photo_deleted',
            targetType: 'place',
            targetId: params.id,
            metadata: { mediaId: params.mediaId },
          },
          req,
        );
      },
    });

    // ================================================================== reviews
    const reviewView = async (viewerId: string | null, rows: Array<DbRow>) => {
      const users = await loadUserSummaries(ctx, [
        ...new Set(rows.map((r) => r.author_id as string)),
      ]);
      return rows.map((r) => ({
        id: r.id,
        placeId: r.target_id,
        author: users.get(r.author_id) ?? null,
        rating: r.rating,
        body: r.body,
        verifiedPurchase: r.verified_purchase,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        ownerReply: r.owner_reply
          ? { body: r.owner_reply, at: r.owner_reply_at?.toISOString() ?? null }
          : null,
        viewer: { isAuthor: viewerId === r.author_id },
        ...(viewerId === r.author_id ? { moderationStatus: r.moderation_status } : {}),
      }));
    };

    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/:id/reviews',
      summary: 'Reviews of a place (newest first; you also see your own pending review)',
      tags: ['places'],
      auth: 'optional',
      params: idParams,
      query: pageQuery.extend({ rating: z.coerce.number().int().min(1).max(5).optional() }),
      handler: async ({ auth, params, query }) => {
        await loadPlace(ctx.db, params.id);
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT r.* FROM reviews r
            WHERE r.target_type = 'place' AND r.target_id = $2 AND r.deleted_at IS NULL
              AND (r.moderation_status = 'approved' OR ($1::uuid IS NOT NULL AND r.author_id = $1::uuid AND r.moderation_status <> 'removed'))
              AND EXISTS (SELECT 1 FROM users ua WHERE ua.id = r.author_id AND ua.deleted_at IS NULL AND ua.status IN ('active','pending_deletion'))
              AND ($1::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $1::uuid AND bl.blocked_id = r.author_id) OR (bl.blocker_id = r.author_id AND bl.blocked_id = $1::uuid)))
              AND ($5::int IS NULL OR r.rating = $5)
              AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
            ORDER BY r.created_at DESC, r.id DESC LIMIT $6`,
          [viewer, params.id, cur?.t ?? null, cur?.id ?? null, query.rating ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await reviewView(viewer, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/places/:id/reviews',
      summary: 'Review a place (one per user; not your own business)',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z.object({
        rating: z.number().int().min(1).max(5),
        body: z.string().trim().max(4000).default(''),
      }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const place = await loadPlace(ctx.db, params.id);
        if (place.business_id && (await getBusinessAccess(ctx.db, place.business_id, auth.userId)))
          throw forbidden('You cannot review your own business');
        if (place.business_id) {
          const o = await ctx.db.query<{ owner_id: string | null }>(
            'SELECT owner_id FROM businesses WHERE id = $1',
            [place.business_id],
          );
          if (o.rows[0]?.owner_id === auth.userId)
            throw forbidden('You cannot review your own business');
          if (
            o.rows[0]?.owner_id &&
            (await isBlockedEitherWay(ctx.db, auth.userId, o.rows[0].owner_id))
          )
            throw notFound('Place');
        }
        const id = await withTransaction(ctx.db, async (tx) => {
          await lockPlace(tx, params.id);
          const ex = await tx.query<{ id: string; deleted_at: Date | null }>(
            `SELECT id, deleted_at FROM reviews WHERE author_id = $1 AND target_type = 'place' AND target_id = $2 FOR UPDATE`,
            [auth.userId, params.id],
          );
          let reviewId: string;
          if (ex.rows[0] && !ex.rows[0].deleted_at)
            throw conflict('You have already reviewed this place', { reviewId: ex.rows[0].id });
          if (ex.rows[0]) {
            // A previously deleted review is revived: (author, target) is unique.
            reviewId = ex.rows[0].id;
            await tx.query(
              `UPDATE reviews SET rating = $2, body = $3, deleted_at = NULL, moderation_status = 'approved', owner_reply = NULL, owner_reply_at = NULL, owner_reply_by = NULL, created_at = now() WHERE id = $1`,
              [reviewId, body.rating, body.body],
            );
          } else {
            const ins = await tx.query<{ id: string }>(
              `INSERT INTO reviews (author_id, target_type, target_id, rating, body) VALUES ($1,'place',$2,$3,$4) RETURNING id`,
              [auth.userId, params.id, body.rating, body.body],
            );
            reviewId = ins.rows[0]!.id;
          }
          if (body.body)
            await screenText(ctx, tx, {
              type: 'review',
              id: reviewId,
              authorId: auth.userId,
              text: body.body,
            });
          await recomputePlaceRating(tx, params.id);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'review.created',
              targetType: 'review',
              targetId: reviewId,
              metadata: { placeId: params.id, rating: body.rating },
            },
            req,
            tx,
          );
          return reviewId;
        });
        const { rows } = await ctx.db.query('SELECT * FROM reviews WHERE id = $1', [id]);
        void reply.code(201);
        return (await reviewView(auth.userId, rows))[0];
      },
    });

    const loadReview = async (id: string) => {
      const { rows } = await ctx.db.query<DbRow>(
        `SELECT r.*, p.business_id AS place_business_id, p.name AS place_name FROM reviews r JOIN places p ON p.id = r.target_id AND p.deleted_at IS NULL
          WHERE r.id = $1 AND r.target_type = 'place' AND r.deleted_at IS NULL`,
        [id],
      );
      if (!rows[0]) throw notFound('Review');
      return rows[0];
    };

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/reviews/:id',
      summary: 'Edit your review',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z
        .object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(4000) })
        .partial()
        .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const r = await loadReview(params.id);
        if (r.author_id !== auth.userId) throw notFound('Review');
        if (r.moderation_status !== 'approved')
          throw forbidden('This review is under moderation and cannot be edited');
        await withTransaction(ctx.db, async (tx) => {
          await lockPlace(tx, r.target_id);
          await tx.query(
            'UPDATE reviews SET rating = COALESCE($2, rating), body = COALESCE($3, body) WHERE id = $1',
            [params.id, body.rating ?? null, body.body ?? null],
          );
          if (body.body)
            await screenText(ctx, tx, {
              type: 'review',
              id: params.id,
              authorId: auth.userId,
              text: body.body,
            });
          await recomputePlaceRating(tx, r.target_id);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'review.updated',
              targetType: 'review',
              targetId: params.id,
            },
            req,
            tx,
          );
        });
        const { rows } = await ctx.db.query('SELECT * FROM reviews WHERE id = $1', [params.id]);
        return (await reviewView(auth.userId, rows))[0];
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/reviews/:id',
      summary: 'Delete your review',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const r = await loadReview(params.id);
        if (r.author_id !== auth.userId) throw notFound('Review');
        await withTransaction(ctx.db, async (tx) => {
          await lockPlace(tx, r.target_id);
          await tx.query('UPDATE reviews SET deleted_at = now() WHERE id = $1', [params.id]);
          await recomputePlaceRating(tx, r.target_id);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'review.deleted',
              targetType: 'review',
              targetId: params.id,
            },
            req,
            tx,
          );
        });
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/reviews/:id/reply',
      summary: "Reply to a review as the place's business team",
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z.object({ body: z.string().trim().min(1).max(2000) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const r = await loadReview(params.id);
        if (!r.place_business_id) throw notFound('Review');
        await requireBusinessPermission(ctx.db, r.place_business_id, auth.userId, 'reviews.reply');
        if (r.moderation_status !== 'approved') throw conflict('This review is under moderation');
        assertTextAllowed(body.body);
        await ctx.db.query(
          'UPDATE reviews SET owner_reply = $2, owner_reply_at = now(), owner_reply_by = $3 WHERE id = $1',
          [params.id, body.body, auth.userId],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'review.replied',
            targetType: 'review',
            targetId: params.id,
          },
          req,
        );
        await notify(ctx, {
          userId: r.author_id,
          kind: 'review_reply',
          actorId: auth.userId,
          targetType: 'place',
          targetId: r.target_id,
          data: { place: r.place_name },
        });
        const { rows } = await ctx.db.query('SELECT * FROM reviews WHERE id = $1', [params.id]);
        return (await reviewView(auth.userId, rows))[0];
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/reviews/:id/reply',
      summary: 'Remove the business reply',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const r = await loadReview(params.id);
        if (!r.place_business_id) throw notFound('Review');
        await requireBusinessPermission(ctx.db, r.place_business_id, auth.userId, 'reviews.reply');
        await ctx.db.query(
          'UPDATE reviews SET owner_reply = NULL, owner_reply_at = NULL, owner_reply_by = NULL WHERE id = $1',
          [params.id],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'review.reply_removed',
            targetType: 'review',
            targetId: params.id,
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/reviews/:id/report',
      summary: 'Report a review to the safety team',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z.object({
        reason: z.enum(REPORT_REASONS),
        details: z.string().trim().max(2000).optional(),
      }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const r = await loadReview(params.id);
        if (r.author_id === auth.userId) throw invalid('You cannot report your own review');
        if (
          r.moderation_status !== 'approved' ||
          (await isBlockedEitherWay(ctx.db, auth.userId, r.author_id))
        )
          throw notFound('Review');
        const ins = await ctx.db.query(
          `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1,'review',$2,$3,$4) ON CONFLICT (reporter_id, target_type, target_id, reason) DO NOTHING`,
          [auth.userId, params.id, body.reason, body.details ?? null],
        );
        if (ins.rowCount)
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'review.reported',
              targetType: 'review',
              targetId: params.id,
              metadata: { reason: body.reason },
            },
            req,
          );
        void reply.code(ins.rowCount ? 201 : 200);
        return { reported: true };
      },
    });

    // ================================================================== claims (business ownership, staff verified)
    const claimView = (r: DbRow) => ({
      id: r.id,
      status: r.status,
      evidence: r.evidence,
      decisionNote: r.decision_note,
      decidedAt: r.decided_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      place: { id: r.place_id, name: r.place_name },
      business: {
        id: r.business_id,
        slug: r.business_slug,
        name: r.business_name,
        verified: Boolean(r.business_verified_at),
      },
      ...(r.claimant_username !== undefined
        ? { claimant: { id: r.claimant_id, username: r.claimant_username } }
        : {}),
    });
    const CLAIM_SELECT = `SELECT c.*, p.name AS place_name, b.slug AS business_slug, b.name AS business_name, b.verified_at AS business_verified_at, pr.username AS claimant_username
       FROM place_claims c JOIN places p ON p.id = c.place_id JOIN businesses b ON b.id = c.business_id LEFT JOIN profiles pr ON pr.user_id = c.claimant_id`;

    route(app, ctx, {
      method: 'POST',
      url: '/v1/places/:id/claims',
      summary: 'Claim a place for your business (pending staff verification)',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z.object({ businessId: z.uuid(), evidence: z.string().trim().max(2000).default('') }),
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const place = await loadPlace(ctx.db, params.id);
        await requireBusinessPermission(ctx.db, body.businessId, auth.userId, 'claims.manage');
        if (place.business_id)
          throw conflict(
            place.business_id === body.businessId
              ? 'This place already belongs to your business'
              : 'This place is already claimed',
            { reason: 'already_claimed' },
          );
        assertTextAllowed(body.evidence);
        const id = await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO place_claims (place_id, business_id, claimant_id, evidence) VALUES ($1,$2,$3,$4) RETURNING id`,
            [params.id, body.businessId, auth.userId, body.evidence],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'place.claim_requested',
              targetType: 'place',
              targetId: params.id,
              metadata: { claimId: r.rows[0]!.id, businessId: body.businessId },
            },
            req,
            tx,
          );
          return r.rows[0]!.id;
        });
        const { rows } = await ctx.db.query(`${CLAIM_SELECT} WHERE c.id = $1`, [id]);
        void reply.code(201);
        return claimView(rows[0]!);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/place-claims',
      summary: 'Place claims made by businesses you manage',
      tags: ['places'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `${CLAIM_SELECT} WHERE c.business_id IN (SELECT business_id FROM business_members WHERE user_id = $1 AND role IN ('owner','admin'))
              AND ($2::timestamptz IS NULL OR (c.created_at, c.id) < ($2::timestamptz, $3::uuid)) ORDER BY c.created_at DESC, c.id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(claimView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/place-claims/:id/withdraw',
      summary: 'Withdraw a pending claim',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const { rows } = await ctx.db.query<{
          business_id: string;
          place_id: string;
          status: string;
        }>('SELECT business_id, place_id, status FROM place_claims WHERE id = $1', [params.id]);
        if (!rows[0]) throw notFound('Claim');
        await requireBusinessPermission(ctx.db, rows[0].business_id, auth.userId, 'claims.manage', {
          allowInactive: true,
        });
        const r = await ctx.db.query(
          `UPDATE place_claims SET status = 'withdrawn' WHERE id = $1 AND status = 'pending'`,
          [params.id],
        );
        if (!r.rowCount) throw conflict('Only pending claims can be withdrawn');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'place.claim_withdrawn',
            targetType: 'place',
            targetId: rows[0].place_id,
            metadata: { claimId: params.id },
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/place-claims',
      summary: 'Staff: claim verification queue',
      tags: ['places', 'staff'],
      auth: { staff: STAFF_REVIEWERS },
      query: pageQuery.extend({
        status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
      }),
      handler: async ({ query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `${CLAIM_SELECT} WHERE c.status = $1 AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2::timestamptz, $3::uuid)) ORDER BY c.created_at, c.id LIMIT $4`,
          [query.status, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(claimView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    const decideClaim =
      (decision: 'approved' | 'rejected') =>
      async ({
        auth,
        req,
        params,
        body,
      }: {
        auth: { userId: string };
        req: FastifyRequest;
        params: { id: string };
        body: { note?: string | undefined };
      }) => {
        const out = await withTransaction(ctx.db, async (tx) => {
          // Lock order is always place -> claim, so two staff members deciding competing claims of one place serialise instead of deadlocking.
          const pre = await tx.query<{ place_id: string }>(
            'SELECT place_id FROM place_claims WHERE id = $1',
            [params.id],
          );
          if (!pre.rows[0]) throw notFound('Claim');
          await tx.query('SELECT 1 FROM places WHERE id = $1 FOR UPDATE', [pre.rows[0].place_id]);
          const c = await tx.query<{
            id: string;
            place_id: string;
            business_id: string;
            claimant_id: string | null;
            status: string;
          }>(
            'SELECT id, place_id, business_id, claimant_id, status FROM place_claims WHERE id = $1 FOR UPDATE',
            [params.id],
          );
          const claim = c.rows[0];
          if (!claim) throw notFound('Claim');
          if (claim.status !== 'pending')
            throw conflict(`This claim was already ${claim.status}`, { reason: 'not_pending' });
          if (decision === 'approved') {
            const p = await tx.query<{ business_id: string | null }>(
              'SELECT business_id FROM places WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
              [claim.place_id],
            );
            if (!p.rows[0]) throw notFound('Place');
            if (p.rows[0].business_id)
              throw conflict('This place is already claimed', { reason: 'already_claimed' });
            const b = await tx.query(
              `SELECT 1 FROM businesses WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
              [claim.business_id],
            );
            if (!b.rowCount) throw unprocessable('The claiming business is not active');
            await tx.query('UPDATE places SET business_id = $2 WHERE id = $1', [
              claim.place_id,
              claim.business_id,
            ]);
            await tx.query(
              `UPDATE place_claims SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'Another claim for this place was approved' WHERE place_id = $1 AND status = 'pending' AND id <> $3`,
              [claim.place_id, auth.userId, claim.id],
            );
          }
          await tx.query(
            `UPDATE place_claims SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
            [claim.id, decision, auth.userId, body.note ?? null],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              actorType: 'staff',
              action: `place.claim_${decision}`,
              targetType: 'place',
              targetId: claim.place_id,
              metadata: {
                claimId: claim.id,
                businessId: claim.business_id,
                note: body.note ?? null,
              },
            },
            req,
            tx,
          );
          return claim;
        });
        if (out.claimant_id)
          await notify(ctx, {
            userId: out.claimant_id,
            kind: `place_claim_${decision}`,
            actorId: null,
            targetType: 'place',
            targetId: out.place_id,
            data: { businessId: out.business_id, note: body.note ?? null },
          });
        const { rows } = await ctx.db.query(`${CLAIM_SELECT} WHERE c.id = $1`, [params.id]);
        return claimView(rows[0]!);
      };
    for (const decision of ['approved', 'rejected'] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/staff/place-claims/:id/${decision === 'approved' ? 'approve' : 'reject'}`,
        summary: `Staff: ${decision === 'approved' ? 'approve' : 'reject'} a place claim`,
        tags: ['places', 'staff'],
        auth: { staff: STAFF_REVIEWERS },
        params: idParams,
        body: z.object({ note: z.string().trim().max(1000).optional() }),
        rateLimit: { limit: 120, windowSec: 600, by: 'user' },
        handler: decideClaim(decision),
      });
    }

    // ================================================================== suggest an edit
    const suggestionView = (r: DbRow) => ({
      id: r.id,
      placeId: r.place_id,
      placeName: r.place_name,
      changes: r.changes,
      note: r.note,
      status: r.status,
      reviewNote: r.review_note,
      suggestedBy: r.suggested_by,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    });
    const SUGGESTION_SELECT = `SELECT s.*, p.name AS place_name FROM place_edit_suggestions s JOIN places p ON p.id = s.place_id AND p.deleted_at IS NULL`;

    route(app, ctx, {
      method: 'POST',
      url: '/v1/places/:id/suggestions',
      summary: 'Suggest an edit for the owner / staff to review',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      body: z.object({
        changes: suggestionChangesSchema,
        note: z.string().trim().max(1000).default(''),
      }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        await loadPlace(ctx.db, params.id);
        assertTextAllowed(body.changes.name, body.changes.description, body.note);
        const n = await ctx.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM place_edit_suggestions WHERE place_id = $1 AND suggested_by = $2 AND status = 'pending'`,
          [params.id, auth.userId],
        );
        if (n.rows[0]!.n >= 5)
          throw conflict('You already have 5 pending suggestions for this place');
        const { rows } = await ctx.db.query<{ id: string }>(
          `INSERT INTO place_edit_suggestions (place_id, suggested_by, changes, note) VALUES ($1,$2,$3,$4) RETURNING id`,
          [params.id, auth.userId, JSON.stringify(body.changes), body.note],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'place.edit_suggested',
            targetType: 'place',
            targetId: params.id,
            metadata: { suggestionId: rows[0]!.id, fields: Object.keys(body.changes) },
          },
          req,
        );
        const r = await ctx.db.query(`${SUGGESTION_SELECT} WHERE s.id = $1`, [rows[0]!.id]);
        void reply.code(201);
        return suggestionView(r.rows[0]!);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/:id/suggestions',
      summary: 'Suggestions for a place (owner team / staff)',
      tags: ['places'],
      auth: 'user',
      params: idParams,
      query: pageQuery.extend({
        status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']).default('pending'),
      }),
      handler: async ({ auth, params, query }) => {
        const place = await loadPlace(ctx.db, params.id);
        if (!(await isPlaceReviewer(ctx.db, place, auth)))
          throw forbidden('Only the place owner or staff can review suggestions');
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `${SUGGESTION_SELECT} WHERE s.place_id = $1 AND s.status = $2 AND ($3::timestamptz IS NULL OR (s.created_at, s.id) > ($3::timestamptz, $4::uuid)) ORDER BY s.created_at, s.id LIMIT $5`,
          [params.id, query.status, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(suggestionView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/place-suggestions',
      summary: 'Edits you suggested',
      tags: ['places'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `${SUGGESTION_SELECT} WHERE s.suggested_by = $1 AND ($2::timestamptz IS NULL OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid)) ORDER BY s.created_at DESC, s.id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(suggestionView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    const decideSuggestion = async (
      auth: { userId: string; platformRole: string; mfaVerified: boolean },
      req: FastifyRequest,
      id: string,
      decision: 'accepted' | 'rejected' | 'withdrawn',
      note?: string,
    ) => {
      const found = await ctx.db.query<{ place_id: string; suggested_by: string | null }>(
        'SELECT place_id, suggested_by FROM place_edit_suggestions WHERE id = $1',
        [id],
      );
      if (!found.rows[0]) throw notFound('Suggestion');
      const place = await loadPlace(ctx.db, found.rows[0].place_id);
      const reviewer = await isPlaceReviewer(ctx.db, place, auth as never);
      if (decision === 'withdrawn') {
        if (found.rows[0].suggested_by !== auth.userId) throw notFound('Suggestion');
      } else if (!reviewer)
        throw found.rows[0].suggested_by === auth.userId
          ? forbidden('You cannot review your own suggestion')
          : notFound('Suggestion');
      const staff = isPlaceStaff(auth as never);
      await withTransaction(ctx.db, async (tx) => {
        const s = await tx.query<{ changes: unknown; status: string }>(
          'SELECT changes, status FROM place_edit_suggestions WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (s.rows[0]!.status !== 'pending')
          throw conflict(`This suggestion was already ${s.rows[0]!.status}`, {
            reason: 'not_pending',
          });
        if (decision === 'accepted') {
          const parsed = suggestionChangesSchema.safeParse(s.rows[0]!.changes);
          if (!parsed.success) throw unprocessable('This suggestion is no longer valid');
          await lockPlace(tx, place.id);
          await applyPlacePatch(tx, place.id, parsed.data);
        }
        await tx.query(
          `UPDATE place_edit_suggestions SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
          [id, decision, auth.userId, note ?? null],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: staff && decision !== 'withdrawn' ? 'staff' : 'user',
            action: `place.suggestion_${decision}`,
            targetType: 'place',
            targetId: place.id,
            metadata: { suggestionId: id },
          },
          req,
          tx,
        );
      });
      if (decision !== 'withdrawn' && found.rows[0].suggested_by) {
        await notify(ctx, {
          userId: found.rows[0].suggested_by,
          kind: `place_suggestion_${decision}`,
          actorId: null,
          targetType: 'place',
          targetId: place.id,
          data: { name: place.name, note: note ?? null },
        });
      }
      const r = await ctx.db.query(`${SUGGESTION_SELECT} WHERE s.id = $1`, [id]);
      return suggestionView(r.rows[0]!);
    };
    for (const decision of ['accepted', 'rejected', 'withdrawn'] as const) {
      const path =
        decision === 'accepted' ? 'accept' : decision === 'rejected' ? 'reject' : 'withdraw';
      route(app, ctx, {
        method: 'POST',
        url: `/v1/place-suggestions/:id/${path}`,
        summary: `${path[0]!.toUpperCase()}${path.slice(1)} a place edit suggestion`,
        tags: ['places'],
        auth: 'user',
        params: idParams,
        body: z.object({ note: z.string().trim().max(1000).optional() }),
        rateLimit: W,
        handler: async ({ auth, req, params, body }) =>
          decideSuggestion(auth as never, req, params.id, decision, body.note),
      });
    }

    // ================================================================== events & products of a place
    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/:id/events',
      summary: 'Upcoming events at a place (only those you may see)',
      tags: ['places'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        await loadPlace(ctx.db, params.id);
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<EventRow>(
          `SELECT ${eventSelect('$1::uuid')} FROM events e
            WHERE e.place_id = $2 AND e.status = 'published' AND ${EVENT_END_SQL} >= now() AND ${eventVisibleSql('$1::uuid')}
              AND ($3::timestamptz IS NULL OR (e.starts_at, e.id) > ($3::timestamptz, $4::uuid))
            ORDER BY e.starts_at, e.id LIMIT $5`,
          [viewer, params.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
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

    route(app, ctx, {
      method: 'GET',
      url: '/v1/places/:id/products',
      summary: 'Active products sold by the business that owns this place',
      tags: ['places'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      handler: async ({ params, query }) => {
        const place = await loadPlace(ctx.db, params.id);
        if (!place.business_id) return { items: [], nextCursor: null };
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        try {
          const { rows } = await ctx.db.query(
            `SELECT id, kind, title, description, price_cents, currency, stock, rating_avg, rating_count, created_at FROM products
              WHERE business_id = $1 AND status = 'active' AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
              ORDER BY created_at DESC, id DESC LIMIT $4`,
            [place.business_id, cur?.t ?? null, cur?.id ?? null, limit + 1],
          );
          const page = rows.slice(0, limit);
          const last = page[page.length - 1];
          return {
            items: page.map((r) => ({
              id: r.id,
              kind: r.kind,
              title: r.title,
              description: r.description,
              priceCents: r.price_cents,
              currency: r.currency,
              inStock: r.stock === null || r.stock > 0,
              rating: { average: Number(r.rating_avg), count: r.rating_count },
            })),
            nextCursor:
              rows.length > limit && last
                ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
                : null,
          };
        } catch (err) {
          // The commerce module owns `products`; if its table is not deployed yet a place simply has no products.
          if ((err as { code?: string }).code === '42P01') return { items: [], nextCursor: null };
          throw err;
        }
      },
    });
  },
};
