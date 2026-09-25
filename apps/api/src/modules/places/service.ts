import { z } from 'zod';
import type { Queryable } from '@yapilapi/database';
import { AppError, forbidden, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { hoursSchema, isOpenNow, timezoneSchema } from '../../lib/hours.js';
import { mediaUrl } from '../../lib/media-url.js';
import { getBusinessAccess, can } from '../business/access.js';

export const PLACE_KINDS = ['restaurant', 'store', 'venue', 'attraction', 'service'] as const;
export const STAFF_REVIEWERS = ['moderator', 'admin', 'superadmin'] as const;

/** Staff acting through a normal user route must hold a moderator+ role and have signed in with MFA (same bar as `auth: { staff }`). */
export const isPlaceStaff = (auth: AuthContext | null): boolean =>
  Boolean(
    auth && (STAFF_REVIEWERS as readonly string[]).includes(auth.platformRole) && auth.mfaVerified,
  );

// ------------------------------------------------------------------ schemas
export const addressSchema = z
  .object({
    line1: z.string().trim().max(200),
    line2: z.string().trim().max(200),
    city: z.string().trim().max(100),
    region: z.string().trim().max(100),
    postal_code: z.string().trim().max(20),
    country: z.string().trim().max(100),
  })
  .partial()
  .strict();
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+()\-.\s0-9]{5,30}$/, 'Enter a valid phone number');
export const websiteSchema = z.url({ protocol: /^https?$/ }).max(500);

export const placeFields = {
  name: z.string().trim().min(2).max(160),
  kind: z.enum(PLACE_KINDS),
  description: z.string().trim().max(5000),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: addressSchema,
  hours: hoursSchema,
  timezone: timezoneSchema,
  phone: phoneSchema,
  website: websiteSchema,
  capacity: z.number().int().min(1).max(100_000),
};

export const placeCreateBody = z.object({
  name: placeFields.name,
  kind: placeFields.kind,
  description: placeFields.description.default(''),
  latitude: placeFields.latitude,
  longitude: placeFields.longitude,
  address: placeFields.address.default({}),
  hours: placeFields.hours.default({}),
  timezone: placeFields.timezone.default('UTC'),
  phone: placeFields.phone.optional(),
  website: placeFields.website.optional(),
  capacity: placeFields.capacity.optional(),
});

/** Fields an owner may set directly. Also the whitelist for edit suggestions (minus bookingEnabled). */
export const placePatchBody = z
  .object({
    name: placeFields.name,
    kind: placeFields.kind,
    description: placeFields.description,
    latitude: placeFields.latitude,
    longitude: placeFields.longitude,
    address: placeFields.address,
    hours: placeFields.hours,
    timezone: placeFields.timezone,
    phone: placeFields.phone.nullable(),
    website: placeFields.website.nullable(),
    capacity: placeFields.capacity.nullable(),
  })
  .partial()
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), {
    message: 'Provide both latitude and longitude',
  });

export type PlacePatch = z.infer<typeof placePatchBody>;

export const suggestionChangesSchema = placePatchBody.refine((b) => Object.keys(b).length > 0, {
  message: 'Suggest at least one change',
});

export const COLUMN_OF: Record<keyof PlacePatch, string> = {
  name: 'name',
  kind: 'kind',
  description: 'description',
  latitude: 'latitude',
  longitude: 'longitude',
  address: 'address',
  hours: 'hours',
  timezone: 'timezone',
  phone: 'phone',
  website: 'website',
  capacity: 'capacity',
};
const JSON_COLS = new Set(['address', 'hours']);

