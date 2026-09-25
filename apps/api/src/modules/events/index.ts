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
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { hasCommunityPermission } from '../../lib/community-access.js';
import { postVisibleSql } from '../../lib/visibility.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import { boundsSql, geoBounds, haversineSql } from '../../lib/geo.js';
import { timezoneSchema } from '../../lib/hours.js';
import { assertOwnedImage } from '../../lib/media-check.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { createPost } from '../content/service.js';
import { requireBusinessPermission } from '../business/access.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import {
  EVENT_END_SQL,
  eventSelect,
  eventVisibleSql,
  loadEvent,
  loadManagedEvent,
  loadOrganisedEvent,
  type EventRow,
} from './access.js';
import {
  afterCapacityChange,
  cancelEvent,
  checkInAttendee,
  lockEvent,
  notifyEventAudience,
  promoteWaitlist,
  recountEvent,
  removeUserFromEvents,
  setRsvp,
} from './service.js';
import { buildIcs } from './ics.js';
import { hydrateEvents, loadUserSummaries, ticketTypeView } from './views.js';

export {
  attendEventWithTicket,
  releaseEventTicket,
  sendEventReminders,
  completeEndedEvents,
  cancelEvent as cancelEventSystem,
  listAttendedEventsForMemory,
  listEventAttendeesForMemory,
} from './service.js';
export type {
  AttendWithTicketInput,
  AttendWithTicketResult,
  MemoryEventSummary,
} from './service.js';

// ------------------------------------------------------------------ schemas
const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const VISIBILITIES = ['public', 'followers', 'friends', 'community', 'private'] as const;
const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const httpsUrl = z.url({ protocol: /^https$/ }).max(2000);
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const MAX_EVENT_DAYS = 14;

const eventFields = {
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(10_000),
  startsAt: isoDate,
  endsAt: isoDate,
  timezone: timezoneSchema,
  locationText: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  placeId: z.uuid(),
  onlineUrl: httpsUrl,
  capacity: z.number().int().min(1).max(1_000_000),
  visibility: z.enum(VISIBILITIES),
  rules: z.string().trim().max(5000),
  coverMediaId: z.uuid(),
  topics: z.array(z.string().trim().min(1).max(50)).max(10),
  waitlistEnabled: z.boolean(),
};

const createBody = z
  .object({
    title: eventFields.title,
    description: eventFields.description.default(''),
    startsAt: eventFields.startsAt,
    endsAt: eventFields.endsAt.optional(),
    timezone: eventFields.timezone.default('UTC'),
    locationText: eventFields.locationText.optional(),
    latitude: eventFields.latitude.optional(),
    longitude: eventFields.longitude.optional(),
    placeId: eventFields.placeId.optional(),
    onlineUrl: eventFields.onlineUrl.optional(),
    capacity: eventFields.capacity.optional(),
    visibility: eventFields.visibility.optional(),
    rules: eventFields.rules.default(''),
    coverMediaId: eventFields.coverMediaId.optional(),
    topics: eventFields.topics.default([]),
    waitlistEnabled: eventFields.waitlistEnabled.default(true),
    communityId: z.uuid().optional(),
    businessId: z.uuid().optional(),
    publish: z.boolean().default(false),
  })
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), {
    message: 'Provide both latitude and longitude',
  })
  .refine((b) => !b.endsAt || b.endsAt >= b.startsAt, {
    message: 'endsAt must not be before startsAt',
  })
  .refine((b) => !(b.communityId && b.businessId), {
    message: 'An event has one host: a community or a business, not both',
  });

const updateBody = z
  .object({
    title: eventFields.title,
    description: eventFields.description,
    startsAt: eventFields.startsAt,
    endsAt: eventFields.endsAt.nullable(),
    timezone: eventFields.timezone,
    locationText: eventFields.locationText.nullable(),
    latitude: eventFields.latitude.nullable(),
    longitude: eventFields.longitude.nullable(),
    placeId: eventFields.placeId.nullable(),
    onlineUrl: eventFields.onlineUrl.nullable(),
    capacity: eventFields.capacity.nullable(),
    visibility: eventFields.visibility,
    rules: eventFields.rules,
    coverMediaId: eventFields.coverMediaId.nullable(),
    topics: eventFields.topics,
    waitlistEnabled: eventFields.waitlistEnabled,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' })
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), {
    message: 'Provide both latitude and longitude',
  });

const ticketBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  priceCents: z.number().int().min(0).max(10_000_000),
  currency: currencySchema.default('USD'),
  quantity: z.number().int().min(1).max(1_000_000),
  maxPerUser: z.number().int().min(1).max(20).default(1),
  salesStart: isoDate.optional(),
  salesEnd: isoDate.optional(),
  position: z.number().int().min(0).max(100).default(0),
});
const ticketPatch = z
  .object({
    name: ticketBody.shape.name,
    description: ticketBody.shape.description,
    priceCents: ticketBody.shape.priceCents,
    currency: currencySchema,
    quantity: ticketBody.shape.quantity,
    maxPerUser: ticketBody.shape.maxPerUser,
    salesStart: isoDate.nullable(),
    salesEnd: isoDate.nullable(),
    position: ticketBody.shape.position,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const listQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  topic: z.string().trim().min(1).max(50).optional(),
  communityId: z.uuid().optional(),
  hostId: z.uuid().optional(),
  businessId: z.uuid().optional(),
  placeId: z.uuid().optional(),
  online: boolQuery.optional(),
  free: boolQuery.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  when: z.enum(['upcoming', 'past']).default('upcoming'),
});
const nearbyQuery = listQuery.omit({ when: true }).extend({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.1).max(500).default(25),
});
const mineQuery = pageQuery.extend({
  role: z
    .enum(['hosting', 'attending', 'interested', 'waitlist', 'saved', 'invited', 'past'])
    .default('attending'),
});

const W = { limit: 60, windowSec: 600, by: 'user' } as const;
type Cursor = { t?: string; id?: string; d?: number };

async function resolveTopics(db: Queryable, slugs: string[]): Promise<string[]> {
  if (!slugs.length) return [];
  const uniq = [...new Set(slugs.map((s) => s.toLowerCase()))];
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM topics WHERE slug = ANY($1::citext[])',
    [uniq],
  );
  if (rows.length !== uniq.length) throw invalid('One or more topics do not exist');
  return rows.map((r) => r.id);
}

/** Effective end used by discovery: open-ended events run 3 hours. */
const UPCOMING_SQL = `${EVENT_END_SQL} >= now()`;
const PAST_SQL = `${EVENT_END_SQL} < now()`;

