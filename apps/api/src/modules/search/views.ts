import { haversineKm, type SearchType } from '@yapilapi/search';
import type { AppContext } from '../../lib/context.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import { topicsFor } from '../communities/service.js';
import { friendsSql, searchGuard } from './guards.js';
import type { DbRow } from '../../lib/db-row.js';

/**
 * Turns ids into API views. Every hydration query re-applies the authorisation guard, so ids coming from ANY search
 * backend (Postgres or an external index) are re-validated against the source of truth before they leave the API.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

type Row = DbRow;
export type ResultItem = Record<string, unknown> & { id: string };

const V = '$1::uuid';
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const clip = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? '');
const dist = (from: GeoPoint | undefined, lat: unknown, lng: unknown) =>
  from && typeof lat === 'number' && typeof lng === 'number'
    ? Math.round(haversineKm(from.lat, from.lng, lat, lng) * 10) / 10
    : undefined;

export function personItem(r: Row) {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: r.display_name as string,
    avatarUrl: (r.avatar_url ?? null) as string | null,
    bio: clip(r.bio, 200),
    mode: r.mode as string,
    isPrivate: Boolean(r.is_private),
    followerCount: Number(r.follower_count ?? 0),
    viewer: { following: (r.following ?? 'none') as string, friend: Boolean(r.is_friend) },
  };
}

export const PERSON_SELECT = `pr.user_id AS id, pr.username::text AS username, pr.display_name, pr.avatar_url, pr.bio, pr.mode, pr.is_private, pr.follower_count,
  (SELECT fw.status FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = pr.user_id) AS following,
  (${V} IS NOT NULL AND ${friendsSql(V, 'pr.user_id')}) AS is_friend`;

/** Batch-hydrate ids of one type for a viewer. Ids the viewer may not see are silently absent from the result. */
export async function hydrate(
  ctx: AppContext,
  viewerId: string | null,
  type: SearchType,
  ids: string[],
  geo?: GeoPoint,
): Promise<Map<string, ResultItem>> {
  const out = new Map<string, ResultItem>();
  if (!ids.length) return out;
  const set = (id: string, item: Record<string, unknown>) =>
    out.set(id, { type, ...item, id } as ResultItem);

  switch (type) {
    case 'people':
    case 'creators': {
      const { rows } = await ctx.db.query(
        `SELECT ${PERSON_SELECT} FROM profiles pr WHERE pr.user_id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'pr')}`,
        [viewerId, ids],
      );
      for (const r of rows) set(r.id, personItem(r));
      break;
    }
    case 'posts':
    case 'videos': {
      const { rows } = await ctx.db.query(
        `SELECT ${postSelect(V)} FROM ${postFrom} WHERE p.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'p')}`,
        [viewerId, ids],
      );
      for (const v of await hydratePosts(ctx, viewerId, rows)) {
        const r = rows.find((x) => x.id === v.id)!;
        set(v.id, { ...v, ...(geo ? { distanceKm: dist(geo, r.latitude, r.longitude) } : {}) });
      }
      break;
    }
    case 'communities': {
      const { rows } = await ctx.db.query(
        `SELECT c.id, c.slug::text AS slug, c.name, c.description, c.visibility, c.join_policy, c.member_count, c.language, c.is_paid, c.price_cents, c.currency, c.created_at,
                m.status AS my_status
           FROM communities c LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = ${V}
          WHERE c.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'c')}`,
        [viewerId, ids],
      );
      const topics = await topicsFor(
        ctx.db,
        rows.map((r) => r.id),
      );
      for (const r of rows) {
        const active = r.my_status === 'active';
        set(r.id, {
          slug: r.slug,
          name: r.name,
          description: clip(r.description, 300),
          visibility: r.visibility,
          joinPolicy: r.join_policy,
          memberCount: r.member_count,
          language: r.language,
          topics: topics.get(r.id) ?? [],
          isPaid: r.is_paid,
          priceCents: r.price_cents,
          currency: r.currency,
          // Private communities are shown as a summary to non-members; content and roster are not part of search results.
          access: r.visibility === 'public' || active ? 'full' : 'summary',
          viewer: r.my_status ? { status: r.my_status } : null,
          createdAt: iso(r.created_at),
        });
      }
      break;
    }
    case 'events': {
      const { rows } = await ctx.db.query(
        `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.timezone, e.location_text, e.place_id, e.community_id, e.visibility, e.going_count, e.interested_count,
                e.cover_url, e.host_id, COALESCE(e.latitude, pl.latitude) AS lat, COALESCE(e.longitude, pl.longitude) AS lng, hp.username::text AS host_username, hp.display_name AS host_name,
                (e.online_url IS NOT NULL) AS is_online
           FROM events e LEFT JOIN places pl ON pl.id = e.place_id LEFT JOIN profiles hp ON hp.user_id = e.host_id
          WHERE e.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'e')}`,
        [viewerId, ids],
      );
      for (const r of rows) {
        set(r.id, {
          title: r.title,
          description: clip(r.description, 280),
          startsAt: iso(r.starts_at),
          endsAt: iso(r.ends_at),
          timezone: r.timezone,
          locationText: r.location_text,
          location:
            r.lat !== null && r.lat !== undefined ? { latitude: r.lat, longitude: r.lng } : null,
          placeId: r.place_id,
          communityId: r.community_id,
          visibility: r.visibility,
          goingCount: r.going_count,
          interestedCount: r.interested_count,
          coverUrl: r.cover_url,
          isOnline: r.is_online,
          host: r.host_id
            ? { id: r.host_id, username: r.host_username, displayName: r.host_name }
            : null,
          distanceKm: dist(geo, r.lat, r.lng),
        });
      }
      break;
    }
    case 'places': {
      const { rows } = await ctx.db.query(
        `SELECT pl.id, pl.name, pl.kind, pl.description, pl.latitude, pl.longitude, pl.address, pl.capacity, pl.rating_avg, pl.rating_count, pl.business_id
           FROM places pl WHERE pl.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'pl')}`,
        [viewerId, ids],
      );
      for (const r of rows) {
        set(r.id, {
          name: r.name,
          kind: r.kind,
          description: clip(r.description, 280),
          location: { latitude: r.latitude, longitude: r.longitude },
          address: r.address,
          capacity: r.capacity,
          ratingAvg: Number(r.rating_avg),
          ratingCount: r.rating_count,
          businessId: r.business_id,
          distanceKm: dist(geo, r.latitude, r.longitude),
        });
      }
      break;
    }
    case 'businesses': {
      const { rows } = await ctx.db.query(
        `SELECT b.id, b.slug::text AS slug, b.name, b.category, b.description, b.logo_url, (b.verified_at IS NOT NULL) AS verified
           FROM businesses b WHERE b.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'b')}`,
        [viewerId, ids],
      );
      for (const r of rows)
        set(r.id, {
          slug: r.slug,
          name: r.name,
          category: r.category,
          description: clip(r.description, 280),
          logoUrl: r.logo_url,
          verified: r.verified,
        });
      break;
    }
    case 'products': {
      const { rows } = await ctx.db.query(
        `SELECT pd.id, pd.title, pd.description, pd.kind, pd.price_cents, pd.currency, pd.stock, pd.rating_avg, pd.rating_count, pd.business_id, pd.seller_user_id,
                b.name AS business_name, b.slug::text AS business_slug, sp.username::text AS seller_username, sp.display_name AS seller_name
           FROM products pd LEFT JOIN businesses b ON b.id = pd.business_id LEFT JOIN profiles sp ON sp.user_id = pd.seller_user_id
          WHERE pd.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'pd')}`,
        [viewerId, ids],
      );
      for (const r of rows) {
        set(r.id, {
          title: r.title,
          description: clip(r.description, 280),
          kind: r.kind,
          priceCents: r.price_cents,
          currency: r.currency,
          inStock: r.stock === null || r.stock > 0,
          ratingAvg: Number(r.rating_avg),
          ratingCount: r.rating_count,
          seller: r.business_id
            ? { type: 'business', id: r.business_id, name: r.business_name, slug: r.business_slug }
            : {
                type: 'user',
                id: r.seller_user_id,
                name: r.seller_name,
                username: r.seller_username,
              },
        });
      }
      break;
    }
    case 'topics': {
      const { rows } = await ctx.db.query(
        `SELECT tp.id, tp.slug::text AS slug, tp.name FROM topics tp WHERE tp.id = ANY($2::uuid[]) AND ${searchGuard(type, V, 'tp')}`,
        [viewerId, ids],
      );
      for (const r of rows) set(r.id, { slug: r.slug, name: r.name });
      break;
    }
  }
  return out;
}