/** Apply a validated patch. Column names come from the COLUMN_OF constant, values are bound parameters. */
export async function applyPlacePatch(
  db: Queryable,
  placeId: string,
  patch: PlacePatch,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [placeId];
  for (const [k, v] of Object.entries(patch) as Array<[keyof PlacePatch, unknown]>) {
    if (v === undefined) continue;
    const col = COLUMN_OF[k];
    vals.push(JSON_COLS.has(col) ? JSON.stringify(v) : v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length)
    await db.query(
      `UPDATE places SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
      vals,
    );
}

// ------------------------------------------------------------------ access
export interface PlaceRow {
  id: string;
  name: string;
  kind: string;
  description: string;
  latitude: number;
  longitude: number;
  address: Record<string, unknown>;
  hours: Record<string, unknown>;
  timezone: string;
  phone: string | null;
  website: string | null;
  capacity: number | null;
  booking_enabled: boolean;
  business_id: string | null;
  created_by: string | null;
  rating_avg: string;
  rating_count: number;
  created_at: Date;
  updated_at: Date;
  distance_km?: number;
}

export const PLACE_COLUMNS = `p.id, p.name, p.kind, p.description, p.latitude, p.longitude, p.address, p.hours, p.timezone, p.phone, p.website, p.capacity,
  p.booking_enabled, p.business_id, p.created_by, p.rating_avg, p.rating_count, p.created_at, p.updated_at`;

export async function loadPlace(db: Queryable, placeId: string): Promise<PlaceRow> {
  const { rows } = await db.query<PlaceRow>(
    `SELECT ${PLACE_COLUMNS} FROM places p WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [placeId],
  );
  if (!rows[0]) throw notFound('Place');
  return rows[0];
}

export type PlaceRole = 'staff' | 'owner_team' | 'creator' | null;

/**
 * Who may edit a place directly: staff (moderator+ with MFA), the owning business's team (places.manage), or — only while the place is unclaimed —
 * the user who created it. Everyone else proposes changes through edit suggestions.
 */
export async function placeRole(
  db: Queryable,
  place: PlaceRow,
  auth: AuthContext | null,
): Promise<PlaceRole> {
  if (!auth) return null;
  if (isPlaceStaff(auth)) return 'staff';
  if (place.business_id) {
    const a = await getBusinessAccess(db, place.business_id, auth.userId);
    return can(a, 'places.manage') && a?.status === 'active' ? 'owner_team' : null;
  }
  return place.created_by === auth.userId ? 'creator' : null;
}

/** Who reviews suggestions/photos: staff, or the owning business team. (The creator of an unclaimed place cannot approve edits to it.) */
export async function isPlaceReviewer(
  db: Queryable,
  place: PlaceRow,
  auth: AuthContext | null,
): Promise<boolean> {
  const r = await placeRole(db, place, auth);
  return r === 'staff' || r === 'owner_team';
}

export async function requireEditor(
  db: Queryable,
  place: PlaceRow,
  auth: AuthContext,
): Promise<Exclude<PlaceRole, null>> {
  const r = await placeRole(db, place, auth);
  if (!r) throw forbidden('You cannot edit this place directly. Suggest an edit instead.');
  return r;
}

// ------------------------------------------------------------------ rating aggregate
/**
 * Recompute rating_avg/rating_count from approved, non-deleted reviews. Callers hold the place row lock (`lockPlace`) so concurrent writers
 * serialise and the aggregate is always consistent with the committed reviews. Exported for the safety module: call after changing the
 * moderation status of a review.
 */
export async function recomputePlaceRating(db: Queryable, placeId: string): Promise<void> {
  await db.query(
    `UPDATE places SET
       rating_count = (SELECT count(*) FROM reviews WHERE target_type = 'place' AND target_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved'),
       rating_avg = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews WHERE target_type = 'place' AND target_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved'), 0)
     WHERE id = $1`,
    [placeId],
  );
}

export async function lockPlace(tx: Queryable, placeId: string): Promise<void> {
  const r = await tx.query('SELECT 1 FROM places WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [
    placeId,
  ]);
  if (!r.rowCount) throw notFound('Place');
}

