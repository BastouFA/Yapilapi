import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { isWithinHours, hasHours, localParts } from '../../lib/hours.js';
import { mediaUrl } from '../../lib/media-url.js';
import { notifyEventAudience, cancelEvent } from '../events/service.js';
import {
  ROLE_PERMISSIONS,
  getBusinessAccess,
  type BusinessAccess,
  type BusinessPermission,
} from './access.js';
import {
  BOOKING_ACTIVE,
  nextBookingStatus,
  type BookingAction,
  type BookingStatus,
} from './booking-state.js';

// ------------------------------------------------------------------ business rows & views
export const BUSINESS_COLUMNS = `b.id, b.owner_id, b.slug, b.name, b.legal_name, b.category, b.description, b.logo_url, b.cover_url, b.logo_media_id, b.cover_media_id,
  b.contact, b.links, b.hours, b.timezone, b.address, b.booking_settings, b.status, b.verified_at, b.ai_assistant_enabled, b.follower_count, b.created_at, b.updated_at`;

export interface BusinessRow {
  id: string;
  owner_id: string | null;
  slug: string;
  name: string;
  legal_name: string | null;
  category: string;
  description: string;
  logo_url: string | null;
  cover_url: string | null;
  logo_media_id: string | null;
  cover_media_id: string | null;
  contact: Record<string, unknown>;
  links: unknown[];
  hours: Record<string, unknown>;
  timezone: string;
  address: Record<string, unknown>;
  booking_settings: Record<string, unknown>;
  status: string;
  verified_at: Date | null;
  ai_assistant_enabled: boolean;
  follower_count: number;
  created_at: Date;
  updated_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);
export const RESERVED_SLUGS = new Set([
  'new',
  'create',
  'mine',
  'search',
  'explore',
  'discover',
  'admin',
  'settings',
  'invitations',
  'yapilapi',
  'staff',
  'me',
]);

/** Resolve by id or slug. Non-team viewers only see active businesses whose owner has no block with them (404 otherwise). */
export async function loadBusiness(
  db: Queryable,
  ref: string,
  viewerId: string | null,
): Promise<{ b: BusinessRow; access: BusinessAccess | null }> {
  const { rows } = await db.query<BusinessRow>(
    `SELECT ${BUSINESS_COLUMNS} FROM businesses b WHERE b.deleted_at IS NULL AND ${isUuid(ref) ? 'b.id = $1::uuid' : 'b.slug = $1::citext'}`,
    [ref.toLowerCase()],
  );
  const b = rows[0];
  if (!b) throw notFound('Business');
  const access = await getBusinessAccess(db, b.id, viewerId);
  if (!access) {
    if (b.status !== 'active') throw notFound('Business');
    if (viewerId && b.owner_id && (await isBlockedEitherWay(db, viewerId, b.owner_id)))
      throw notFound('Business');
  }
  return { b, access };
}

const bookingSettingsShape = {
  slotMinutes: z.number().int().min(5).max(240),
  leadTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 14),
  maxAdvanceDays: z.number().int().min(1).max(365),
  maxDurationMinutes: z.number().int().min(5).max(1440),
  maxPartySize: z.number().int().min(1).max(500),
  autoConfirm: z.boolean(),
};
export const BookingSettingsSchema = z.object({
  slotMinutes: bookingSettingsShape.slotMinutes.default(30),
  leadTimeMinutes: bookingSettingsShape.leadTimeMinutes.default(60),
  maxAdvanceDays: bookingSettingsShape.maxAdvanceDays.default(90),
  maxDurationMinutes: bookingSettingsShape.maxDurationMinutes.default(480),
  maxPartySize: bookingSettingsShape.maxPartySize.default(20),
  autoConfirm: bookingSettingsShape.autoConfirm.default(false),
});
/** Patch shape: no defaults, so omitted keys keep their stored value when merged. */
export const BookingSettingsPatchSchema = z.object(bookingSettingsShape).partial().strict();
export type BookingSettings = z.infer<typeof BookingSettingsSchema>;
export const bookingSettingsOf = (raw: unknown): BookingSettings =>
  BookingSettingsSchema.parse(raw && typeof raw === 'object' ? raw : {});

