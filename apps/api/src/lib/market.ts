import type { Pool, PoolClient } from 'pg';
import {
  MARKET_REMINDER_DAYS,
  MARKET_RENEW_WITHIN_DAYS,
  MARKET_RESPONSE_RATE_MIN_CHATS,
  marketDaysLeft,
  marketDistanceKm,
  type MarketChatCard,
  type MarketContactBlock,
  type MarketListing,
  type MarketListingCard,
  type MarketOffer,
  type MarketPhoto,
  type MarketRating,
  type MarketSellerCard,
} from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { ageOf, plusCol, publicUserFrom, usersByIds } from './users.ts';
import { notBlockedSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Market (modules/market.ts): who sees which listing, how listings, chat cards and offers look to
 * one person, the seller card, and the daily housekeeping (reminders before a listing ends, and a
 * note when it has). A listing's place never leaves this file: SQL works out distances, and only
 * whole kilometres are returned.
 */

export interface MarketDeps {
  db: Pool;
  realtime: RealtimeHub;
}

/** Listings aliased `l`, the seller's profile `sp` and user `su`. */
export const LISTING_FROM = `FROM market_listings l JOIN profiles sp ON sp.user_id = l.seller_id JOIN users su ON su.id = l.seller_id`;

/**
 * Listings viewer `v` may open: their own (whatever state), and otherwise ones not deleted, from an
 * active account, not waiting for review or taken down, with no block either way between the two,
 * and either still listed (not sold, not past their time) or ones the viewer is part of (they wrote
 * to the seller about it, or it's reserved for or sold to them).
 */
export function listingVisibleSql(v: string): string {
  return `(l.deleted_at IS NULL AND su.status = 'active' AND (
    l.seller_id = ${v}
    OR (l.moderation_status = 'normal' AND ${notBlockedSql('l.seller_id', v)} AND (
      (l.status <> 'sold' AND l.expires_at > now())
      OR l.reserved_for = ${v} OR l.sold_to = ${v}
      OR EXISTS (SELECT 1 FROM market_chats mcv WHERE mcv.listing_id = l.id AND mcv.buyer_id = ${v})))))`;
}

/** Listings shown when browsing: listed, not sold, not ended, nothing held, no blocks. */
export function listingListedSql(v: string): string {
  return `(l.deleted_at IS NULL AND su.status = 'active' AND l.moderation_status = 'normal' AND l.status <> 'sold' AND l.expires_at > now()
    AND ${notBlockedSql('l.seller_id', v)})`;
}

/** Kilometres from the point ($lat, $lng) to the listing's point (NULL without one). */
export function distanceKmSql(lat: string, lng: string): string {
  return `(2 * 6371 * asin(least(1, sqrt(power(sin(radians(l.approx_lat - ${lat}) / 2), 2)
            + cos(radians(${lat})) * cos(radians(l.approx_lat)) * power(sin(radians(l.approx_lng - ${lng}) / 2), 2)))))`;
}

export const LISTING_COLS = `l.id, l.seller_id, l.title, l.description, l.category, l.condition, l.price_cents, l.currency, l.area,
  (l.approx_lat IS NOT NULL) AS has_place, l.delivery, l.status, l.reserved_for, l.sold_to, l.expires_at, (l.expires_at <= now()) AS expired,
  l.created_at, l.updated_at, l.moderation_status, l.review_reason,
  sp.user_id AS s_id, sp.username AS s_username, sp.display_name AS s_display_name, sp.avatar_url AS s_avatar_url, sp.mode AS s_mode, ${plusCol('s_', 'sp')}`;

export type ListingRow = Record<string, any> & { id: string; seller_id: string; distance_km?: number | null };

const photoUrl = `coalesce(m.variants->>'medium', m.url)`;
const thumbUrl = `coalesce(m.variants->>'thumb', m.variants->>'medium', m.url)`;

/**
 * Photos of these listings, in order, as `viewer` gets them: photos taken down are never shown, and
 * photos that may be sensitive only to the seller (a listing with one waits for review anyway).
 */
export async function listingPhotos(db: Q, ids: string[], viewer: string | null): Promise<Map<string, MarketPhoto[]>> {
  const out = new Map<string, MarketPhoto[]>();
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT p.listing_id, p.media_id, p.alt_text, ${photoUrl} AS url, ${thumbUrl} AS thumb, m.width, m.height, m.moderation, m.owner_id
     FROM market_listing_photos p JOIN media m ON m.id = p.media_id
     WHERE p.listing_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.moderation <> 'blocked'
     ORDER BY p.listing_id, p.position`,
    [ids],
  );
  for (const r of rows) {
    if (r.moderation === 'sensitive' && r.owner_id !== viewer) continue;
    const list = out.get(r.listing_id) ?? [];
    list.push({ mediaId: r.media_id, url: r.url, thumbUrl: r.thumb, width: r.width ?? null, height: r.height ?? null, altText: r.alt_text ?? null });
    out.set(r.listing_id, list);
  }
  return out;
}

/** Whether `a` and `b` are friends, or a teen and a guardian the teen accepted through a family link. */
export async function trustedPair(db: Q, a: string, b: string): Promise<boolean> {
  const [x, y] = [a, b].sort();
  const { rowCount } = await db.query(
    `SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2
     UNION ALL SELECT 1 FROM family_links WHERE status = 'active' AND ((guardian_id = $1 AND teen_id = $2) OR (guardian_id = $2 AND teen_id = $1))`,
    [x, y],
  );
  return !!rowCount;
}

/** Whether someone is under 18 (unknown ages count as adults here, as for messages). */
export async function isMinor(db: Q, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ birth_date: Date | null }>(`SELECT birth_date FROM users WHERE id = $1`, [userId]);
  return (ageOf(rows[0]?.birth_date ?? null) ?? 18) < 18;
}

/** Why `viewer` can't write to the seller about this listing, or null when they can (the rest is checked when they do). */
async function contactBlock(
  db: Q,
  r: ListingRow,
  viewer: string | null,
  viewerMinor: boolean,
  trusted: Map<string, boolean>,
): Promise<MarketContactBlock | null> {
  if (!viewer) return 'unavailable';
  if (r.seller_id === viewer) return 'self';
  const partOfIt = r.reserved_for === viewer || r.sold_to === viewer;
  if (r.moderation_status !== 'normal' || (!partOfIt && (r.status === 'sold' || r.expired))) return 'unavailable';
  if (viewerMinor) {
    if (!trusted.has(r.seller_id)) trusted.set(r.seller_id, await trustedPair(db, viewer, r.seller_id));
    if (!trusted.get(r.seller_id)) return 'minor_protection';
  }
  return null;
}

/** Listings as `viewer` sees them. Rows come from LISTING_COLS (plus `distance_km` when a place was given). */
export async function presentListings(db: Q, rows: ListingRow[], viewer: string | null): Promise<MarketListing[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const photos = await listingPhotos(db, ids, viewer);
  const saved = viewer
    ? new Set(
        (
          await db.query<{ listing_id: string }>(`SELECT listing_id FROM market_saves WHERE user_id = $1 AND listing_id = ANY($2::uuid[])`, [viewer, ids])
        ).rows.map((r) => r.listing_id),
      )
    : new Set<string>();
  const viewerMinor = viewer ? await isMinor(db, viewer) : false;
  const trusted = new Map<string, boolean>();
  const out: MarketListing[] = [];
  for (const r of rows) {
    const mine = r.seller_id === viewer;
    const block = await contactBlock(db, r, viewer, viewerMinor, trusted);
    const expiresAt: Date = r.expires_at;
    const listing: MarketListing = {
      id: r.id,
      seller: publicUserFrom(r, 's_'),
      title: r.title,
      description: r.description,
      category: r.category,
      condition: r.condition,
      priceCents: r.price_cents === null || r.price_cents === undefined ? null : Number(r.price_cents),
      currency: r.currency.trim(),
      photos: photos.get(r.id) ?? [],
      where: { area: r.area, distanceKm: r.distance_km === null || r.distance_km === undefined ? null : marketDistanceKm(Number(r.distance_km) * 1000) },
      hasPlace: !!r.has_place,
      delivery: r.delivery,
      status: r.status,
      expiresAt: expiresAt.toISOString(),
      expired: !!r.expired && r.status !== 'sold',
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      mine,
      saved: saved.has(r.id),
      canContact: !block,
      ...(block ? { contactBlock: block } : {}),
    };
    if (mine) {
      listing.canRenew = r.status !== 'sold' && r.moderation_status !== 'removed' && marketDaysLeft(listing.expiresAt) <= MARKET_RENEW_WITHIN_DAYS;
      if (r.moderation_status === 'review' || r.moderation_status === 'restricted') listing.moderation = r.moderation_status;
      if (r.moderation_status === 'review' && r.review_reason) listing.reviewReason = r.review_reason;
    }
    if (viewer && !mine && (r.reserved_for === viewer || r.sold_to === viewer)) listing.forYou = true;
    out.push(listing);
  }
  return out;
}

/** One listing's row as `viewer` may see it, with the distance from `near` when given. */
export async function listingRow(db: Q, id: string, viewer: string, near?: { lat: number; lng: number }): Promise<ListingRow | null> {
  const { rows } = await db.query(
    `SELECT ${LISTING_COLS}${near ? `, CASE WHEN l.approx_lat IS NOT NULL THEN ${distanceKmSql('$3', '$4')} END AS distance_km` : ''}
     ${LISTING_FROM} WHERE l.id = $2 AND ${listingVisibleSql('$1')}`,
    near ? [viewer, id, near.lat, near.lng] : [viewer, id],
  );
  return rows[0] ?? null;
}

// ── Sellers ─────────────────────────────────────────────────────────────

/** Average stars and how many, from the ratings people left for `userId` in one role (as seller: from buyers). */
export async function ratingSummaries(db: Q, ids: string[], raterRole: 'buyer' | 'seller'): Promise<Map<string, { average: number | null; count: number }>> {
  const { rows } = await db.query<{ ratee_id: string; average: string | null; count: number }>(
    `SELECT ratee_id, round(avg(stars)::numeric, 1)::text AS average, count(*)::int AS count FROM market_ratings
     WHERE ratee_id = ANY($1::uuid[]) AND rater_role = $2 AND moderation_status = 'normal' AND deleted_at IS NULL GROUP BY ratee_id`,
    [ids, raterRole],
  );
  const out = new Map(ids.map((id) => [id, { average: null as number | null, count: 0 }]));
  for (const r of rows) out.set(r.ratee_id, { average: r.average === null ? null : Number(r.average), count: r.count });
  return out;
}

/** What buyers see about sellers: since when they're on YAPILAPI, their rating as a seller, how often they answer and how many things they sold. */
export async function sellerCards(db: Q, ids: string[]): Promise<Map<string, MarketSellerCard>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, MarketSellerCard>();
  if (!unique.length) return out;
  const users = await usersByIds(db, unique);
  const ratings = await ratingSummaries(db, unique, 'buyer');
  const { rows } = await db.query<{ id: string; created_at: Date; sold: number; chats: number; answered: number }>(
    `SELECT u.id, u.created_at,
       (SELECT count(*) FROM market_listings sl WHERE sl.seller_id = u.id AND sl.status = 'sold' AND sl.deleted_at IS NULL)::int AS sold,
       (SELECT count(*) FROM market_chats mc JOIN market_listings ml ON ml.id = mc.listing_id
        WHERE ml.seller_id = u.id AND mc.created_at > now() - interval '180 days')::int AS chats,
       (SELECT count(*) FROM market_chats mc JOIN market_listings ml ON ml.id = mc.listing_id
        WHERE ml.seller_id = u.id AND mc.created_at > now() - interval '180 days'
          AND EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = mc.conversation_id AND x.sender_id = u.id AND x.created_at >= mc.created_at)
       )::int AS answered
     FROM users u WHERE u.id = ANY($1::uuid[])`,
    [unique],
  );
  for (const r of rows) {
    const user = users.get(r.id);
    if (!user) continue;
    out.set(r.id, {
      user,
      memberSince: r.created_at.toISOString(),
      rating: ratings.get(r.id)!,
      responseRate: r.chats >= MARKET_RESPONSE_RATE_MIN_CHATS ? Math.round((100 * r.answered) / r.chats) : null,
      sold: r.sold,
    });
  }
  return out;
}

/** The ratings `viewer` may read about `userId` (none from people either of them blocked), newest first. */
export async function ratingsAbout(
  db: Q,
  userId: string,
  viewer: string,
  o: { limit: number; before?: { t: string; id: string } | null },
): Promise<(MarketRating & { _at: Date })[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.listing_id, r.listing_title, r.rater_role, r.stars, r.body, r.created_at,
            pr.user_id AS r_id, pr.username AS r_username, pr.display_name AS r_display_name, pr.avatar_url AS r_avatar_url, pr.mode AS r_mode, ${plusCol('r_')}
     FROM market_ratings r JOIN profiles pr ON pr.user_id = r.rater_id JOIN users ru ON ru.id = r.rater_id
     WHERE r.ratee_id = $1 AND r.deleted_at IS NULL AND ru.status = 'active'
       AND (r.moderation_status = 'normal' OR (r.moderation_status = 'review' AND r.rater_id = $2))
       AND ${notBlockedSql('r.rater_id', '$2')}
       ${o.before ? 'AND (r.created_at, r.id) < ($4::timestamptz, $5::uuid)' : ''}
     ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
    o.before ? [userId, viewer, o.limit, o.before.t, o.before.id] : [userId, viewer, o.limit],
  );
  return rows.map((r) => ({
    id: r.id,
    listingId: r.listing_id,
    listingTitle: r.listing_title,
    rater: publicUserFrom(r, 'r_'),
    raterRole: r.rater_role,
    stars: r.stars,
    body: r.body,
    createdAt: r.created_at.toISOString(),
    _at: r.created_at,
  }));
}

/**
 * The Market tab shows on a profile while the person has something listed that the viewer may see,
 * or ratings from Market.
 */
export async function hasMarketTab(db: Q, owner: string, viewer: string | null): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 ${LISTING_FROM} WHERE l.seller_id = $2 AND (l.seller_id = $1 OR ${listingListedSql('$1')}))
         OR EXISTS (SELECT 1 FROM market_ratings r WHERE r.ratee_id = $2 AND r.moderation_status = 'normal' AND r.deleted_at IS NULL) AS shown`,
    [viewer, owner],
  );
  return !!rows[0]?.shown;
}