/** Order hydrated items by candidate order, dropping candidates that did not survive the guard. */
export function ordered<T extends { id: string }>(
  cands: T[],
  items: Map<string, ResultItem>,
): Array<T & { item: ResultItem }> {
  const out: Array<T & { item: ResultItem }> = [];
  for (const c of cands) {
    const item = items.get(c.id);
    if (item) out.push({ ...c, item });
  }
  return out;
}

/** Compact label for typeahead rows. */
export function suggestionLabel(
  type: SearchType,
  item: ResultItem,
): { label: string; sublabel: string | null; ref: Record<string, unknown> } {
  const i = item as DbRow;
  switch (type) {
    case 'people':
    case 'creators':
      return {
        label: i.displayName,
        sublabel: `@${i.username}`,
        ref: { username: i.username, avatarUrl: i.avatarUrl },
      };
    case 'communities':
      return { label: i.name, sublabel: `${i.memberCount} members`, ref: { slug: i.slug } };
    case 'events':
      return { label: i.title, sublabel: i.startsAt, ref: {} };
    case 'places':
      return { label: i.name, sublabel: i.kind, ref: {} };
    case 'businesses':
      return { label: i.name, sublabel: i.category, ref: { slug: i.slug } };
    case 'products':
      return { label: i.title, sublabel: null, ref: {} };
    case 'topics':
      return { label: i.name, sublabel: `#${i.slug}`, ref: { slug: i.slug } };
    default:
      return { label: String(i.body ?? '').slice(0, 60), sublabel: null, ref: {} };
  }
}