export function businessView(
  b: BusinessRow,
  access: BusinessAccess | null,
  extra: { following?: boolean } = {},
) {
  const team = Boolean(access);
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    category: b.category,
    description: b.description,
    contact: b.contact,
    links: b.links,
    hours: b.hours,
    timezone: b.timezone,
    address: b.address,
    verified: Boolean(b.verified_at),
    verifiedAt: b.verified_at?.toISOString() ?? null,
    followerCount: b.follower_count,
    bookingSettings: bookingSettingsOf(b.booking_settings),
    createdAt: b.created_at.toISOString(),
    ...(team
      ? {
          legalName: b.legal_name,
          status: b.status,
          aiAssistantEnabled: b.ai_assistant_enabled,
          ownerId: b.owner_id,
        }
      : {}),
    viewer: {
      role: access?.role ?? null,
      permissions: access ? [...access.permissions] : [],
      following: extra.following ?? false,
    },
  };
}

/** Attach logo/cover URLs (from media ids) to business views. */
export async function withImages<T extends { id: string }>(
  ctx: AppContext,
  rows: BusinessRow[],
  views: T[],
): Promise<Array<T & { logoUrl: string | null; coverUrl: string | null }>> {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.logo_media_id, r.cover_media_id])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const m = ids.length
    ? await ctx.db.query<{ id: string; storage_key: string }>(
        'SELECT id, storage_key FROM media WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
        [ids],
      )
    : { rows: [] };
  const by = new Map(m.rows.map((r) => [r.id, mediaUrl(ctx.config, r.storage_key)]));
  return views.map((v, i) => {
    const r = rows[i]!;
    return {
      ...v,
      logoUrl: r.logo_media_id ? (by.get(r.logo_media_id) ?? null) : r.logo_url,
      coverUrl: r.cover_media_id ? (by.get(r.cover_media_id) ?? null) : r.cover_url,
    };
  });
}

/** Users on the team whose role holds `perm` (for fan-out notifications). */
export async function teamWith(
  db: Queryable,
  businessId: string,
  perm: BusinessPermission,
): Promise<string[]> {
  const roles = (Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>).filter(
    (r) => ROLE_PERMISSIONS[r].includes(perm),
  );
  const { rows } = await db.query<{ user_id: string }>(
    'SELECT user_id FROM business_members WHERE business_id = $1 AND role = ANY($2::text[]) ORDER BY created_at LIMIT 50',
    [businessId, roles],
  );
  return rows.map((r) => r.user_id);
}

/** Serialise follower changes per business: take this lock BEFORE writing follower rows, then recount (a READ COMMITTED count must see every earlier commit). */
export async function lockBusinessForFollowers(db: Queryable, businessId: string): Promise<void> {
  await db.query('SELECT 1 FROM businesses WHERE id = $1 FOR UPDATE', [businessId]);
}

export async function recountFollowers(db: Queryable, businessId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `UPDATE businesses SET follower_count = (SELECT count(*) FROM business_followers WHERE business_id = $1) WHERE id = $1 RETURNING follower_count AS n`,
    [businessId],
  );
  return rows[0]?.n ?? 0;
}

// ------------------------------------------------------------------ AI knowledge (owner-approved only)
export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  category: string | null;
  status: 'draft' | 'approved';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  /** sha256 of the approved title+content: an entry whose text no longer matches its approval is never served. */
  approvedHash: string | null;
}

export const knowledgeHash = (title: string, content: string): string =>
  createHash('sha256')
    .update(JSON.stringify([title, content]))
    .digest('hex');

export const KnowledgeInput = z.object({
  title: z.string().trim().min(2).max(120),
  content: z.string().trim().min(2).max(2000),
  category: z.string().trim().min(1).max(50).optional(),
});