// ── Chat cards ──────────────────────────────────────────────────────────

/** Listings as small cards for `reader` (in a chat, or on an offer). Unavailable ones say so. */
export async function listingCards(db: Q, ids: string[], reader: string): Promise<Map<string, MarketListingCard>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, MarketListingCard>();
  if (!unique.length) return out;
  const { rows } = await db.query(
    `SELECT l.id, l.seller_id, l.title, l.price_cents, l.currency, l.status, (l.expires_at <= now()) AS expired,
            (l.deleted_at IS NULL AND su.status = 'active' AND (l.seller_id = $2 OR (l.moderation_status = 'normal' AND ${notBlockedSql('l.seller_id', '$2')}))) AS available,
            (SELECT coalesce(m.variants->>'thumb', m.variants->>'medium', m.url) FROM market_listing_photos p JOIN media m ON m.id = p.media_id
             WHERE p.listing_id = l.id AND m.deleted_at IS NULL AND m.moderation NOT IN ('blocked', 'sensitive') ORDER BY p.position LIMIT 1) AS photo
     ${LISTING_FROM} WHERE l.id = ANY($1::uuid[])`,
    [unique, reader],
  );
  for (const id of unique)
    out.set(id, { id, available: false, title: '', priceCents: null, currency: 'USD', photoUrl: null, status: 'available', expired: false, sellerId: '' });
  for (const r of rows)
    out.set(
      r.id,
      r.available
        ? {
            id: r.id,
            available: true,
            title: r.title,
            priceCents: r.price_cents === null ? null : Number(r.price_cents),
            currency: r.currency.trim(),
            photoUrl: r.photo ?? null,
            status: r.status,
            expired: !!r.expired && r.status !== 'sold',
            sellerId: r.seller_id,
          }
        : {
            id: r.id,
            available: false,
            title: '',
            priceCents: null,
            currency: r.currency.trim(),
            photoUrl: null,
            status: r.status,
            expired: false,
            sellerId: r.seller_id,
          },
    );
  return out;
}

