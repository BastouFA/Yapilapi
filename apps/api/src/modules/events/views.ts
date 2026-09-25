import type { AppContext } from '../../lib/context.js';
import { mediaUrl } from '../../lib/media-url.js';
import type { EventRow } from './access.js';
import type { DbRow } from '../../lib/db-row.js';

type Row = EventRow & { distance_km?: number };

export interface TicketTypeView {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  free: boolean;
  quantity: number;
  sold: number;
  remaining: number;
  maxPerUser: number;
  salesStart: string | null;
  salesEnd: string | null;
  onSale: boolean;
  archived: boolean;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function loadUserSummaries(
  ctx: AppContext,
  ids: string[],
): Promise<Map<string, UserSummary>> {
  const out = new Map<string, UserSummary>();
  if (!ids.length) return out;
  const { rows } = await ctx.db.query<{
    user_id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  }>(
    'SELECT user_id, username, display_name, avatar_url FROM profiles WHERE user_id = ANY($1::uuid[])',
    [ids],
  );
  for (const r of rows)
    out.set(r.user_id, {
      id: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
    });
  return out;
}

export function ticketTypeView(r: DbRow, now = new Date()): TicketTypeView {
  const start: Date | null = r.sales_start;
  const end: Date | null = r.sales_end;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: r.price_cents,
    currency: r.currency,
    free: r.price_cents === 0,
    quantity: r.quantity,
    sold: r.sold,
    remaining: Math.max(0, r.quantity - r.sold),
    maxPerUser: r.max_per_user,
    salesStart: start?.toISOString() ?? null,
    salesEnd: end?.toISOString() ?? null,
    onSale:
      !r.archived_at && (!start || start <= now) && (!end || end > now) && r.quantity - r.sold > 0,
    archived: Boolean(r.archived_at),
  };
}

export async function loadTicketTypes(
  ctx: AppContext,
  eventIds: string[],
  includeArchived = false,
): Promise<Map<string, TicketTypeView[]>> {
  const out = new Map<string, TicketTypeView[]>();
  if (!eventIds.length) return out;
  const { rows } = await ctx.db.query(
    `SELECT * FROM event_ticket_types WHERE event_id = ANY($1::uuid[]) ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY position, created_at, id`,
    [eventIds],
  );
  for (const r of rows) out.set(r.event_id, [...(out.get(r.event_id) ?? []), ticketTypeView(r)]);
  return out;
}