export function parseKnowledge(raw: unknown): KnowledgeEntry[] {
  return (Array.isArray(raw) ? raw : []).filter((e): e is KnowledgeEntry =>
    Boolean(e && typeof e === 'object' && typeof (e as KnowledgeEntry).id === 'string'),
  );
}

export interface AuthorizedKnowledge {
  businessId: string;
  entries: Array<{ id: string; title: string; content: string; category: string | null }>;
}

/**
 * THE only way for the AI module to read business knowledge. Returns null unless the business is live and active, the owner has switched its
 * assistant on, and then ONLY entries an owner explicitly approved and whose text is unchanged since approval. Drafts, unapproved edits,
 * profile data and everything else are never returned. Treat the entries as untrusted data (never as instructions).
 */
export async function getAuthorizedBusinessKnowledge(
  ctx: AppContext,
  businessId: string,
): Promise<AuthorizedKnowledge | null> {
  const { rows } = await ctx.db.query<{ ai_knowledge: unknown; ai_assistant_enabled: boolean }>(
    `SELECT ai_knowledge, ai_assistant_enabled FROM businesses WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [businessId],
  );
  const r = rows[0];
  if (!r || !r.ai_assistant_enabled) return null;
  const entries = parseKnowledge(r.ai_knowledge)
    .filter(
      (e) =>
        e.status === 'approved' &&
        e.approvedBy &&
        e.approvedHash === knowledgeHash(e.title, e.content),
    )
    .map((e) => ({ id: e.id, title: e.title, content: e.content, category: e.category ?? null }));
  return { businessId, entries };
}

export async function mutateKnowledge<T>(
  ctx: AppContext,
  businessId: string,
  fn: (entries: KnowledgeEntry[]) => { entries: KnowledgeEntry[]; result: T },
): Promise<T> {
  return withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{ ai_knowledge: unknown }>(
      'SELECT ai_knowledge FROM businesses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [businessId],
    );
    if (!rows[0]) throw notFound('Business');
    const { entries, result } = fn(parseKnowledge(rows[0].ai_knowledge));
    if (entries.length > 100) throw conflict('At most 100 knowledge entries are allowed');
    if (JSON.stringify(entries).length > 100_000) throw conflict('The knowledge base is too large');
    await tx.query('UPDATE businesses SET ai_knowledge = $2 WHERE id = $1', [
      businessId,
      JSON.stringify(entries),
    ]);
    return result;
  });
}

export const newEntry = (userId: string, input: z.infer<typeof KnowledgeInput>): KnowledgeEntry => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: input.title,
    content: input.content,
    category: input.category ?? null,
    status: 'draft',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    approvedBy: null,
    approvedAt: null,
    approvedHash: null,
  };
};

// ------------------------------------------------------------------ bookings
export interface BookingInput {
  placeId?: string | undefined;
  productId?: string | undefined;
  startsAt: Date;
  durationMinutes: number;
  partySize: number;
  notes: string;
}

interface Resource {
  kind: 'place' | 'product';
  id: string;
  businessId: string;
  hours: unknown;
  timezone: string;
  capacity: number;
  label: string;
}

async function resolveResource(
  db: Queryable,
  input: Pick<BookingInput, 'placeId' | 'productId'>,
): Promise<Resource> {
  if (Boolean(input.placeId) === Boolean(input.productId))
    throw invalid('Provide exactly one of placeId or productId');
  if (input.placeId) {
    const { rows } = await db.query<{
      id: string;
      name: string;
      hours: unknown;
      timezone: string;
      capacity: number | null;
      business_id: string | null;
      booking_enabled: boolean;
    }>(
      'SELECT id, name, hours, timezone, capacity, business_id, booking_enabled FROM places WHERE id = $1 AND deleted_at IS NULL',
      [input.placeId],
    );
    const p = rows[0];
    if (!p || !p.business_id || !p.booking_enabled) throw notFound('Bookable place');
    if (!p.capacity)
      throw new AppError('unprocessable', 'This place has not set its booking capacity');
    return {
      kind: 'place',
      id: p.id,
      businessId: p.business_id,
      hours: p.hours,
      timezone: p.timezone,
      capacity: p.capacity,
      label: p.name,
    };
  }
  const { rows } = await db.query<{
    id: string;
    title: string;
    business_id: string | null;
    hours: unknown;
    timezone: string;
  }>(
    `SELECT pr.id, pr.title, pr.business_id, b.hours, b.timezone FROM products pr JOIN businesses b ON b.id = pr.business_id AND b.deleted_at IS NULL
      WHERE pr.id = $1 AND pr.deleted_at IS NULL AND pr.status = 'active' AND pr.kind IN ('service','booking')`,
    [input.productId],
  );
  const p = rows[0];
  if (!p?.business_id) throw notFound('Bookable service');
  return {
    kind: 'product',
    id: p.id,
    businessId: p.business_id,
    hours: p.hours,
    timezone: p.timezone,
    capacity: 1,
    label: p.title,
  };
}

/**
 * Create a booking request. Validates the slot (lead time, horizon, alignment to the slot grid, opening hours in the resource's timezone,
 * party size), then — under a per-resource advisory lock so parallel requests are serialised — checks free capacity against requested and
 * confirmed bookings. Exactly one of N parallel requests for the last slot succeeds; the rest get 409 `slot_unavailable`.
 */
export async function createBooking(
  ctx: AppContext,
  customerId: string,
  input: BookingInput,
): Promise<{ id: string; businessId: string; status: BookingStatus }> {
  const res = await resolveResource(ctx.db, input);
  const biz = await ctx.db.query<{
    status: string;
    owner_id: string | null;
    booking_settings: unknown;
    name: string;
  }>(
    'SELECT status, owner_id, booking_settings, name FROM businesses WHERE id = $1 AND deleted_at IS NULL',
    [res.businessId],
  );
  const b = biz.rows[0];
  if (!b || b.status !== 'active') throw notFound('Bookable place');
  if (await getBusinessAccess(ctx.db, res.businessId, customerId))
    throw forbidden('You cannot book your own business');
  if (b.owner_id && (await isBlockedEitherWay(ctx.db, customerId, b.owner_id)))
    throw notFound('Bookable place');
  assertTextAllowed(input.notes);

  const s = bookingSettingsOf(b.booking_settings);
  const now = Date.now();
  const startMs = input.startsAt.getTime();
  const endsAt = new Date(startMs + input.durationMinutes * 60_000);
  if (startMs < now + s.leadTimeMinutes * 60_000)
    throw invalid(`Bookings need at least ${s.leadTimeMinutes} minutes notice`);
  if (startMs > now + s.maxAdvanceDays * 86_400_000)
    throw invalid(`Bookings can be made at most ${s.maxAdvanceDays} days ahead`);
  if (input.durationMinutes % s.slotMinutes !== 0 || input.durationMinutes < s.slotMinutes)
    throw invalid(`Duration must be a multiple of ${s.slotMinutes} minutes`);
  if (input.durationMinutes > s.maxDurationMinutes)
    throw invalid(`Bookings can last at most ${s.maxDurationMinutes} minutes`);
  if (localParts(input.startsAt, res.timezone).minutes % s.slotMinutes !== 0)
    throw invalid(`Start time must fall on a ${s.slotMinutes}-minute slot`);
  if (!hasHours(res.hours))
    throw new AppError('unprocessable', 'This business has not published opening hours yet');
  if (!isWithinHours(res.hours, res.timezone, input.startsAt, input.durationMinutes))
    throw new AppError('unprocessable', 'That time is outside opening hours', {
      reason: 'outside_hours',
    });
  if (input.partySize > s.maxPartySize) throw invalid(`Party size cannot exceed ${s.maxPartySize}`);
  if (res.kind === 'place' && input.partySize > res.capacity)
    throw new AppError('unprocessable', 'Party size exceeds the capacity of this place', {
      reason: 'party_too_large',
    });

  const status: BookingStatus = s.autoConfirm ? 'confirmed' : 'requested';
  const resCol = res.kind === 'place' ? 'place_id' : 'product_id';
  const out = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `booking:${res.kind}:${res.id}`,
    ]);
    const mine = await tx.query(
      `SELECT 1 FROM bookings WHERE customer_id = $1 AND ${resCol} = $2 AND status = ANY($3::text[]) AND starts_at < $5 AND ends_at > $4 LIMIT 1`,
      [customerId, res.id, [...BOOKING_ACTIVE], input.startsAt, endsAt],
    );
    if (mine.rowCount)
      throw conflict('You already have a booking at that time', { reason: 'duplicate_booking' });
    const open = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1 AND status = ANY($2::text[]) AND starts_at > now()`,
      [customerId, [...BOOKING_ACTIVE]],
    );
    if (open.rows[0]!.n >= 20)
      throw conflict('You have too many upcoming bookings', { reason: 'too_many_bookings' });
    const used = await tx.query<{ n: number }>(
      `SELECT COALESCE(${res.kind === 'place' ? 'sum(party_size)' : 'count(*)'}, 0)::int AS n FROM bookings WHERE ${resCol} = $1 AND status = ANY($2::text[]) AND starts_at < $4 AND ends_at > $3`,
      [res.id, [...BOOKING_ACTIVE], input.startsAt, endsAt],
    );
    const needed = res.kind === 'place' ? input.partySize : 1;
    const available = Math.max(0, res.capacity - used.rows[0]!.n);
    if (available < needed)
      throw conflict('That time slot is no longer available', {
        reason: 'slot_unavailable',
        available,
      });
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO bookings (${resCol}, customer_id, business_id, starts_at, ends_at, party_size, status, notes, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7 = 'confirmed' THEN now() END) RETURNING id`,
      [
        res.id,
        customerId,
        res.businessId,
        input.startsAt,
        endsAt,
        input.partySize,
        status,
        input.notes,
      ],
    );
    return ins.rows[0]!.id;
  });
  const data = {
    label: res.label,
    startsAt: input.startsAt.toISOString(),
    partySize: input.partySize,
    business: b.name,
  };
  for (const userId of await teamWith(ctx.db, res.businessId, 'bookings.manage')) {
    await notify(ctx, {
      userId,
      kind: 'booking_requested',
      actorId: customerId,
      targetType: 'booking',
      targetId: out,
      data,
    });
  }
  if (status === 'confirmed')
    await notify(ctx, {
      userId: customerId,
      kind: 'booking_confirmed',
      actorId: null,
      targetType: 'booking',
      targetId: out,
      data,
    });
  return { id: out, businessId: res.businessId, status };
}

/** Apply a state-machine action to a booking under a row lock. `actor` is derived from the caller's real relationship to the booking. */
export async function transitionBooking(
  ctx: AppContext,
  p: { bookingId: string; userId: string; action: BookingAction; reason?: string | undefined },
): Promise<{
  id: string;
  status: BookingStatus;
  businessId: string | null;
  customerId: string;
  actor: 'customer' | 'business';
}> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      customer_id: string;
      business_id: string | null;
      status: BookingStatus;
      starts_at: Date;
      place_id: string | null;
      product_id: string | null;
      party_size: number;
    }>(
      'SELECT id, customer_id, business_id, status, starts_at, place_id, product_id, party_size FROM bookings WHERE id = $1 FOR UPDATE',
      [p.bookingId],
    );
    const bk = rows[0];
    if (!bk) throw notFound('Booking');
    let actor: 'customer' | 'business' | null = null;
    if (bk.customer_id === p.userId) actor = 'customer';
    else if (bk.business_id) {
      const a = await getBusinessAccess(tx, bk.business_id, p.userId);
      if (a?.permissions.includes('bookings.manage')) actor = 'business';
    }
    if (!actor) throw notFound('Booking');
    const next = nextBookingStatus(bk.status, p.action, actor, bk.starts_at);
    await tx.query(
      `UPDATE bookings SET status = $2, decided_at = now(), reason = COALESCE($3, reason), cancelled_by = CASE WHEN $2 = 'cancelled' THEN $4 ELSE cancelled_by END WHERE id = $1`,
      [bk.id, next, p.reason ?? null, actor],
    );
    return { bk, next, actor };
  });
  const { bk, next, actor } = out;
  // Notify the other side (never the actor).
  const data = { status: next, startsAt: bk.starts_at.toISOString(), reason: p.reason ?? null };
  const kind = `booking_${next === 'no_show' ? 'no_show' : next}`;
  if (actor === 'business')
    await notify(ctx, {
      userId: bk.customer_id,
      kind,
      actorId: p.userId,
      targetType: 'booking',
      targetId: bk.id,
      data,
    });
  else if (bk.business_id)
    for (const userId of await teamWith(ctx.db, bk.business_id, 'bookings.manage'))
      await notify(ctx, {
        userId,
        kind,
        actorId: p.userId,
        targetType: 'booking',
        targetId: bk.id,
        data,
      });
  return { id: bk.id, status: next, businessId: bk.business_id, customerId: bk.customer_id, actor };
}

/** Job: bookings still `requested` after their start time can never be confirmed; cancel them (by the system) and tell the customer. */
export async function expireStaleBookings(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string; customer_id: string }>(
    `UPDATE bookings SET status = 'cancelled', cancelled_by = 'system', reason = 'The business did not respond in time', decided_at = $1
      WHERE status = 'requested' AND starts_at <= $1 RETURNING id, customer_id`,
    [now],
  );
  for (const r of rows)
    await notify(ctx, {
      userId: r.customer_id,
      kind: 'booking_cancelled',
      actorId: null,
      targetType: 'booking',
      targetId: r.id,
      data: { reason: 'expired' },
    });
  return rows.length;
}

// ------------------------------------------------------------------ closing a business (owner delete / owner account deletion)
/**
 * Close a business inside `tx`: soft-delete it, release its places, cancel upcoming bookings and events (notifying the people affected).
 * Product/order cleanup belongs to commerce, which should react to `businesses.status = 'closed'`.
 */
export async function closeBusiness(
  ctx: AppContext,
  tx: Tx,
  businessId: string,
  actorId: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE businesses SET status = 'closed', deleted_at = now(), ai_assistant_enabled = false WHERE id = $1 AND deleted_at IS NULL`,
    [businessId],
  );
  await tx.query(
    'UPDATE places SET business_id = NULL, booking_enabled = false WHERE business_id = $1',
    [businessId],
  );
  const bks = await tx.query<{ id: string; customer_id: string }>(
    `UPDATE bookings SET status = 'cancelled', cancelled_by = 'business', reason = 'The business closed', decided_at = now()
      WHERE business_id = $1 AND status = ANY($2::text[]) AND starts_at > now() RETURNING id, customer_id`,
    [businessId, [...BOOKING_ACTIVE]],
  );
  for (const b of bks.rows)
    await notify(
      ctx,
      {
        userId: b.customer_id,
        kind: 'booking_cancelled',
        actorId,
        targetType: 'booking',
        targetId: b.id,
        data: { reason: 'business_closed' },
      },
      tx,
    );
  const evs = await tx.query<{ id: string }>(
    `SELECT id FROM events WHERE host_business_id = $1 AND deleted_at IS NULL AND status IN ('draft','published')`,
    [businessId],
  );
  for (const e of evs.rows) {
    await cancelEvent(ctx, { eventId: e.id, actorId, reason: 'The hosting business closed' }, tx);
    await notifyEventAudience(
      ctx,
      e.id,
      ['going', 'waitlist', 'interested'],
      { kind: 'event_cancelled', actorId, data: { reason: 'business_closed' } },
      undefined,
      tx,
    );
  }
  await tx.query(
    `UPDATE place_claims SET status = 'withdrawn' WHERE business_id = $1 AND status = 'pending'`,
    [businessId],
  );
}