/** The listing cards at the top of chats, for these messages, as `reader` sees them. */
export async function marketCardsFor(db: Q, messageIds: string[], reader: string): Promise<Map<string, MarketChatCard>> {
  const out = new Map<string, MarketChatCard>();
  if (!messageIds.length) return out;
  const { rows } = await db.query(
    `SELECT mc.message_id, mc.listing_id, mc.buyer_id, l.seller_id, l.status, l.reserved_for, l.sold_to, l.deleted_at, l.moderation_status,
            EXISTS (SELECT 1 FROM market_ratings r WHERE r.listing_id = l.id AND r.rater_id = $2) AS rated
     FROM market_chats mc JOIN market_listings l ON l.id = mc.listing_id WHERE mc.message_id = ANY($1::uuid[])`,
    [messageIds, reader],
  );
  if (!rows.length) return out;
  const cards = await listingCards(
    db,
    rows.map((r) => r.listing_id),
    reader,
  );
  const users = await usersByIds(db, [...new Set(rows.flatMap((r) => [r.buyer_id, r.seller_id]))]);
  for (const r of rows) {
    const you = reader === r.seller_id ? 'seller' : reader === r.buyer_id ? 'buyer' : null;
    const buyer = users.get(r.buyer_id);
    const seller = users.get(r.seller_id);
    if (!you || !buyer || !seller) continue;
    const live = !r.deleted_at && r.moderation_status !== 'removed';
    const soldToBuyer = r.status === 'sold' && r.sold_to === r.buyer_id;
    out.set(r.message_id, {
      listing: cards.get(r.listing_id)!,
      buyer,
      seller,
      you,
      canMarkSold: you === 'seller' && live && !soldToBuyer,
      canMarkReserved: you === 'seller' && live && r.status === 'available',
      reservedForBuyer: r.status === 'reserved' && r.reserved_for === r.buyer_id,
      soldToBuyer,
      canRate: soldToBuyer && !r.rated,
      rated: !!r.rated,
    });
  }
  return out;
}