/** Turn event rows (from `eventSelect`) into API views, batch-loading related entities. */
export async function hydrateEvents(
  ctx: AppContext,
  viewerId: string | null,
  rows: Row[],
  opts: { detail?: boolean } = {},
) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const uniq = (xs: Array<string | null>) => [
    ...new Set(xs.filter((x): x is string => Boolean(x))),
  ];
  const [hosts, biz, comms, places, topics, waits, covers, tickets, cohosts] = await Promise.all([
    loadUserSummaries(ctx, uniq(rows.map((r) => r.host_id))),
    ctx.db.query<{ id: string; slug: string; name: string; verified_at: Date | null }>(
      'SELECT id, slug, name, verified_at FROM businesses WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [uniq(rows.map((r) => r.host_business_id))],
    ),
    ctx.db.query<{ id: string; slug: string; name: string }>(
      'SELECT id, slug, name FROM communities WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [uniq(rows.map((r) => r.community_id))],
    ),
    ctx.db.query<{ id: string; name: string }>(
      'SELECT id, name FROM places WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [uniq(rows.map((r) => r.place_id))],
    ),
    ctx.db.query<{ event_id: string; slug: string }>(
      'SELECT et.event_id, t.slug FROM event_topics et JOIN topics t ON t.id = et.topic_id WHERE et.event_id = ANY($1::uuid[]) ORDER BY t.slug',
      [ids],
    ),
    ctx.db.query<{ event_id: string; n: number }>(
      `SELECT event_id, count(*)::int AS n FROM event_attendees WHERE event_id = ANY($1::uuid[]) AND status = 'waitlist' GROUP BY event_id`,
      [ids],
    ),
    ctx.db.query<{ id: string; storage_key: string }>(
      'SELECT id, storage_key FROM media WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [uniq(rows.map((r) => r.cover_media_id))],
    ),
    opts.detail ? loadTicketTypes(ctx, ids) : Promise.resolve(new Map<string, TicketTypeView[]>()),
    opts.detail
      ? ctx.db.query<{ event_id: string; user_id: string }>(
          'SELECT event_id, user_id FROM event_organizers WHERE event_id = ANY($1::uuid[]) ORDER BY created_at',
          [ids],
        )
      : Promise.resolve({ rows: [] as Array<{ event_id: string; user_id: string }> }),
  ]);
  const bizBy = new Map(biz.rows.map((b) => [b.id, b]));
  const commBy = new Map(comms.rows.map((c) => [c.id, c]));
  const placeBy = new Map(places.rows.map((p) => [p.id, p]));
  const waitBy = new Map(waits.rows.map((w) => [w.event_id, w.n]));
  const coverBy = new Map(covers.rows.map((c) => [c.id, mediaUrl(ctx.config, c.storage_key)]));
  const topicsBy = new Map<string, string[]>();
  for (const t of topics.rows)
    topicsBy.set(t.event_id, [...(topicsBy.get(t.event_id) ?? []), t.slug]);
  const coUsers = await loadUserSummaries(ctx, uniq(cohosts.rows.map((c) => c.user_id)));
  const coBy = new Map<string, UserSummary[]>();
  for (const c of cohosts.rows) {
    const u = coUsers.get(c.user_id);
    if (u) coBy.set(c.event_id, [...(coBy.get(c.event_id) ?? []), u]);
  }

  return rows.map((r) => {
    const goesOnline = r.is_organiser || r.my_status === 'going' || r.my_status === 'attended';
    const b = r.host_business_id ? bizBy.get(r.host_business_id) : undefined;
    const c = r.community_id ? commBy.get(r.community_id) : undefined;
    const p = r.place_id ? placeBy.get(r.place_id) : undefined;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      visibility: r.visibility,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at?.toISOString() ?? null,
      timezone: r.timezone,
      locationText: r.location_text,
      latitude: r.latitude,
      longitude: r.longitude,
      hasOnlineUrl: Boolean(r.online_url),
      onlineUrl: goesOnline ? r.online_url : null,
      place: p ? { id: p.id, name: p.name } : null,
      host: r.host_id ? (hosts.get(r.host_id) ?? null) : null,
      hostBusiness: b
        ? { id: b.id, slug: b.slug, name: b.name, verified: Boolean(b.verified_at) }
        : null,
      community: c ? { id: c.id, slug: c.slug, name: c.name } : null,
      coHosts: opts.detail ? (coBy.get(r.id) ?? []) : undefined,
      capacity: r.capacity,
      counts: {
        going: r.going_count,
        interested: r.interested_count,
        waitlist: waitBy.get(r.id) ?? 0,
        spotsLeft: r.capacity === null ? null : Math.max(0, r.capacity - r.going_count),
      },
      waitlistEnabled: r.waitlist_enabled,
      rules: r.rules,
      coverUrl: r.cover_media_id ? (coverBy.get(r.cover_media_id) ?? null) : r.cover_url,
      topics: topicsBy.get(r.id) ?? [],
      ticketTypes: opts.detail ? (tickets.get(r.id) ?? []) : undefined,
      publishedAt: r.published_at?.toISOString() ?? null,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      cancelReason: r.cancel_reason,
      completedAt: r.completed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      ...(r.distance_km !== undefined ? { distanceKm: Math.round(r.distance_km * 100) / 100 } : {}),
      viewer: {
        rsvp: r.my_status === 'cancelled' ? 'not_going' : r.my_status,
        saved: r.saved,
        invited: r.invited,
        isOrganiser: r.is_organiser,
        isManager: r.is_manager,
      },
    };
  });
}