interface DiscoveryFilters {
  q?: string | undefined;
  topic?: string | undefined;
  communityId?: string | undefined;
  hostId?: string | undefined;
  businessId?: string | undefined;
  placeId?: string | undefined;
  online?: boolean | undefined;
  free?: boolean | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/** Adds shared discovery filter clauses; `params` is mutated. Every clause is a constant with a bound parameter. */
function filterClauses(f: DiscoveryFilters, params: unknown[]): string[] {
  const out: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.q) out.push(`e.search_tsv @@ plainto_tsquery('simple', ${p(f.q)})`);
  if (f.topic)
    out.push(
      `EXISTS (SELECT 1 FROM event_topics et JOIN topics t ON t.id = et.topic_id WHERE et.event_id = e.id AND t.slug = ${p(f.topic.toLowerCase())}::citext)`,
    );
  if (f.communityId) out.push(`e.community_id = ${p(f.communityId)}`);
  if (f.hostId) out.push(`e.host_id = ${p(f.hostId)}`);
  if (f.businessId) out.push(`e.host_business_id = ${p(f.businessId)}`);
  if (f.placeId) out.push(`e.place_id = ${p(f.placeId)}`);
  if (f.online !== undefined)
    out.push(f.online ? 'e.online_url IS NOT NULL' : 'e.online_url IS NULL');
  if (f.free !== undefined) {
    const paid = `EXISTS (SELECT 1 FROM event_ticket_types tt WHERE tt.event_id = e.id AND tt.archived_at IS NULL AND tt.price_cents > 0)`;
    out.push(f.free ? `NOT ${paid}` : paid);
  }
  if (f.from) out.push(`e.starts_at >= ${p(f.from)}`);
  if (f.to) out.push(`e.starts_at < ${p(f.to)}`);
  return out;
}

async function loadTopicsAndValidateMedia(
  ctx: AppContext,
  userId: string,
  topics: string[] | undefined,
  coverMediaId: string | null | undefined,
) {
  const topicIds = topics ? await resolveTopics(ctx.db, topics) : undefined;
  if (coverMediaId) await assertOwnedImage(ctx.db, coverMediaId, userId);
  return topicIds;
}