export const OFFER_COLS = `o.id, o.listing_id, o.conversation_id, o.message_id, o.buyer_id, o.seller_id, o.made_by, o.amount_cents, o.currency, o.status,
  o.counter_of, o.created_at, o.responded_at`;

/** Offers as `reader` sees them (who may answer or withdraw each). */
export async function presentOffers(db: Q, rows: Record<string, any>[], reader: string): Promise<MarketOffer[]> {
  if (!rows.length) return [];
  const users = await usersByIds(db, [...new Set(rows.flatMap((r) => [r.buyer_id, r.seller_id]))]);
  const cards = await listingCards(
    db,
    rows.map((r) => r.listing_id),
    reader,
  );
  return rows
    .filter((r) => users.has(r.buyer_id) && users.has(r.seller_id))
    .map((r) => {
      const maker = r.made_by === 'buyer' ? r.buyer_id : r.seller_id;
      const other = r.made_by === 'buyer' ? r.seller_id : r.buyer_id;
      const pending = r.status === 'pending';
      return {
        id: r.id,
        listingId: r.listing_id,
        conversationId: r.conversation_id,
        messageId: r.message_id,
        buyer: users.get(r.buyer_id)!,
        seller: users.get(r.seller_id)!,
        madeBy: r.made_by,
        amountCents: Number(r.amount_cents),
        currency: r.currency.trim(),
        status: r.status,
        counterOfId: r.counter_of ?? null,
        createdAt: r.created_at.toISOString(),
        respondedAt: r.responded_at?.toISOString() ?? null,
        canRespond: pending && reader === other,
        canWithdraw: pending && reader === maker,
        listing: cards.get(r.listing_id)!,
      };
    });
}