// ------------------------------------------------------------------ views
export async function hydratePlaces(
  ctx: AppContext,
  viewerId: string | null,
  rows: PlaceRow[],
  opts: { detail?: boolean } = {},
) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const bizIds = [
    ...new Set(rows.map((r) => r.business_id).filter((x): x is string => Boolean(x))),
  ];
  const [biz, saved, photos, breakdown] = await Promise.all([
    ctx.db.query<{ id: string; slug: string; name: string; verified_at: Date | null }>(
      "SELECT id, slug, name, verified_at FROM businesses WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status = 'active'",
      [bizIds],
    ),
    viewerId
      ? ctx.db.query<{ target_id: string }>(
          `SELECT target_id FROM saves WHERE user_id = $1 AND target_type = 'place' AND target_id = ANY($2::uuid[])`,
          [viewerId, ids],
        )
      : Promise.resolve({ rows: [] as Array<{ target_id: string }> }),
    ctx.db.query<{
      place_id: string;
      storage_key: string;
      caption: string | null;
      media_id: string;
    }>(
      `SELECT pm.place_id, m.storage_key, pm.caption, pm.media_id FROM place_media pm JOIN media m ON m.id = pm.media_id AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')
        WHERE pm.place_id = ANY($1::uuid[]) AND pm.moderation_status = 'approved' ORDER BY pm.place_id, pm.position, pm.created_at`,
      [ids],
    ),
    opts.detail
      ? ctx.db.query<{ target_id: string; rating: number; n: number }>(
          `SELECT target_id, rating, count(*)::int AS n FROM reviews WHERE target_type = 'place' AND target_id = ANY($1::uuid[]) AND deleted_at IS NULL AND moderation_status = 'approved' GROUP BY target_id, rating`,
          [ids],
        )
      : Promise.resolve({ rows: [] as Array<{ target_id: string; rating: number; n: number }> }),
  ]);
  const bizBy = new Map(biz.rows.map((b) => [b.id, b]));
  const savedSet = new Set(saved.rows.map((s) => s.target_id));
  const photoBy = new Map<
    string,
    Array<{ mediaId: string; url: string; caption: string | null }>
  >();
  for (const p of photos.rows)
    photoBy.set(p.place_id, [
      ...(photoBy.get(p.place_id) ?? []),
      { mediaId: p.media_id, url: mediaUrl(ctx.config, p.storage_key), caption: p.caption },
    ]);
  const brk = new Map<string, Record<string, number>>();
  for (const b of breakdown.rows)
    brk.set(b.target_id, { ...(brk.get(b.target_id) ?? {}), [String(b.rating)]: b.n });
  const now = new Date();
  return rows.map((r) => {
    const b = r.business_id ? bizBy.get(r.business_id) : undefined;
    const all = photoBy.get(r.id) ?? [];
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      description: r.description,
      latitude: r.latitude,
      longitude: r.longitude,
      address: r.address,
      hours: r.hours,
      timezone: r.timezone,
      isOpenNow: isOpenNow(r.hours, r.timezone, now),
      phone: r.phone,
      website: r.website,
      capacity: r.capacity,
      bookingEnabled: r.booking_enabled,
      claimed: r.business_id !== null,
      business: b
        ? { id: b.id, slug: b.slug, name: b.name, verified: Boolean(b.verified_at) }
        : null,
      rating: {
        average: Number(r.rating_avg),
        count: r.rating_count,
        ...(opts.detail
          ? {
              breakdown: Object.fromEntries(
                [1, 2, 3, 4, 5].map((n) => [String(n), brk.get(r.id)?.[String(n)] ?? 0]),
              ),
            }
          : {}),
      },
      coverUrl: all[0]?.url ?? null,
      ...(opts.detail ? { photos: all.slice(0, 12) } : {}),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      ...(r.distance_km !== undefined ? { distanceKm: Math.round(r.distance_km * 100) / 100 } : {}),
      viewer: { saved: savedSet.has(r.id) },
    };
  });
}

export function unprocessable(msg: string, details?: unknown): AppError {
  return new AppError('unprocessable', msg, details);
}