async function hostAgeBand(db: Queryable, userId: string | null): Promise<'teen' | 'adult'> {
  if (!userId) return 'adult';
  const { rows } = await db.query<{ age_band: 'teen' | 'adult' }>(
    'SELECT age_band FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.age_band ?? 'adult';
}

function assertPublishable(e: {
  startsAt: Date;
  endsAt: Date | null;
  locationText: string | null;
  latitude: number | null;
  placeId: string | null;
  onlineUrl: string | null;
}): void {
  const end = e.endsAt ?? new Date(e.startsAt.getTime() + 3 * 3_600_000);
  if (end <= new Date()) throw invalid('An event must be in the future to be published');
  if (!e.locationText && e.latitude === null && !e.placeId && !e.onlineUrl)
    throw invalid('Add a location, a place or an online link before publishing');
}

export const eventsModule: ApiModule = {
  name: 'events',
  register(app, ctx) {
    registerDeletionHook(async (c, tx, userId) => removeUserFromEvents(c, tx, userId));

    const view = async (viewerId: string | null, id: string, detail = true) => {
      const { rows } = await ctx.db.query<EventRow>(
        `SELECT ${eventSelect('$1::uuid')} FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1::uuid')}`,
        [viewerId, id],
      );
      if (!rows[0]) throw notFound('Event');
      return (await hydrateEvents(ctx, viewerId, rows, { detail }))[0]!;
    };

    // ================================================================== create / read / update
    route(app, ctx, {
      method: 'POST',
      url: '/v1/events',
      summary: 'Create an event (draft, or published with publish=true)',
      tags: ['events'],
      auth: 'user',
      body: createBody,
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        const teen = auth.ageBand === 'teen';
        const visibility =
          body.visibility ?? (body.communityId ? 'community' : teen ? 'friends' : 'public');
        if (teen && (visibility === 'public' || visibility === 'followers'))
          throw new AppError('unprocessable', 'Accounts under 18 cannot host public events');
        if (teen && body.businessId)
          throw new AppError('unprocessable', 'Accounts under 18 cannot host business events');

        let communityId: string | null = null;
        if (body.communityId) {
          if (
            !(await hasCommunityPermission(ctx.db, body.communityId, auth.userId, 'manage_events'))
          )
            throw forbidden('You cannot manage events in this community');
          const c = await ctx.db.query<{ visibility: string }>(
            'SELECT visibility FROM communities WHERE id = $1 AND deleted_at IS NULL',
            [body.communityId],
          );
          if (!c.rows[0]) throw notFound('Community');
          if (c.rows[0].visibility !== 'public' && visibility !== 'community')
            throw invalid('Events of private communities must use community visibility');
          communityId = body.communityId;
        }
        if (visibility === 'community' && !communityId)
          throw invalid('communityId is required for community events');
        let businessId: string | null = null;
        if (body.businessId) {
          await requireBusinessPermission(ctx.db, body.businessId, auth.userId, 'events.manage');
          businessId = body.businessId;
        }
        const now = new Date();
        if (body.startsAt <= now) throw invalid('startsAt must be in the future');
        if (
          body.endsAt &&
          body.endsAt.getTime() - body.startsAt.getTime() > MAX_EVENT_DAYS * 86_400_000
        )
          throw invalid(`An event can last at most ${MAX_EVENT_DAYS} days`);
        assertTextAllowed(body.title, body.description, body.rules, body.locationText);

        let latitude = body.latitude ?? null;
        let longitude = body.longitude ?? null;
        if (body.placeId) {
          const p = await ctx.db.query<{ latitude: number; longitude: number }>(
            'SELECT latitude, longitude FROM places WHERE id = $1 AND deleted_at IS NULL',
            [body.placeId],
          );
          if (!p.rows[0]) throw notFound('Place');
          if (latitude === null) {
            latitude = p.rows[0].latitude;
            longitude = p.rows[0].longitude;
          }
        }
        const topicIds =
          (await loadTopicsAndValidateMedia(ctx, auth.userId, body.topics, body.coverMediaId)) ??
          [];
        if (body.publish)
          assertPublishable({
            startsAt: body.startsAt,
            endsAt: body.endsAt ?? null,
            locationText: body.locationText ?? null,
            latitude,
            placeId: body.placeId ?? null,
            onlineUrl: body.onlineUrl ?? null,
          });

        const id = await withTransaction(ctx.db, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO events (title, description, host_id, host_business_id, community_id, place_id, starts_at, ends_at, timezone, location_text, latitude, longitude,
                                 online_url, capacity, visibility, status, rules, cover_media_id, waitlist_enabled, published_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
            [
              body.title,
              body.description,
              auth.userId,
              businessId,
              communityId,
              body.placeId ?? null,
              body.startsAt,
              body.endsAt ?? null,
              body.timezone,
              body.locationText ?? null,
              latitude,
              longitude,
              body.onlineUrl ?? null,
              body.capacity ?? null,
              visibility,
              body.publish ? 'published' : 'draft',
              body.rules,
              body.coverMediaId ?? null,
              body.waitlistEnabled,
              body.publish ? now : null,
            ],
          );
          if (topicIds.length)
            await tx.query(
              'INSERT INTO event_topics (event_id, topic_id) SELECT $1, unnest($2::uuid[])',
              [rows[0]!.id, topicIds],
            );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.created',
              targetType: 'event',
              targetId: rows[0]!.id,
              metadata: { published: body.publish, visibility },
            },
            req,
            tx,
          );
          return rows[0]!.id;
        });
        ctx.metrics.events.inc({ name: 'event_created' });
        void reply.code(201);
        return view(auth.userId, id);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id',
      summary: 'Get an event (only if you may see it)',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => view(auth?.userId ?? null, params.id),
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/events/:id',
      summary: 'Edit an event (hosts and co-hosts)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: updateBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const cur = await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        if (cur.status === 'cancelled' || cur.status === 'completed')
          throw conflict(`A ${cur.status} event cannot be edited`, {
            reason: `event_${cur.status}`,
          });
        assertTextAllowed(body.title, body.description, body.rules, body.locationText);

        const startsAt = body.startsAt ?? cur.starts_at;
        const endsAt = body.endsAt === undefined ? cur.ends_at : body.endsAt;
        if (body.startsAt && cur.status === 'published' && body.startsAt <= new Date())
          throw invalid('startsAt must be in the future');
        if (body.startsAt && body.startsAt <= new Date() && cur.status === 'draft')
          throw invalid('startsAt must be in the future');
        if (endsAt && endsAt < startsAt) throw invalid('endsAt must not be before startsAt');
        if (endsAt && endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DAYS * 86_400_000)
          throw invalid(`An event can last at most ${MAX_EVENT_DAYS} days`);

        const visibility = body.visibility ?? cur.visibility;
        if (visibility === 'community' && !cur.community_id)
          throw invalid('Only community events can use community visibility');
        if (
          body.visibility &&
          (body.visibility === 'public' || body.visibility === 'followers') &&
          (await hostAgeBand(ctx.db, cur.host_id)) === 'teen'
        )
          throw new AppError('unprocessable', 'Accounts under 18 cannot host public events');
        if (body.visibility === 'public' && cur.community_id) {
          const c = await ctx.db.query<{ visibility: string }>(
            'SELECT visibility FROM communities WHERE id = $1 AND deleted_at IS NULL',
            [cur.community_id],
          );
          if (c.rows[0] && c.rows[0].visibility !== 'public')
            throw invalid('Events of private communities cannot be public');
        }
        let latitude = body.latitude === undefined ? cur.latitude : body.latitude;
        let longitude = body.longitude === undefined ? cur.longitude : body.longitude;
        if (body.placeId) {
          const p = await ctx.db.query<{ latitude: number; longitude: number }>(
            'SELECT latitude, longitude FROM places WHERE id = $1 AND deleted_at IS NULL',
            [body.placeId],
          );
          if (!p.rows[0]) throw notFound('Place');
          if (body.latitude === undefined) {
            latitude = p.rows[0].latitude;
            longitude = p.rows[0].longitude;
          }
        }
        const topicIds = await loadTopicsAndValidateMedia(
          ctx,
          auth.userId,
          body.topics,
          body.coverMediaId,
        );
        const locationText =
          body.locationText === undefined ? cur.location_text : body.locationText;
        const placeId = body.placeId === undefined ? cur.place_id : body.placeId;
        const onlineUrl = body.onlineUrl === undefined ? cur.online_url : body.onlineUrl;
        if (cur.status === 'published')
          assertPublishable({ startsAt, endsAt, locationText, latitude, placeId, onlineUrl });

        const notifyAfter = await withTransaction(ctx.db, async (tx) => {
          const ev = await lockEvent(tx, params.id);
          if (ev.status === 'cancelled' || ev.status === 'completed')
            throw conflict(`A ${ev.status} event cannot be edited`);
          const { rows: occ } = await tx.query<{ n: number }>(
            `SELECT COALESCE(sum(spots),0)::int AS n FROM event_attendees WHERE event_id = $1 AND status IN ('going','attended')`,
            [params.id],
          );
          if (body.capacity && body.capacity < occ[0]!.n)
            throw conflict(`Capacity cannot be lower than the ${occ[0]!.n} spots already taken`, {
              reason: 'capacity_below_going',
            });
          if (body.capacity) {
            const big = await tx.query<{ quantity: number }>(
              'SELECT quantity FROM event_ticket_types WHERE event_id = $1 AND archived_at IS NULL AND quantity > $2 LIMIT 1',
              [params.id, body.capacity],
            );
            if (big.rowCount)
              throw conflict('A ticket type has more tickets than the new capacity', {
                reason: 'capacity_below_tickets',
              });
          }
          const sets: string[] = [];
          const vals: unknown[] = [params.id];
          const set = (col: string, v: unknown) => {
            vals.push(v);
            sets.push(`${col} = $${vals.length}`);
          };
          if (body.title !== undefined) set('title', body.title);
          if (body.description !== undefined) set('description', body.description);
          if (body.startsAt !== undefined) set('starts_at', body.startsAt);
          if (body.endsAt !== undefined) set('ends_at', body.endsAt);
          if (body.timezone !== undefined) set('timezone', body.timezone);
          if (body.locationText !== undefined) set('location_text', body.locationText);
          if (body.latitude !== undefined || body.placeId) {
            set('latitude', latitude);
            set('longitude', longitude);
          }
          if (body.placeId !== undefined) set('place_id', body.placeId);
          if (body.onlineUrl !== undefined) set('online_url', body.onlineUrl);
          if (body.capacity !== undefined) set('capacity', body.capacity);
          if (body.visibility !== undefined) set('visibility', body.visibility);
          if (body.rules !== undefined) set('rules', body.rules);
          if (body.coverMediaId !== undefined) set('cover_media_id', body.coverMediaId);
          if (body.waitlistEnabled !== undefined) set('waitlist_enabled', body.waitlistEnabled);
          if (sets.length)
            await tx.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, vals);
          if (topicIds) {
            await tx.query('DELETE FROM event_topics WHERE event_id = $1', [params.id]);
            if (topicIds.length)
              await tx.query(
                'INSERT INTO event_topics (event_id, topic_id) SELECT $1, unnest($2::uuid[])',
                [params.id, topicIds],
              );
          }
          const material = [
            'startsAt',
            'endsAt',
            'timezone',
            'locationText',
            'latitude',
            'placeId',
            'onlineUrl',
          ].some((k) => k in body);
          let after: (() => Promise<void>) | null = null;
          if (body.capacity !== undefined || body.waitlistEnabled !== undefined) {
            const fresh = await lockEvent(tx, params.id);
            after = await afterCapacityChange(ctx, fresh, tx);
          }
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.updated',
              targetType: 'event',
              targetId: params.id,
              metadata: { fields: Object.keys(body) },
            },
            req,
            tx,
          );
          return {
            material: material && ev.status === 'published',
            after,
            title: body.title ?? ev.title,
          };
        });
        if (notifyAfter.after) await notifyAfter.after();
        if (notifyAfter.material) {
          await notifyEventAudience(
            ctx,
            params.id,
            ['going', 'waitlist', 'interested'],
            { kind: 'event_updated', actorId: auth.userId, data: { title: notifyAfter.title } },
            auth.userId,
          );
        }
        return view(auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/publish',
      summary: 'Publish a draft event',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const cur = await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        if (cur.status === 'published') return view(auth.userId, params.id);
        if (cur.status !== 'draft')
          throw conflict(`A ${cur.status} event cannot be published`, {
            reason: `event_${cur.status}`,
          });
        assertPublishable({
          startsAt: cur.starts_at,
          endsAt: cur.ends_at,
          locationText: cur.location_text,
          latitude: cur.latitude,
          placeId: cur.place_id,
          onlineUrl: cur.online_url,
        });
        await withTransaction(ctx.db, async (tx) => {
          const ev = await lockEvent(tx, params.id);
          if (ev.status !== 'draft') throw conflict('This event was already changed');
          await tx.query(
            `UPDATE events SET status = 'published', published_at = now() WHERE id = $1`,
            [params.id],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.published',
              targetType: 'event',
              targetId: params.id,
            },
            req,
            tx,
          );
        });
        return view(auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/cancel',
      summary: 'Cancel an event (host). Attendees are notified.',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await loadManagedEvent(ctx.db, params.id, auth.userId);
        const changed = await cancelEvent(ctx, {
          eventId: params.id,
          actorId: auth.userId,
          reason: body.reason,
        });
        if (changed) {
          const paid = await ctx.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM event_ticket_grants WHERE event_id = $1 AND order_id IS NOT NULL AND status = 'active'`,
            [params.id],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.cancelled',
              targetType: 'event',
              targetId: params.id,
              metadata: { paidGrantsToRefund: paid.rows[0]!.n },
            },
            req,
          );
        }
        return view(auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/complete',
      summary: 'Mark a started event as completed (also done automatically by the completion job)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const cur = await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        if (cur.status === 'completed') return view(auth.userId, params.id);
        if (cur.status !== 'published')
          throw conflict(`A ${cur.status} event cannot be completed`, {
            reason: `event_${cur.status}`,
          });
        if (cur.starts_at > new Date())
          throw conflict('The event has not started yet', { reason: 'not_started' });
        await ctx.db.query(
          `UPDATE events SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'published'`,
          [params.id],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'event.completed',
            targetType: 'event',
            targetId: params.id,
          },
          req,
        );
        return view(auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/events/:id',
      summary: 'Delete an event that has no attendees (otherwise cancel it)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await loadManagedEvent(ctx.db, params.id, auth.userId);
        await withTransaction(ctx.db, async (tx) => {
          await lockEvent(tx, params.id);
          const n = await tx.query(
            `SELECT 1 FROM event_attendees WHERE event_id = $1 AND status IN ('going','waitlist','attended') LIMIT 1`,
            [params.id],
          );
          if (n.rowCount)
            throw conflict('This event has attendees: cancel it instead', {
              reason: 'has_attendees',
            });
          await tx.query('UPDATE events SET deleted_at = now() WHERE id = $1', [params.id]);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.deleted',
              targetType: 'event',
              targetId: params.id,
            },
            req,
            tx,
          );
        });
      },
    });

    // ================================================================== ticket types
    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/ticket-types',
      summary: 'Ticket types of an event',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const e = await loadEvent(ctx.db, params.id, auth?.userId ?? null);
        const { rows } = await ctx.db.query(
          `SELECT * FROM event_ticket_types WHERE event_id = $1 ${e.is_organiser ? '' : 'AND archived_at IS NULL'} ORDER BY position, created_at, id`,
          [params.id],
        );
        return { items: rows.map((r) => ticketTypeView(r)) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/ticket-types',
      summary: 'Add a ticket type (free or paid). Paid tickets are bought through checkout.',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: ticketBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        const e = await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        if (e.status === 'cancelled' || e.status === 'completed')
          throw conflict(`A ${e.status} event cannot sell tickets`);
        if (body.priceCents > 0 && (await hostAgeBand(ctx.db, e.host_id)) === 'teen')
          throw new AppError('unprocessable', 'Accounts under 18 cannot sell tickets');
        assertTicketWindow(e, body.salesStart ?? null, body.salesEnd ?? null);
        assertTextAllowed(body.name, body.description);
        if (e.capacity !== null && body.quantity > e.capacity)
          throw invalid('A ticket type cannot have more tickets than the event capacity');
        const row = await withTransaction(ctx.db, async (tx) => {
          await lockEvent(tx, params.id);
          const n = await tx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM event_ticket_types WHERE event_id = $1 AND archived_at IS NULL',
            [params.id],
          );
          if (n.rows[0]!.n >= 20) throw conflict('An event can have at most 20 ticket types');
          const r = await tx.query(
            `INSERT INTO event_ticket_types (event_id, name, description, price_cents, currency, quantity, max_per_user, sales_start, sales_end, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              params.id,
              body.name,
              body.description,
              body.priceCents,
              body.currency,
              body.quantity,
              body.maxPerUser,
              body.salesStart ?? null,
              body.salesEnd ?? null,
              body.position,
            ],
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.ticket_type_created',
              targetType: 'event',
              targetId: params.id,
              metadata: { ticketTypeId: r.rows[0].id, priceCents: body.priceCents },
            },
            req,
            tx,
          );
          return r.rows[0];
        });
        void reply.code(201);
        return ticketTypeView(row);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/events/:id/ticket-types/:tid',
      summary: 'Edit a ticket type',
      tags: ['events'],
      auth: 'user',
      params: z.object({ id: z.uuid(), tid: z.uuid() }),
      body: ticketPatch,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        const e = await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        if (e.status === 'cancelled' || e.status === 'completed')
          throw conflict(`A ${e.status} event cannot be changed`);
        assertTextAllowed(body.name, body.description);
        if (
          body.priceCents !== undefined &&
          body.priceCents > 0 &&
          (await hostAgeBand(ctx.db, e.host_id)) === 'teen'
        )
          throw new AppError('unprocessable', 'Accounts under 18 cannot sell tickets');
        const row = await withTransaction(ctx.db, async (tx) => {
          await lockEvent(tx, params.id);
          const { rows } = await tx.query(
            'SELECT * FROM event_ticket_types WHERE id = $1 AND event_id = $2 AND archived_at IS NULL FOR UPDATE',
            [params.tid, params.id],
          );
          const cur = rows[0];
          if (!cur) throw notFound('Ticket type');
          if (
            cur.sold > 0 &&
            ((body.priceCents !== undefined && body.priceCents !== cur.price_cents) ||
              (body.currency !== undefined && body.currency !== cur.currency))
          ) {
            throw conflict('Price and currency cannot change after tickets were sold', {
              reason: 'ticket_sold',
            });
          }
          if (body.quantity !== undefined && body.quantity < cur.sold)
            throw conflict(`Quantity cannot be lower than the ${cur.sold} tickets already sold`, {
              reason: 'quantity_below_sold',
            });
          if (body.quantity !== undefined && e.capacity !== null && body.quantity > e.capacity)
            throw invalid('A ticket type cannot have more tickets than the event capacity');
          assertTicketWindow(
            e,
            body.salesStart === undefined ? cur.sales_start : body.salesStart,
            body.salesEnd === undefined ? cur.sales_end : body.salesEnd,
          );
          const sets: string[] = [];
          const vals: unknown[] = [params.tid];
          const set = (col: string, v: unknown) => {
            vals.push(v);
            sets.push(`${col} = $${vals.length}`);
          };
          if (body.name !== undefined) set('name', body.name);
          if (body.description !== undefined) set('description', body.description);
          if (body.priceCents !== undefined) set('price_cents', body.priceCents);
          if (body.currency !== undefined) set('currency', body.currency);
          if (body.quantity !== undefined) set('quantity', body.quantity);
          if (body.maxPerUser !== undefined) set('max_per_user', body.maxPerUser);
          if (body.salesStart !== undefined) set('sales_start', body.salesStart);
          if (body.salesEnd !== undefined) set('sales_end', body.salesEnd);
          if (body.position !== undefined) set('position', body.position);
          const r = await tx.query(
            `UPDATE event_ticket_types SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
            vals,
          );
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.ticket_type_updated',
              targetType: 'event',
              targetId: params.id,
              metadata: { ticketTypeId: params.tid, fields: Object.keys(body) },
            },
            req,
            tx,
          );
          const after =
            body.quantity !== undefined && body.quantity > cur.quantity
              ? await afterCapacityChange(ctx, await lockEvent(tx, params.id), tx)
              : null;
          return { row: r.rows[0], after };
        });
        if (row.after) await row.after();
        return ticketTypeView(row.row);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/events/:id/ticket-types/:tid',
      summary: 'Archive a ticket type (existing holders keep their tickets)',
      tags: ['events'],
      auth: 'user',
      params: z.object({ id: z.uuid(), tid: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        const r = await ctx.db.query(
          'UPDATE event_ticket_types SET archived_at = now() WHERE id = $1 AND event_id = $2 AND archived_at IS NULL',
          [params.tid, params.id],
        );
        if (!r.rowCount) throw notFound('Ticket type');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'event.ticket_type_archived',
            targetType: 'event',
            targetId: params.id,
            metadata: { ticketTypeId: params.tid },
          },
          req,
        );
      },
    });

    // ================================================================== RSVP / attendance
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/events/:id/rsvp',
      summary: 'RSVP: going (capacity/waitlist aware), interested or not_going',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: z.object({
        status: z.enum(['going', 'interested', 'not_going']),
        ticketTypeId: z.uuid().optional(),
      }),
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) => {
        const e = await loadEvent(ctx.db, params.id, auth.userId);
        if (e.host_id === auth.userId && body.status !== 'going')
          throw conflict('You are hosting this event');
        const r = await setRsvp(ctx, {
          eventId: params.id,
          userId: auth.userId,
          status: body.status,
          ticketTypeId: body.ticketTypeId,
        });
        return {
          status: r.status,
          counts: { going: r.goingCount, interested: r.interestedCount, waitlist: r.waitlistCount },
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/events/:id/rsvp',
      summary: 'Withdraw your RSVP (same as not_going)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, params }) => {
        await loadEvent(ctx.db, params.id, auth.userId);
        const r = await setRsvp(ctx, {
          eventId: params.id,
          userId: auth.userId,
          status: 'not_going',
        });
        return {
          status: r.status,
          counts: { going: r.goingCount, interested: r.interestedCount, waitlist: r.waitlistCount },
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/my-ticket',
      summary: 'Your attendance and personal check-in code',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const e = await loadEvent(ctx.db, params.id, auth.userId);
        const { rows } = await ctx.db.query<{
          status: string;
          spots: number;
          checkin_code: string | null;
          checked_in_at: Date | null;
        }>(
          'SELECT status, spots, checkin_code, checked_in_at FROM event_attendees WHERE event_id = $1 AND user_id = $2',
          [params.id, auth.userId],
        );
        const a = rows[0];
        if (!a || !['going', 'attended', 'waitlist'].includes(a.status)) throw notFound('Ticket');
        const grants = await ctx.db.query(
          `SELECT g.id, g.quantity, g.order_id, t.name AS ticket_name FROM event_ticket_grants g JOIN event_ticket_types t ON t.id = g.ticket_type_id
            WHERE g.event_id = $1 AND g.user_id = $2 AND g.status = 'active' ORDER BY g.created_at`,
          [params.id, auth.userId],
        );
        return {
          eventId: e.id,
          status: a.status,
          spots: a.spots,
          code: a.status === 'waitlist' ? null : a.checkin_code,
          checkedInAt: a.checked_in_at?.toISOString() ?? null,
          tickets: grants.rows.map((g) => ({
            id: g.id,
            quantity: g.quantity,
            name: g.ticket_name,
            paid: g.order_id !== null,
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/attendees',
      summary: 'Attendee list: everything for hosts, friends only (plus counts) for everyone else',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      query: pageQuery.extend({
        status: z.enum(['going', 'attended', 'interested', 'waitlist', 'cancelled']).optional(),
      }),
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const e = await loadEvent(ctx.db, params.id, viewer);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const args: unknown[] = [params.id, cur?.t ?? null, cur?.id ?? null, limit + 1];
        let rows: Array<{
          user_id: string;
          status: string;
          created_at: Date;
          checked_in_at: Date | null;
          spots: number;
        }>;
        let scope: 'all' | 'friends';
        if (e.is_organiser) {
          scope = 'all';
          args.push(
            query.status ? [query.status] : ['going', 'attended', 'waitlist', 'interested'],
          );
          ({ rows } = await ctx.db.query(
            `SELECT a.user_id, a.status, a.created_at, a.checked_in_at, a.spots FROM event_attendees a
              WHERE a.event_id = $1 AND a.status = ANY($5::text[]) AND ($2::timestamptz IS NULL OR (a.created_at, a.user_id) > ($2::timestamptz, $3::uuid))
              ORDER BY a.created_at, a.user_id LIMIT $4`,
            args,
          ));
        } else {
          scope = 'friends';
          if (!viewer) rows = [];
          else {
            args.push(
              viewer,
              query.status && ['going', 'attended', 'interested'].includes(query.status)
                ? [query.status]
                : ['going', 'attended', 'interested'],
            );
            ({ rows } = await ctx.db.query(
              `SELECT a.user_id, a.status, a.created_at, NULL::timestamptz AS checked_in_at, a.spots FROM event_attendees a
                WHERE a.event_id = $1 AND a.status = ANY($6::text[])
                  AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($5::uuid, a.user_id) AND fr.user_high = GREATEST($5::uuid, a.user_id) AND fr.status = 'accepted')
                  AND NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $5 AND bl.blocked_id = a.user_id) OR (bl.blocker_id = a.user_id AND bl.blocked_id = $5))
                  AND ($2::timestamptz IS NULL OR (a.created_at, a.user_id) > ($2::timestamptz, $3::uuid))
                ORDER BY a.created_at, a.user_id LIMIT $4`,
              args,
            ));
          }
        }
        const page = rows.slice(0, limit);
        const users = await loadUserSummaries(
          ctx,
          page.map((r) => r.user_id),
        );
        const last = page[page.length - 1];
        const waitlist = await ctx.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM event_attendees WHERE event_id = $1 AND status = 'waitlist'`,
          [params.id],
        );
        return {
          scope,
          counts: {
            going: e.going_count,
            interested: e.interested_count,
            waitlist: waitlist.rows[0]!.n,
          },
          items: page.map((r) => ({
            user: users.get(r.user_id) ?? null,
            status: r.status,
            spots: scope === 'all' ? r.spots : undefined,
            checkedInAt: r.checked_in_at?.toISOString() ?? null,
          })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.user_id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/check-in',
      summary: 'Check an attendee in by user id or ticket/personal code (hosts and co-hosts only)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: z
        .object({ userId: z.uuid().optional(), code: z.string().trim().min(4).max(100).optional() })
        .refine((b) => Boolean(b.userId) !== Boolean(b.code), {
          message: 'Provide exactly one of userId or code',
        }),
      rateLimit: { limit: 600, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) => {
        await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        const r = await checkInAttendee(ctx, {
          eventId: params.id,
          actorId: auth.userId,
          userId: body.userId,
          code: body.code,
        });
        const users = await loadUserSummaries(ctx, [r.userId]);
        return {
          user: users.get(r.userId) ?? { id: r.userId },
          alreadyCheckedIn: r.alreadyCheckedIn,
          via: r.via,
        };
      },
    });

    // ================================================================== organisers & invitations
    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/cohosts',
      summary: 'Co-hosts of an event',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        await loadEvent(ctx.db, params.id, auth?.userId ?? null);
        const { rows } = await ctx.db.query<{ user_id: string }>(
          'SELECT user_id FROM event_organizers WHERE event_id = $1 ORDER BY created_at',
          [params.id],
        );
        const users = await loadUserSummaries(
          ctx,
          rows.map((r) => r.user_id),
        );
        return { items: rows.map((r) => users.get(r.user_id)).filter(Boolean) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/cohosts',
      summary: 'Add a co-host (host only)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: z.object({ userId: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        const e = await loadManagedEvent(ctx.db, params.id, auth.userId);
        if (body.userId === auth.userId || body.userId === e.host_id)
          throw invalid('That person already hosts this event');
        const u = await ctx.db.query<{ age_band: string }>(
          `SELECT age_band FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
          [body.userId],
        );
        if (!u.rows[0]) throw notFound('User');
        if (await isBlockedEitherWay(ctx.db, auth.userId, body.userId)) throw notFound('User');
        const n = await ctx.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM event_organizers WHERE event_id = $1',
          [params.id],
        );
        if (n.rows[0]!.n >= 10) throw conflict('An event can have at most 10 co-hosts');
        const r = await ctx.db.query(
          'INSERT INTO event_organizers (event_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [params.id, body.userId, auth.userId],
        );
        if (r.rowCount) {
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.cohost_added',
              targetType: 'event',
              targetId: params.id,
              metadata: { userId: body.userId },
            },
            req,
          );
          await notify(ctx, {
            userId: body.userId,
            kind: 'event_cohost_added',
            actorId: auth.userId,
            targetType: 'event',
            targetId: params.id,
            data: { title: e.title },
          });
        }
        void reply.code(r.rowCount ? 201 : 200);
        return { userId: body.userId, role: 'co_host' };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/events/:id/cohosts/:userId',
      summary: 'Remove a co-host (host), or leave as co-host',
      tags: ['events'],
      auth: 'user',
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const e = await loadOrganisedEvent(ctx.db, params.id, auth.userId);
        if (params.userId !== auth.userId && !e.is_manager)
          throw forbidden('Only the host can remove co-hosts');
        const r = await ctx.db.query(
          'DELETE FROM event_organizers WHERE event_id = $1 AND user_id = $2',
          [params.id, params.userId],
        );
        if (!r.rowCount) throw notFound('Co-host');
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'event.cohost_removed',
            targetType: 'event',
            targetId: params.id,
            metadata: { userId: params.userId },
          },
          req,
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/invitations',
      summary:
        'Invite people (hosts: anyone, which also opens the event to them; going attendees of public events: their own friends)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: z.object({ userIds: z.array(z.uuid()).min(1).max(50) }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        const e = await loadEvent(ctx.db, params.id, auth.userId);
        if (e.status !== 'published' && !(e.status === 'draft' && e.is_organiser))
          throw conflict('This event is not open for invitations');
        const isGoing = e.my_status === 'going' || e.my_status === 'attended';
        if (!e.is_organiser && (!isGoing || e.visibility !== 'public'))
          throw forbidden('You cannot invite people to this event');
        const invited: string[] = [];
        const skipped: string[] = [];
        for (const userId of [...new Set(body.userIds)]) {
          if (userId === auth.userId) {
            skipped.push(userId);
            continue;
          }
          const u = await ctx.db.query<{ age_band: string }>(
            `SELECT age_band FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
            [userId],
          );
          if (!u.rows[0] || (await isBlockedEitherWay(ctx.db, auth.userId, userId))) {
            skipped.push(userId);
            continue;
          }
          const friends = await ctx.db.query(
            `SELECT 1 FROM friendships WHERE user_low = LEAST($1::uuid,$2::uuid) AND user_high = GREATEST($1::uuid,$2::uuid) AND status = 'accepted'`,
            [auth.userId, userId],
          );
          if ((!e.is_organiser || u.rows[0].age_band === 'teen') && !friends.rowCount) {
            skipped.push(userId);
            continue;
          }
          const r = await ctx.db.query(
            `INSERT INTO event_invitations (event_id, user_id, invited_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [params.id, userId, auth.userId],
          );
          if (!r.rowCount) {
            skipped.push(userId);
            continue;
          }
          invited.push(userId);
          await notify(ctx, {
            userId,
            kind: 'event_invitation',
            actorId: auth.userId,
            targetType: 'event',
            targetId: params.id,
            data: { title: e.title },
          });
        }
        if (invited.length)
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'event.invited',
              targetType: 'event',
              targetId: params.id,
              metadata: { count: invited.length },
            },
            req,
          );
        return { invited, skipped };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/event-invitations',
      summary: 'Events you were invited to (pending)',
      tags: ['events'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<EventRow & { inv_at: Date }>(
          `SELECT ${eventSelect('$1::uuid')}, ei.created_at AS inv_at FROM event_invitations ei JOIN events e ON e.id = ei.event_id
            WHERE ei.user_id = $1 AND ei.status = 'pending' AND ${eventVisibleSql('$1::uuid')} AND e.status = 'published' AND ${UPCOMING_SQL}
              AND ($2::timestamptz IS NULL OR (ei.created_at, e.id) < ($2::timestamptz, $3::uuid))
            ORDER BY ei.created_at DESC, e.id DESC LIMIT $4`,
          [auth.userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydrateEvents(ctx, auth.userId, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.inv_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    // ================================================================== saves / share / calendar
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/events/:id/save',
      summary: 'Save an event',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 300, windowSec: 600, by: 'user' },
      handler: async ({ auth, params }) => {
        await loadEvent(ctx.db, params.id, auth.userId);
        await ctx.db.query(
          `INSERT INTO saves (user_id, target_type, target_id) VALUES ($1,'event',$2) ON CONFLICT DO NOTHING`,
          [auth.userId, params.id],
        );
        return { saved: true };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/events/:id/save',
      summary: 'Unsave an event',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await ctx.db.query(
          `DELETE FROM saves WHERE user_id = $1 AND target_type = 'event' AND target_id = $2`,
          [auth.userId, params.id],
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/share',
      summary: 'Share link and text for an event you may see',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, params }) => {
        const e = await loadEvent(ctx.db, params.id, auth?.userId ?? null);
        if (e.status === 'draft') throw conflict('Publish the event before sharing it');
        const web = ctx.config.WEB_PUBLIC_URL.replace(/\/$/, '');
        const api = ctx.config.API_PUBLIC_URL.replace(/\/$/, '');
        return {
          url: `${web}/events/${e.id}`,
          calendarUrl: `${api}/v1/events/${e.id}/calendar.ics`,
          title: e.title,
          text: `${e.title} — ${e.starts_at.toISOString()}`,
          audience: e.visibility,
          note:
            e.visibility === 'public'
              ? null
              : 'Only people who are allowed to see this event can open the link',
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/calendar.ics',
      summary: 'Download the event as an iCalendar (.ics) file',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      handler: async ({ auth, reply, params }) => {
        const e = await loadEvent(ctx.db, params.id, auth?.userId ?? null);
        if (e.status === 'draft') throw notFound('Event');
        const body = buildIcs(
          [
            {
              id: e.id,
              title: e.title,
              description: e.description,
              startsAt: e.starts_at,
              endsAt: e.ends_at,
              locationText: e.location_text,
              latitude: e.latitude,
              longitude: e.longitude,
              url: `${ctx.config.WEB_PUBLIC_URL.replace(/\/$/, '')}/events/${e.id}`,
              cancelled: e.status === 'cancelled',
              updatedAt: e.updated_at,
            },
          ],
          { calendarName: e.title },
        );
        void reply
          .header('content-type', 'text/calendar; charset=utf-8')
          .header('content-disposition', `attachment; filename="event-${e.id.slice(0, 8)}.ics"`)
          .header('cache-control', 'private, max-age=60');
        return body;
      },
    });

    // ================================================================== discussion
    route(app, ctx, {
      method: 'POST',
      url: '/v1/events/:id/posts',
      summary: 'Post to the event discussion (hosts and attendees)',
      tags: ['events'],
      auth: 'user',
      params: idParams,
      body: z.object({
        body: z.string().max(10_000).default(''),
        mediaIds: z.array(z.uuid()).max(10).optional(),
        linkUrl: z
          .url({ protocol: /^https?$/ })
          .max(2000)
          .optional(),
        language: z.string().min(2).max(10).optional(),
      }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const e = await loadEvent(ctx.db, params.id, auth.userId);
        if (e.status !== 'published' && e.status !== 'completed')
          throw conflict('This event is not open for discussion', { reason: `event_${e.status}` });
        const participant =
          e.is_organiser ||
          (e.my_status !== null &&
            ['going', 'attended', 'interested', 'waitlist'].includes(e.my_status));
        if (!participant)
          throw forbidden('Join the event (going or interested) to post in its discussion');
        // Public/community events: normal post visibility. Everything else is event-scoped: the post is private to its author in
        // global feeds and is shown to whoever may see the event through GET /v1/events/:id/posts.
        let visibility: 'public' | 'community' | 'friends' | 'private' = 'private';
        if (e.visibility === 'public') visibility = auth.ageBand === 'teen' ? 'friends' : 'public';
        else if (e.visibility === 'community') visibility = 'community';
        const id = await createPost(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          {
            body: body.body,
            mediaIds: body.mediaIds,
            linkUrl: body.linkUrl,
            language: body.language,
            visibility,
            eventId: e.id,
            ...(visibility === 'community' ? { communityId: e.community_id! } : {}),
          },
        );
        ctx.metrics.events.inc({ name: 'event_post_created' });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'event.post_created',
            targetType: 'post',
            targetId: id,
            metadata: { eventId: e.id },
          },
          req,
        );
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2`,
          [auth.userId, id],
        );
        void reply.code(201);
        return (await hydratePosts(ctx, auth.userId, rows))[0];
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/events/:id/posts',
      summary: 'Event discussion',
      tags: ['events'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => {
        const viewer = auth?.userId ?? null;
        const e = await loadEvent(ctx.db, params.id, viewer);
        const scoped = !['public', 'community'].includes(e.visibility);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom}
            WHERE p.event_id = $2 AND p.deleted_at IS NULL
              AND (${postVisibleSql('$1::uuid')}
                   OR ($5::boolean AND p.visibility = 'private' AND p.moderation_status = 'approved'
                       AND EXISTS (SELECT 1 FROM users ua WHERE ua.id = p.author_id AND ua.deleted_at IS NULL AND ua.status IN ('active','pending_deletion'))
                       AND ($1::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $1::uuid AND bl.blocked_id = p.author_id) OR (bl.blocker_id = p.author_id AND bl.blocked_id = $1::uuid)))))
              AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
            ORDER BY p.created_at DESC, p.id DESC LIMIT $6`,
          [viewer, params.id, cur?.t ?? null, cur?.id ?? null, scoped, limit + 1],
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

    // ================================================================== discovery
    route(app, ctx, {
      method: 'GET',
      url: '/v1/events',
      summary: 'Discover events (upcoming or past) you may see',
      tags: ['events'],
      auth: 'optional',
      query: listQuery,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const past = query.when === 'past';
        const params: unknown[] = [viewer];
        const where = [
          eventVisibleSql('$1::uuid'),
          past
            ? `e.status IN ('published','completed') AND ${PAST_SQL}`
            : `e.status = 'published' AND ${UPCOMING_SQL}`,
          ...filterClauses(query, params),
        ];
        if (cur?.t) {
          params.push(cur.t, cur.id);
          where.push(
            `(e.starts_at, e.id) ${past ? '<' : '>'} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        params.push(limit + 1);
        const { rows } = await ctx.db.query<EventRow>(
          `SELECT ${eventSelect('$1::uuid')} FROM events e WHERE ${where.join(' AND ')} ORDER BY e.starts_at ${past ? 'DESC' : 'ASC'}, e.id ${past ? 'DESC' : 'ASC'} LIMIT $${params.length}`,
          params,
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
      url: '/v1/events/nearby',
      summary: 'Upcoming events near a point, nearest first (haversine)',
      tags: ['events'],
      auth: 'optional',
      query: nearbyQuery,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const params: unknown[] = [viewer, query.lat, query.lng, query.radiusKm];
        const bounds = boundsSql(
          'e.latitude',
          'e.longitude',
          geoBounds(query.lat, query.lng, query.radiusKm),
          params,
        );
        const filters = filterClauses(query, params);
        const dist = haversineSql('e.latitude', 'e.longitude', '$2', '$3');
        const where = [
          `e.latitude IS NOT NULL`,
          bounds,
          eventVisibleSql('$1::uuid'),
          `e.status = 'published' AND ${UPCOMING_SQL}`,
          ...filters,
        ];
        const outer: string[] = [`x.distance_km <= $4`];
        if (cur && cur.d !== undefined) {
          params.push(cur.d, cur.id);
          outer.push(
            `(x.distance_km, x.id) > ($${params.length - 1}::float8, $${params.length}::uuid)`,
          );
        }
        params.push(limit + 1);
        const { rows } = await ctx.db.query<EventRow & { distance_km: number }>(
          `SELECT * FROM (SELECT ${eventSelect('$1::uuid')}, ${dist} AS distance_km FROM events e WHERE ${where.join(' AND ')}) x
            WHERE ${outer.join(' AND ')} ORDER BY x.distance_km, x.id LIMIT $${params.length}`,
          params,
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydrateEvents(ctx, viewer, page),
          nextCursor:
            rows.length > limit && last ? encodeCursor({ d: last.distance_km, id: last.id }) : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/events',
      summary: 'Your events: hosting, attending, interested, waitlist, saved, invited or past',
      tags: ['events'],
      auth: 'user',
      query: mineQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const params: unknown[] = [auth.userId];
        const role = query.role;
        let from = 'events e';
        const where = [eventVisibleSql('$1::uuid')];
        let order = 'ASC';
        if (role === 'hosting') {
          where.push(
            `(e.host_id = $1 OR EXISTS (SELECT 1 FROM event_organizers eo WHERE eo.event_id = e.id AND eo.user_id = $1))`,
            `e.status IN ('draft','published') AND ${UPCOMING_SQL}`,
          );
        } else if (role === 'attending' || role === 'interested' || role === 'waitlist') {
          from = 'events e JOIN event_attendees ma ON ma.event_id = e.id AND ma.user_id = $1';
          where.push(
            role === 'attending' ? `ma.status IN ('going','attended')` : `ma.status = '${role}'`,
            `e.status = 'published' AND ${UPCOMING_SQL}`,
          );
        } else if (role === 'saved') {
          from = `events e JOIN saves ms ON ms.target_type = 'event' AND ms.target_id = e.id AND ms.user_id = $1`;
          where.push(`e.status IN ('published','cancelled') AND ${UPCOMING_SQL}`);
        } else if (role === 'invited') {
          from = `events e JOIN event_invitations mi ON mi.event_id = e.id AND mi.user_id = $1 AND mi.status = 'pending'`;
          where.push(`e.status = 'published' AND ${UPCOMING_SQL}`);
        } else {
          from = 'events e JOIN event_attendees ma ON ma.event_id = e.id AND ma.user_id = $1';
          where.push(
            `ma.status IN ('going','attended')`,
            `e.status IN ('published','completed') AND ${PAST_SQL}`,
          );
          order = 'DESC';
        }
        if (cur?.t) {
          params.push(cur.t, cur.id);
          where.push(
            `(e.starts_at, e.id) ${order === 'ASC' ? '>' : '<'} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        params.push(limit + 1);
        const { rows } = await ctx.db.query<EventRow>(
          `SELECT ${eventSelect('$1::uuid')} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY e.starts_at ${order}, e.id ${order} LIMIT $${params.length}`,
          params,
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await hydrateEvents(ctx, auth.userId, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.starts_at.toISOString(), id: last.id })
              : null,
        };
      },
    });
  },
};

function assertTicketWindow(e: EventRow, start: Date | null, end: Date | null): void {
  if (start && end && end <= start) throw invalid('salesEnd must be after salesStart');
  const eventEnd = e.ends_at ?? e.starts_at;
  if (end && end > eventEnd) throw invalid('Ticket sales must end by the time the event ends');
}

// Re-exported for other modules that need the shared predicates.
export { eventVisibleSql, organiserSql } from './access.js';
export { recountEvent, promoteWaitlist };
export type { Tx };