/** The offer cards among these messages, as `reader` sees them. */
export async function offersFor(db: Q, messageIds: string[], reader: string): Promise<Map<string, MarketOffer>> {
  if (!messageIds.length) return new Map();
  const { rows } = await db.query(`SELECT ${OFFER_COLS} FROM market_offers o WHERE o.message_id = ANY($1::uuid[])`, [messageIds]);
  const offers = await presentOffers(db, rows, reader);
  return new Map(offers.map((o) => [o.messageId, o]));
}

/** The people in a chat who get its card changes live: its current members (the buyer and the seller). */
async function readersOf(db: Q, conversationId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [
    conversationId,
  ]);
  return rows.map((r) => r.user_id);
}

/** Tell the two people in a chat that an offer changed: each gets the card as they see it. */
export async function publishOffer(deps: MarketDeps, offerId: string): Promise<void> {
  const { rows } = await deps.db.query(`SELECT ${OFFER_COLS} FROM market_offers o WHERE o.id = $1`, [offerId]);
  const row = rows[0];
  if (!row?.message_id) return;
  for (const reader of await readersOf(deps.db, row.conversation_id)) {
    const [offer] = await presentOffers(deps.db, [row], reader);
    if (offer)
      await deps.realtime.publish([reader], { type: 'market.updated', data: { conversationId: row.conversation_id, messageId: row.message_id, offer } });
  }
}

/** Tell everyone in the chats about a listing that its card changed (reserved, sold, rated, gone). */
export async function publishListingCards(deps: MarketDeps, listingId: string): Promise<void> {
  const { rows } = await deps.db.query<{ message_id: string; conversation_id: string }>(
    `SELECT message_id, conversation_id FROM market_chats WHERE listing_id = $1 AND message_id IS NOT NULL`,
    [listingId],
  );
  for (const chat of rows)
    for (const reader of await readersOf(deps.db, chat.conversation_id)) {
      const card = (await marketCardsFor(deps.db, [chat.message_id], reader)).get(chat.message_id);
      if (card)
        await deps.realtime.publish([reader], {
          type: 'market.updated',
          data: { conversationId: chat.conversation_id, messageId: chat.message_id, market: card },
        });
    }
}

// ── Reminders and ends ──────────────────────────────────────────────────

/**
 * Listings about to end get a reminder MARKET_REMINDER_DAYS before (once), and ones that ended a
 * note (once), each as a notification to the seller. Sold, deleted and taken-down listings get
 * neither. A renewed listing can be reminded again. Run by the job worker once a minute; returns
 * how many notes went out.
 */
export async function sweepMarket(deps: MarketDeps, batch = 200): Promise<{ reminded: number; ended: number }> {
  const reminded = await deps.db.query<{ id: string; seller_id: string; title: string; expires_at: Date }>(
    `UPDATE market_listings SET reminded_at = now() WHERE id IN (
       SELECT id FROM market_listings WHERE deleted_at IS NULL AND status <> 'sold' AND moderation_status = 'normal' AND reminded_at IS NULL
         AND expires_at > now() AND expires_at <= now() + make_interval(days => $1)
       ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, seller_id, title, expires_at`,
    [MARKET_REMINDER_DAYS, batch],
  );
  for (const r of reminded.rows)
    await notify(deps.db, deps.realtime, {
      userId: r.seller_id,
      category: 'commerce',
      type: 'market_expiring',
      entityType: 'listing',
      entityId: r.id,
      data: { title: r.title, days: marketDaysLeft(r.expires_at.toISOString()) },
    });
  const ended = await deps.db.query<{ id: string; seller_id: string; title: string }>(
    `UPDATE market_listings SET ended_notified_at = now() WHERE id IN (
       SELECT id FROM market_listings WHERE deleted_at IS NULL AND status <> 'sold' AND moderation_status IN ('normal', 'review') AND ended_notified_at IS NULL
         AND expires_at <= now()
       ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, seller_id, title`,
    [batch],
  );
  for (const r of ended.rows)
    await notify(deps.db, deps.realtime, {
      userId: r.seller_id,
      category: 'commerce',
      type: 'market_expired',
      entityType: 'listing',
      entityId: r.id,
      data: { title: r.title },
    });
  return { reminded: reminded.rowCount ?? 0, ended: ended.rowCount ?? 0 };
}
