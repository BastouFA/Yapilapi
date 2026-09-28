import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import {
  approximatePoint,
  counterOfferSchema,
  createListingSchema,
  currencyForCountry,
  formatMoney,
  listingFingerprintText,
  listingStatusSchema,
  makeOfferSchema,
  MARKET_DEFAULT_RADIUS_KM,
  MARKET_DUPLICATE_LISTINGS,
  MARKET_LISTING_DAYS,
  MARKET_LISTINGS_PER_DAY,
  MARKET_LOW_PRICE_RATIO,
  MARKET_MEDIAN_MIN_LISTINGS,
  MARKET_RENEW_WITHIN_DAYS,
  marketRatingSchema,
  marketSearchSchema,
  prohibitedMatch,
  updateListingSchema,
  type MarketListingDetail,
  type MarketMe,
  type MarketProfile,
  type PublicListingPreview,
} from '@yapilapi/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor, keyCursorOf } from '../lib/cursor.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { activeControls } from '../lib/family.ts';
import { enqueue } from '../lib/jobs.ts';
import {
  distanceKmSql,
  isMinor,
  LISTING_COLS,
  LISTING_FROM,
  listingListedSql,
  listingRow,
  listingVisibleSql,
  OFFER_COLS,
  presentListings,
  presentOffers,
  publishListingCards,
  publishOffer,
  ratingsAbout,
  ratingSummaries,
  sellerCards,
  trustedPair,
  type ListingRow,
} from '../lib/market.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { analyzeText } from '../lib/moderation.ts';
import { notify, track } from '../lib/services.ts';
import { assertMessagePace, isRestricted, restrictedError } from '../lib/spam.ts';
import { ageOf, areFriends, isBlockedEitherWay } from '../lib/users.ts';
import { requireVerified } from '../lib/verification.ts';
import { me, requireAuth, type AuthUser } from '../plugins/auth.ts';
import { excerpt, publicAccountSql } from './public.ts';
import type { ChatHelpers } from './chat-polls-lists.ts';

const idParam = z.object({ id: z.string().uuid() });
const pageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(24) });
const near = z.object({ near: z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }) });

const unavailable = () => new AppError(409, 'listing_unavailable', 'This listing isn’t available any more.');
const MINOR_CONTACT = 'To keep younger people safe, you can write to sellers about listings once you’re friends.';

/** The words of a listing, hashed, to spot the same listing posted again and again. */
const fingerprintOf = (title: string, description: string) => createHash('md5').update(listingFingerprintText(title, description)).digest('hex');

type ReviewReason = 'prohibited' | 'duplicate' | 'low_price' | 'photos' | 'text';

/**
 * Market: people selling and buying used and local things near them, person to person, without
 * paying in the app (packages/shared/src/market.ts has the rules in plain words).
 *
 * - Selling is for adults (like selling in the shop); anyone who can use YAPILAPI can browse.
 * - A listing's place is kept only snapped to about a kilometre (lib/market.ts never returns it):
 *   people get the area text and a distance in whole kilometres. Places travel in request bodies only.
 * - Before a listing is published: words that look like something Market doesn't allow stop it
 *   (422 `prohibited_item`); the seller can say it isn't, and it then waits for a moderator. So do
 *   listings with risky words, photos that may be sensitive, the same words posted many times, or a
 *   price far below similar listings. MARKET_LISTINGS_PER_DAY new listings per person a day.
 * - Listings run MARKET_LISTING_DAYS, with a reminder before they end (lib/market.ts sweepMarket), and
 *   can be renewed. Blocks hide listings both ways. Listings can be reported.
 * - Writing to a seller and offers (registerMarketChats) happen in a one-to-one chat with the usual
 *   rules; after a sale to someone from a chat, both can rate the other once.
 */
export default async function marketModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };

  /** Your currency (from your country) and whether you can sell. */
  async function marketMe(u: AuthUser): Promise<MarketMe> {
    const { rows } = await db.query<{ country: string | null; cdn_country: string | null; today: number }>(
      `SELECT pr.country, pr.cdn_country,
              (SELECT count(*) FROM market_listings l WHERE l.seller_id = pr.user_id AND l.created_at > now() - interval '24 hours')::int AS today
       FROM profiles pr WHERE pr.user_id = $1`,
      [u.id],
    );
    const r = rows[0];
    const age = ageOf(u.birthDate);
    const sellBlock = age === null ? 'birth_date_required' : age < 18 ? 'adults_only' : null;
    return {
      currency: currencyForCountry(r?.country ?? r?.cdn_country),
      canSell: !sellBlock,
      sellBlock,
      listingsLeftToday: Math.max(0, MARKET_LISTINGS_PER_DAY - (r?.today ?? 0)),
    };
  }

  /** Your own listing (any state but deleted), or 404. */
  async function ownListing(c: { query: typeof db.query }, id: string, userId: string, lock = false) {
    const { rows } = await c.query(
      `SELECT l.* FROM market_listings l WHERE l.id = $1 AND l.seller_id = $2 AND l.deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('That listing');
    return rows[0];
  }

  /** The listing as `viewer` sees it, or 404. */
  async function detail(id: string, viewer: string, place?: { lat: number; lng: number }): Promise<MarketListingDetail> {
    const row = await listingRow(db, id, viewer, place ? approximatePoint(place) : undefined);
    if (!row) throw notFound('That listing');
    const [listing] = await presentListings(db, [row], viewer);
    const sellerCard = (await sellerCards(db, [row.seller_id])).get(row.seller_id)!;
    const chat = (
      await db.query<{ conversation_id: string }>(
        `SELECT mc.conversation_id FROM market_chats mc JOIN conversation_members cm ON cm.conversation_id = mc.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL
         WHERE mc.listing_id = $1 AND mc.buyer_id = $2`,
        [id, viewer],
      )
    ).rows[0];
    const out: MarketListingDetail = { ...listing!, sellerCard, conversationId: chat?.conversation_id ?? null };
    if (row.seller_id === viewer) {
      const { rows } = await db.query(
        `SELECT pr.user_id AS id, pr.username, pr.display_name, pr.avatar_url, pr.mode FROM market_chats mc JOIN profiles pr ON pr.user_id = mc.buyer_id
         JOIN users bu ON bu.id = mc.buyer_id WHERE mc.listing_id = $1 AND bu.status = 'active' ORDER BY mc.created_at DESC LIMIT 50`,
        [id],
      );
      out.buyers = rows.map((b) => ({ id: b.id, username: b.username, displayName: b.display_name, avatarUrl: b.avatar_url, mode: b.mode }));
    }
    // After a sale to someone from a chat: the two of them can rate each other.
    if (row.status === 'sold' && row.sold_to && (viewer === row.seller_id || viewer === row.sold_to)) {
      const other = viewer === row.seller_id ? row.sold_to : row.seller_id;
      const rated = !!(await db.query(`SELECT 1 FROM market_ratings WHERE listing_id = $1 AND rater_id = $2`, [id, viewer])).rowCount;
      const otherUser = out.buyers?.find((b) => b.id === other) ?? (other === row.seller_id ? listing!.seller : null);
      out.rating = { canRate: !rated && !(await isBlockedEitherWay(db, viewer, other)), rated, otherUser };
    }
    return out;
  }

  /**
   * The checks before a listing goes up (or changes): prohibited items, risky words, photos, the same
   * words posted many times, and a price far below similar listings. Throws when it can't be listed;
   * otherwise says why it should wait for a moderator (null: it can go up now).
   */
  async function screen(
    c: PoolClient,
    sellerId: string,
    listingId: string | null,
    v: {
      title: string;
      description: string;
      category: string;
      priceCents: number | null;
      currency: string;
      notProhibited?: boolean;
      photos: { moderation: string }[];
    },
  ): Promise<{ reason: ReviewReason; signals: Record<string, unknown> } | null> {
    const analysis = analyzeText(`${v.title}\n${v.description}`);
    if (analysis.risk === 'escalate') throw new AppError(422, 'content_blocked', 'This listing can’t be published because it may put someone at risk.');
    const kind = prohibitedMatch(v.title, v.description);
    if (kind && !v.notProhibited)
      throw new AppError(422, 'prohibited_item', 'This looks like something that can’t be sold on Market. If it isn’t, you can say so and we’ll check it.', {
        kind,
      });
    if (kind) return { reason: 'prohibited', signals: { kind } };
    if (analysis.risk === 'restrict') return { reason: 'text', signals: { signals: analysis.signals } };
    if (v.photos.some((p) => p.moderation === 'sensitive')) return { reason: 'photos', signals: {} };
    // The same words on several listings in a week, by this seller or anyone.
    const text = listingFingerprintText(v.title, v.description);
    if (text.length >= 8) {
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM market_listings WHERE fingerprint = $1 AND created_at > now() - interval '7 days' AND id IS DISTINCT FROM $2`,
        [fingerprintOf(v.title, v.description), listingId],
      );
      if ((rows[0]?.n ?? 0) + 1 >= MARKET_DUPLICATE_LISTINGS) return { reason: 'duplicate', signals: { copies: (rows[0]?.n ?? 0) + 1 } };
    }
    // Far below what similar things sell for here (same category and currency, other sellers, 90 days).
    if (v.priceCents !== null) {
      const { rows } = await c.query<{ median: string | null; n: number }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents)::text AS median, count(*)::int AS n FROM market_listings
         WHERE category = $1 AND currency = $2 AND price_cents IS NOT NULL AND seller_id <> $3 AND deleted_at IS NULL AND moderation_status = 'normal'
           AND created_at > now() - interval '90 days'`,
        [v.category, v.currency, sellerId],
      );
      const median = rows[0]?.median === null || rows[0]?.median === undefined ? null : Number(rows[0].median);
      if (median !== null && (rows[0]?.n ?? 0) >= MARKET_MEDIAN_MIN_LISTINGS && v.priceCents < median * MARKET_LOW_PRICE_RATIO)
        return { reason: 'low_price', signals: { priceCents: v.priceCents, medianCents: Math.round(median) } };
    }
    return null;
  }

  /** A listing that waits for review gets a moderation case (one open case per listing). */
  async function holdForReview(c: PoolClient, listingId: string, sellerId: string, held: { reason: ReviewReason; signals: Record<string, unknown> }) {
    await c.query(`UPDATE market_listings SET moderation_status = 'review', review_reason = $2 WHERE id = $1`, [listingId, held.reason]);
    await c.query(
      `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('listing', $1, $2, 'automated', 'review', $3)
       ON CONFLICT (target_type, target_id) WHERE status = 'open' DO UPDATE SET signals = moderation_cases.signals || EXCLUDED.signals`,
      [listingId, sellerId, { reason: held.reason, ...held.signals }],
    );
  }

  /** Your photos for a listing: your own images, not taken down, in the order given. */
  async function checkPhotos(c: PoolClient, userId: string, photos: { mediaId: string }[]) {
    const ids = photos.map((p) => p.mediaId);
    const { rows } = await c.query<{ id: string; kind: string; moderation: string }>(
      `SELECT id, kind, moderation FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND NOT private AND deleted_at IS NULL AND status <> 'failed'`,
      [ids, userId],
    );
    if (rows.length !== ids.length) throw notFound('That photo');
    if (rows.some((m) => m.kind !== 'image')) throw badRequest('Listings take photos only.');
    if (rows.some((m) => m.moderation === 'blocked')) throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
    return rows;
  }

  async function setPhotos(c: PoolClient, listingId: string, photos: { mediaId: string; altText?: string }[]) {
    await c.query(`DELETE FROM market_listing_photos WHERE listing_id = $1`, [listingId]);
    for (const [i, p] of photos.entries())
      await c.query(`INSERT INTO market_listing_photos (listing_id, media_id, position, alt_text) VALUES ($1,$2,$3,$4)`, [
        listingId,
        p.mediaId,
        i,
        p.altText || null,
      ]);
  }

  const HELD = 'Your listing will show once we’ve had a quick look at it. This usually takes less than a day, and you’ll see it under Your listings meanwhile.';

  app.get('/v1/market/me', { preHandler: requireAuth }, async (req) => ({ market: await marketMe(me(req)) }));

  /**
   * Browse and search. A POST, so where you are never lands in a URL or a request log. With `near`
   * (snapped to about a kilometre here too), listings within the radius that have a place come
   * nearest first; without it, all listings, those in your country first, newest first.
   */
  app.post('/v1/market/search', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const q = parse(marketSearchSchema, req.body);
    const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 5000) throw badRequest('Invalid cursor.');
    const params: unknown[] = [u.id];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [listingListedSql('$1')];
    let distance = 'NULL::float8';
    let order = 'l.created_at DESC, l.id DESC';
    if (q.near) {
      const at = approximatePoint(q.near);
      const radius = q.radiusKm ?? MARKET_DEFAULT_RADIUS_KM;
      const lat = p(at.lat);
      const lng = p(at.lng);
      distance = distanceKmSql(`${lat}::float8`, `${lng}::float8`);
      // A box around you first (uses the index), then the real distance.
      const dLat = radius / 111;
      const dLng = radius / (111 * Math.max(Math.cos((at.lat * Math.PI) / 180), 0.01));
      where.push(`l.approx_lat BETWEEN ${p(at.lat - dLat)} AND ${p(at.lat + dLat)}`);
      if (Math.abs(at.lng) + dLng < 180) where.push(`l.approx_lng BETWEEN ${p(at.lng - dLng)} AND ${p(at.lng + dLng)}`);
      where.push(`${distance} <= ${p(radius + 0.75)}`);
      order = `${distance} ASC, l.created_at DESC, l.id DESC`;
    } else {
      const mine = (await db.query<{ c: string | null }>(`SELECT coalesce(country, cdn_country) AS c FROM profiles WHERE user_id = $1`, [u.id])).rows[0]?.c;
      if (mine) order = `(l.country = ${p(mine)}) DESC, l.created_at DESC, l.id DESC`;
    }
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const t = p(like);
      where.push(`(l.title ILIKE ${t} OR l.description ILIKE ${t} OR l.area ILIKE ${t})`);
    }
    if (q.category) where.push(`l.category = ${p(q.category)}`);
    if (q.conditions?.length) where.push(`l.condition = ANY(${p(q.conditions)}::text[])`);
    if (q.freeOnly) where.push('l.price_cents IS NULL');
    else if (q.minPriceCents !== undefined || q.maxPriceCents !== undefined) {
      // Prices are compared in your own currency only.
      const { currency } = await marketMe(u);
      where.push(`(l.price_cents IS NULL OR l.currency = ${p(currency)})`);
      if (q.minPriceCents) where.push(`coalesce(l.price_cents, 0) >= ${p(q.minPriceCents)}`);
      if (q.maxPriceCents !== undefined) where.push(`coalesce(l.price_cents, 0) <= ${p(q.maxPriceCents)}`);
    }
    const { rows } = await db.query<ListingRow>(
      `SELECT ${LISTING_COLS}, ${distance} AS distance_km ${LISTING_FROM} WHERE ${where.join(' AND ')}
       ORDER BY ${order} LIMIT ${p(q.limit + 1)} OFFSET ${p(offset)}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    return { items: await presentListings(db, page, u.id), nextCursor: rows.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null };
  });

  app.get('/v1/market/listings/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { listing: await detail(id, me(req).id) };
  });

  /** The same, with how far away it is from `near` (sent in the body, never the URL). */
  app.post('/v1/market/listings/:id/view', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(near, req.body);
    return { listing: await detail(id, me(req).id, input.near) };
  });

  app.post('/v1/market/listings', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createListingSchema, req.body);
    const mm = await marketMe(u);
    if (mm.sellBlock === 'birth_date_required')
      throw new AppError(403, 'birth_date_required', 'Add your date of birth to sell on Market. You need to be 18 or older.');
    if (mm.sellBlock) throw new AppError(403, 'adults_only', 'You need to be 18 or older to sell on Market. You can still look around.');
    if (await isRestricted(db, u.id))
      throw new AppError(403, 'account_restricted', 'Your account is limited while our team reviews some recent activity, so you can’t list things for now.');
    const place = input.place ? approximatePoint(input.place) : null;
    const made = await tx(db, async (c) => {
      // Counted under a per-seller lock, so parallel requests can't slip past the daily limit.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('market:' || $1))`, [u.id]);
      const today = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM market_listings WHERE seller_id = $1 AND created_at > now() - interval '24 hours'`, [u.id])
      ).rows[0]!.n;
      if (today >= MARKET_LISTINGS_PER_DAY)
        throw new AppError(429, 'market_daily_limit', `You can list up to ${MARKET_LISTINGS_PER_DAY} things a day. You can list more tomorrow.`);
      const media = await checkPhotos(c, u.id, input.photos);
      const held = await screen(c, u.id, null, { ...input, currency: mm.currency, photos: media });
      const country =
        (await c.query<{ c: string | null }>(`SELECT coalesce(country, cdn_country) AS c FROM profiles WHERE user_id = $1`, [u.id])).rows[0]?.c ?? null;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO market_listings (seller_id, title, description, category, condition, price_cents, currency, area, approx_lat, approx_lng, country, delivery, fingerprint, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(days => $14)) RETURNING id`,
        [
          u.id,
          input.title,
          input.description,
          input.category,
          input.condition,
          input.priceCents,
          mm.currency,
          input.area,
          place?.lat ?? null,
          place?.lng ?? null,
          country,
          input.delivery,
          fingerprintOf(input.title, input.description),
          MARKET_LISTING_DAYS,
        ],
      );
      const id = rows[0]!.id;
      await setPhotos(c, id, input.photos);
      if (held) await holdForReview(c, id, u.id, held);
      // A first listing puts Market on a profile whose tabs were chosen before it existed.
      await c.query(`UPDATE profiles SET tabs = array_append(tabs, 'market') WHERE user_id = $1 AND tabs IS NOT NULL AND NOT ('market' = ANY(tabs))`, [u.id]);
      return { id, held: !!held };
    });
    track(db, u.id, 'market_listing_created', { held: made.held });
    const [listing] = await presentListings(db, [(await listingRow(db, made.id, u.id))!], u.id);
    reply.code(201);
    return { listing, ...(made.held ? { notice: HELD } : {}) };
  });

  app.patch('/v1/market/listings/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(updateListingSchema, req.body);
    const held = await tx(db, async (c) => {
      const cur = await ownListing(c, id, u.id, true);
      if (cur.moderation_status === 'removed') throw forbidden('This listing was taken down, so it can’t be changed.');
      const next = {
        title: input.title ?? cur.title,
        description: input.description ?? cur.description,
        category: input.category ?? cur.category,
        priceCents: input.priceCents === undefined ? (cur.price_cents === null ? null : Number(cur.price_cents)) : input.priceCents,
      };
      let media: { moderation: string }[];
      if (input.photos) media = await checkPhotos(c, u.id, input.photos);
      else
        media = (
          await c.query<{ moderation: string }>(`SELECT m.moderation FROM market_listing_photos p JOIN media m ON m.id = p.media_id WHERE p.listing_id = $1`, [
            id,
          ])
        ).rows;
      const words =
        input.title !== undefined || input.description !== undefined || input.category !== undefined || input.priceCents !== undefined || !!input.photos;
      const verdict = words ? await screen(c, u.id, id, { ...next, currency: cur.currency.trim(), notProhibited: input.notProhibited, photos: media }) : null;
      const place = input.place === undefined ? undefined : input.place === null ? null : approximatePoint(input.place);
      await c.query(
        `UPDATE market_listings SET title = $2, description = $3, category = $4, condition = coalesce($5, condition), price_cents = $6,
                area = coalesce($7, area), delivery = coalesce($8, delivery), fingerprint = $9, updated_at = now(),
                approx_lat = CASE WHEN $10 THEN $11 ELSE approx_lat END, approx_lng = CASE WHEN $10 THEN $12 ELSE approx_lng END
         WHERE id = $1`,
        [
          id,
          next.title,
          next.description,
          next.category,
          input.condition ?? null,
          next.priceCents,
          input.area ?? null,
          input.delivery ?? null,
          fingerprintOf(next.title, next.description),
          place !== undefined,
          place?.lat ?? null,
          place?.lng ?? null,
        ],
      );
      if (input.photos) await setPhotos(c, id, input.photos);
      // A change that needs a look waits for one; a listing already waiting keeps waiting.
      if (verdict && cur.moderation_status === 'normal') await holdForReview(c, id, u.id, verdict);
      return !!verdict || cur.moderation_status === 'review';
    });
    const [listing] = await presentListings(db, [(await listingRow(db, id, u.id))!], u.id);
    await publishListingCards(deps, id);
    return { listing, ...(held ? { notice: HELD } : {}) };
  });

  /**
   * Available, reserved or sold. `buyerId` must be someone who wrote to you about it: reserving for
   * them, or selling to them (they're told, and you can rate each other). Without it, reserved or sold
   * to someone else.
   */
  app.put('/v1/market/listings/:id/status', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(listingStatusSchema, req.body);
    const buyer = input.status === 'available' ? null : (input.buyerId ?? null);
    const { cur, soldNow } = await tx(db, async (c) => {
      const cur = await ownListing(c, id, u.id, true);
      if (cur.moderation_status === 'removed') throw forbidden('This listing was taken down.');
      if (buyer) {
        const chat = await c.query(`SELECT 1 FROM market_chats WHERE listing_id = $1 AND buyer_id = $2`, [id, buyer]);
        if (!chat.rowCount) throw badRequest('Choose someone who wrote to you about this listing, or someone else.');
        if (await isBlockedEitherWay(c, u.id, buyer)) throw forbidden('You can’t choose this person.');
      }
      await c.query(
        `UPDATE market_listings SET status = $2, updated_at = now(),
                reserved_for = CASE WHEN $2 = 'reserved' THEN $3::uuid END,
                sold_to = CASE WHEN $2 = 'sold' THEN $3::uuid END,
                sold_at = CASE WHEN $2 = 'sold' THEN coalesce(CASE WHEN status = 'sold' AND sold_to IS NOT DISTINCT FROM $3::uuid THEN sold_at END, now()) END
         WHERE id = $1`,
        [id, input.status, buyer],
      );
      return { cur, soldNow: input.status === 'sold' && buyer && !(cur.status === 'sold' && cur.sold_to === buyer) };
    });
    if (soldNow && buyer)
      await notify(db, ctx.realtime, {
        userId: buyer,
        category: 'commerce',
        type: 'market_sold_to_you',
        actorId: u.id,
        entityType: 'listing',
        entityId: id,
        data: { title: cur.title },
      });
    if (input.status === 'sold' && cur.status !== 'sold') track(db, u.id, 'market_listing_sold', { toBuyer: !!buyer });
    await publishListingCards(deps, id);
    const [listing] = await presentListings(db, [(await listingRow(db, id, u.id))!], u.id);
    return { listing };
  });

  /** Another MARKET_LISTING_DAYS, once it has MARKET_RENEW_WITHIN_DAYS or less left, or has ended. */
  app.post('/v1/market/listings/:id/renew', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const cur = await ownListing(db, id, u.id);
    if (cur.status === 'sold') throw new AppError(409, 'listing_sold', 'This listing is sold. Mark it available first if the sale fell through.');
    if (cur.moderation_status === 'removed') throw forbidden('This listing was taken down.');
    const r = await db.query(
      `UPDATE market_listings SET expires_at = now() + make_interval(days => $2), renewed_at = now(), reminded_at = NULL, ended_notified_at = NULL, updated_at = now()
       WHERE id = $1 AND expires_at <= now() + make_interval(days => $3)`,
      [id, MARKET_LISTING_DAYS, MARKET_RENEW_WITHIN_DAYS],
    );
    if (!r.rowCount) throw new AppError(409, 'renew_too_early', `You can renew a listing once it has ${MARKET_RENEW_WITHIN_DAYS} days or less left.`);
    const [listing] = await presentListings(db, [(await listingRow(db, id, u.id))!], u.id);
    await publishListingCards(deps, id);
    return { listing };
  });

  /** Delete a listing. Chat cards about it say it's no longer available; offers waiting on it are withdrawn. */
  app.delete('/v1/market/listings/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const offers = await tx(db, async (c) => {
      await ownListing(c, id, u.id, true);
      await c.query(`UPDATE market_listings SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
      const { rows } = await c.query<{ id: string }>(
        `UPDATE market_offers SET status = 'withdrawn', responded_at = now() WHERE listing_id = $1 AND status = 'pending' RETURNING id`,
        [id],
      );
      return rows.map((r) => r.id);
    });
    for (const o of offers) await publishOffer(deps, o);
    await publishListingCards(deps, id);
    return { ok: true };
  });

  app.put('/v1/market/listings/:id/save', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (!(await listingRow(db, id, u.id))) throw notFound('That listing');
    await db.query(`INSERT INTO market_saves (user_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]);
    return { saved: true };
  });

  app.delete('/v1/market/listings/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM market_saves WHERE user_id = $1 AND listing_id = $2`, [me(req).id, id]);
    return { saved: false };
  });

  /** Listings you saved that you can still open, newest saved first. */
  app.get('/v1/market/saved', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(pageQuery, req.query);
    const c = decodeCursor<{ t: string; id: string }>(q.cursor);
    const { rows } = await db.query<ListingRow & { saved_at: Date }>(
      `SELECT ${LISTING_COLS}, s.created_at AS saved_at ${LISTING_FROM} JOIN market_saves s ON s.listing_id = l.id AND s.user_id = $1
       WHERE ${listingVisibleSql('$1')} ${c ? 'AND (s.created_at, l.id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY s.created_at DESC, l.id DESC LIMIT $2`,
      c ? [u.id, q.limit + 1, c.t, c.id] : [u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: await presentListings(db, page, u.id),
      nextCursor: rows.length > q.limit && last ? keyCursorOf({ created_at: last.saved_at, id: last.id }) : null,
    };
  });

  /** Your own listings: for sale (available or reserved, not ended), sold, or ended. */
  app.get('/v1/market/mine', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { status } = parse(z.object({ status: z.enum(['active', 'sold', 'expired']).default('active') }), req.query);
    const filter =
      status === 'sold'
        ? `l.status = 'sold'`
        : status === 'expired'
          ? `l.status <> 'sold' AND l.expires_at <= now()`
          : `l.status <> 'sold' AND l.expires_at > now()`;
    const { rows } = await db.query<ListingRow>(
      `SELECT ${LISTING_COLS} ${LISTING_FROM} WHERE l.seller_id = $1 AND l.deleted_at IS NULL AND ${filter}
       ORDER BY ${status === 'sold' ? 'l.sold_at' : 'l.created_at'} DESC LIMIT 200`,
      [u.id],
    );
    return { items: await presentListings(db, rows, u.id) };
  });

  /**
   * Rate the other person after a sale: the buyer the listing was marked sold to, and its seller,
   * once each. The words are checked like a comment; risky ones wait for a moderator.
   */
  app.post('/v1/market/listings/:id/ratings', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(marketRatingSchema, req.body);
    const l = (
      await db.query(
        `SELECT id, seller_id, sold_to, status, title, EXISTS (SELECT 1 FROM market_chats mc WHERE mc.listing_id = l.id AND mc.buyer_id = $2) AS wrote
         FROM market_listings l WHERE id = $1 AND deleted_at IS NULL`,
        [id, u.id],
      )
    ).rows[0];
    if (!l || (l.seller_id !== u.id && l.sold_to !== u.id && !l.wrote)) throw notFound('That listing');
    if (l.status !== 'sold' || !l.sold_to || (l.seller_id !== u.id && l.sold_to !== u.id))
      throw new AppError(403, 'rating_not_allowed', 'You can rate each other once the seller marks it sold to the buyer from your chat.');
    const other = l.seller_id === u.id ? l.sold_to : l.seller_id;
    if (await isBlockedEitherWay(db, u.id, other)) throw forbidden('You can’t rate this person.');
    const analysis = analyzeText(input.body);
    if (analysis.risk === 'escalate') throw new AppError(422, 'content_blocked', 'This rating can’t be posted because it may put someone at risk.');
    const held = analysis.risk === 'restrict' || analysis.risk === 'review';
    const row = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO market_ratings (listing_id, listing_title, rater_id, ratee_id, rater_role, stars, body, moderation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (listing_id, rater_id) DO NOTHING RETURNING id`,
        [id, l.title, u.id, other, l.seller_id === u.id ? 'seller' : 'buyer', input.stars, input.body, held ? 'review' : 'normal'],
      );
      if (!rows[0]) throw new AppError(409, 'already_rated', 'You already rated this sale.');
      if (held)
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('market_rating', $1, $2, 'automated', 'review', $3)
           ON CONFLICT DO NOTHING`,
          [rows[0].id, u.id, { signals: analysis.signals }],
        );
      return rows[0];
    });
    if (!held)
      await notify(db, ctx.realtime, {
        userId: other,
        category: 'commerce',
        type: 'market_rated',
        actorId: u.id,
        entityType: 'listing',
        entityId: id,
        data: { title: l.title, stars: input.stars },
      });
    await publishListingCards(deps, id);
    const [rating] = (await ratingsAbout(db, other, u.id, { limit: 50 })).filter((r) => r.id === row.id);
    reply.code(201);
    const { _at, ...out } = rating!;
    return { rating: out };
  });

  /** Someone's Market tab: their seller card, what they have for sale that you may see, and recent ratings. */
  app.get('/v1/market/sellers/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const who = (await db.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [id])).rows[0];
    if (!who || who.status !== 'active' || (id !== u.id && (await isBlockedEitherWay(db, u.id, id)))) throw notFound('That person');
    const { rows } = await db.query<ListingRow>(
      `SELECT ${LISTING_COLS} ${LISTING_FROM} WHERE l.seller_id = $2 AND ${listingListedSql('$1')} ORDER BY l.created_at DESC LIMIT 60`,
      [u.id, id],
    );
    const ratings = await ratingsAbout(db, id, u.id, { limit: 20 });
    const market: MarketProfile = {
      seller: (await sellerCards(db, [id])).get(id)!,
      listings: await presentListings(db, rows, u.id),
      ratings: ratings.map(({ _at, ...r }) => r),
      asBuyer: (await ratingSummaries(db, [id], 'seller')).get(id)!,
    };
    return { market };
  });

  app.get('/v1/market/sellers/:id/ratings', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuery, req.query);
    if (id !== u.id && (await isBlockedEitherWay(db, u.id, id))) throw notFound('That person');
    const items = await ratingsAbout(db, id, u.id, { limit: q.limit + 1, before: decodeCursor<{ t: string; id: string }>(q.cursor) });
    const page = items.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(({ _at, ...r }) => r),
      nextCursor: items.length > q.limit && last ? keyCursorOf({ created_at: last._at, id: last.id }) : null,
    };
  });

  /**
   * What anyone can see of a shared listing link: listed now (not sold, not ended, nothing held),
   * from an active adult account; the seller's name only when their account is public. The photo is
   * one that isn't waiting for a check or marked sensitive. Never where it is beyond the area text.
   */
  app.get('/v1/public/market/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    reply.header('cache-control', 'no-store');
    const { rows } = await db.query(
      `SELECT l.id, l.title, l.description, l.price_cents, l.currency, l.condition, l.category, l.area, l.status,
              ${publicAccountSql('sp', 'su')} AS public_seller, sp.username, sp.display_name,
              (SELECT coalesce(m.variants->>'medium', m.url) FROM market_listing_photos ph JOIN media m ON m.id = ph.media_id
               WHERE ph.listing_id = l.id AND m.deleted_at IS NULL AND m.moderation = 'ok' ORDER BY ph.position LIMIT 1) AS image_url
       ${LISTING_FROM}
       WHERE l.id = $1 AND l.deleted_at IS NULL AND l.moderation_status = 'normal' AND l.status <> 'sold' AND l.expires_at > now()
         AND su.status = 'active' AND su.deleted_at IS NULL AND NOT coalesce(su.birth_date > current_date - interval '18 years', false)`,
      [id],
    );
    const r = rows[0];
    if (!r) throw notFound('That listing');
    const listing: PublicListingPreview = {
      id: r.id,
      title: r.title,
      excerpt: excerpt(r.description),
      priceCents: r.price_cents === null ? null : Number(r.price_cents),
      currency: r.currency.trim(),
      condition: r.condition,
      category: r.category,
      area: r.area,
      imageUrl: r.image_url ?? null,
      status: r.status,
      seller: r.public_seller ? { username: r.username, displayName: r.display_name } : null,
    };
    reply.header('cache-control', 'public, max-age=60');
    return { listing };
  });
}

/**
 * Writing to a seller about a listing, and offers, in a one-to-one chat (registered by the messaging
 * module, which lends its chat helpers). The chat starts with a card for the listing, once per buyer
 * and listing; offers and counter-offers are cards the other person answers. The usual rules for a
 * first message apply, except the seller's "Who can message you": listing something invites people to
 * write about it. Blocks either way, and an adult and someone under 18 only as friends (or family),
 * a supervised teen's family settings, a confirmed email or phone and a limited account all apply.
 */
export function registerMarketChats(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };

  /** Whether `u` may write to the seller about this listing now; throws with the reason when not. */
  async function assertCanContact(
    u: AuthUser,
    l: { id: string; seller_id: string; status: string; expired: boolean; moderation_status: string; sold_to: string | null; reserved_for: string | null },
  ) {
    if (l.seller_id === u.id) throw badRequest('This is your own listing.');
    const partOfIt = l.sold_to === u.id || l.reserved_for === u.id;
    if (l.moderation_status !== 'normal' || (!partOfIt && (l.status === 'sold' || l.expired))) throw unavailable();
    if (await isBlockedEitherWay(db, u.id, l.seller_id)) throw forbidden("You can't message this person.");
    const seller = (await db.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [l.seller_id])).rows[0];
    if (!seller || seller.status !== 'active') throw unavailable();
    const minorInvolved = (ageOf(u.birthDate) ?? 18) < 18 || (await isMinor(db, l.seller_id));
    if (minorInvolved && !(await trustedPair(db, u.id, l.seller_id))) throw new AppError(403, 'minor_protection', MINOR_CONTACT);
    const controls = await activeControls(db, u.id);
    if (controls && !controls.guardianIds.includes(l.seller_id) && (controls.messagesFrom === 'nobody' || !(await areFriends(db, u.id, l.seller_id))))
      throw new AppError(403, 'family_controls', 'Family settings on this account limit who it can message.');
    if (!(await areFriends(db, u.id, l.seller_id))) {
      await requireVerified(db, ctx.config, u.id, 'message');
      if (await isRestricted(db, u.id)) throw restrictedError('message');
    }
  }

  async function listingFor(u: AuthUser, id: string) {
    const { rows } = await db.query(
      `SELECT l.id, l.seller_id, l.title, l.status, l.price_cents, l.currency, (l.expires_at <= now()) AS expired, l.moderation_status, l.sold_to, l.reserved_for
       ${LISTING_FROM} WHERE l.id = $2 AND ${listingVisibleSql('$1')}`,
      [u.id, id],
    );
    if (!rows[0]) throw notFound('That listing');
    return rows[0];
  }

  /** A message from `senderId` into the chat (with its disappearing timer), then the chat moves up. */
  async function insertCard(c: PoolClient, conversationId: string, senderId: string, body: string, meta: object): Promise<string> {
    const conv = (await c.query<{ disappearing_seconds: number | null }>(`SELECT disappearing_seconds FROM conversations WHERE id = $1`, [conversationId]))
      .rows[0];
    const seconds = conv?.disappearing_seconds ?? null;
    const { rows } = await c.query<{ id: string }>(
      // The time of this statement, not of the transaction: a card and an offer made together stay in that order.
      `INSERT INTO messages (conversation_id, sender_id, body, kind, meta, created_at, expires_at)
       VALUES ($1,$2,$3,'message',$4, clock_timestamp(), now() + make_interval(secs => $5::int)) RETURNING id`,
      [conversationId, senderId, body, meta, seconds],
    );
    if (seconds) await enqueue(c, 'messages.expire', { messageId: rows[0]!.id }, seconds + 1);
    await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
    await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [conversationId, senderId]);
    return rows[0]!.id;
  }

  /**
   * The one-to-one chat between the buyer and the seller (made if needed, like "Message" on a
   * profile), with the listing's card at its top: posted once per buyer and listing.
   */
  async function openChat(
    c: PoolClient,
    buyer: string,
    l: { id: string; seller_id: string; title: string },
  ): Promise<{ conversationId: string; cardId: string | null; created: boolean }> {
    const key = [buyer, l.seller_id].sort().join(':');
    let conversationId = (await c.query<{ id: string }>(`SELECT id FROM conversations WHERE direct_key = $1`, [key])).rows[0]?.id;
    if (conversationId) await c.query(`UPDATE conversation_members SET left_at = NULL WHERE conversation_id = $1 AND user_id = $2`, [conversationId, buyer]);
    else {
      conversationId = (
        await c.query<{ id: string }>(`INSERT INTO conversations (kind, direct_key, created_by) VALUES ('direct',$1,$2) RETURNING id`, [key, buyer])
      ).rows[0]!.id;
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`, [conversationId, buyer, l.seller_id]);
    }
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('market-chat:' || $1 || $2))`, [l.id, buyer]);
    const existing = (
      await c.query<{ message_id: string | null }>(
        `SELECT mc.message_id FROM market_chats mc LEFT JOIN messages x ON x.id = mc.message_id AND x.deleted_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > now())
         WHERE mc.listing_id = $1 AND mc.buyer_id = $2 AND mc.conversation_id = $3 AND x.id IS NOT NULL`,
        [l.id, buyer, conversationId],
      )
    ).rows[0];
    if (existing) return { conversationId, cardId: existing.message_id, created: false };
    const cardId = await insertCard(c, conversationId, buyer, l.title, { listingId: l.id });
    await c.query(
      `INSERT INTO market_chats (listing_id, buyer_id, conversation_id, message_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (listing_id, buyer_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, message_id = EXCLUDED.message_id`,
      [l.id, buyer, conversationId, cardId],
    );
    return { conversationId, cardId, created: true };
  }

  /** New messages go to both people (a person who blocked the sender never gets them). */
  async function deliver(senderId: string, conversationId: string, messageId: string) {
    for (const reader of await h.notBlocking(senderId, await h.memberIds(conversationId))) {
      const message = await h.loadMessage(messageId, reader);
      if (message) await ctx.realtime.publish([reader], { type: 'message.created', data: message });
    }
  }

  /** "Message seller": your chat with the seller, starting with the listing's card. */
  app.post('/v1/market/listings/:id/message', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const l = await listingFor(u, id);
    await assertCanContact(u, l);
    await assertMessagePace(db, ctx.config, u.id);
    const chat = await tx(db, (c) => openChat(c, u.id, l));
    if (chat.created && chat.cardId) await deliver(u.id, chat.conversationId, chat.cardId);
    const message = chat.cardId ? await h.loadMessage(chat.cardId, u.id) : null;
    if (chat.created) track(db, u.id, 'market_chat_started', {});
    reply.code(chat.created ? 201 : 200);
    return { conversationId: chat.conversationId, message };
  });

  const offerLine = (amountCents: number, currency: string, counter: boolean) =>
    `${counter ? 'Counter-offer' : 'Offer'} · ${formatMoney(amountCents, currency, 'en').replace(/\u00a0/g, ' ')}`;

  /** Offer an amount: a card in your chat with the seller (made if needed). One offer waiting per listing at a time. */
  app.post('/v1/market/listings/:id/offers', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(makeOfferSchema, req.body);
    const l = await listingFor(u, id);
    await assertCanContact(u, l);
    if (l.status === 'sold' || l.expired) throw unavailable();
    await assertMessagePace(db, ctx.config, u.id);
    const currency = l.currency.trim();
    const made = await tx(db, async (c) => {
      const chat = await openChat(c, u.id, l);
      const pending = (await c.query<{ id: string }>(`SELECT id FROM market_offers WHERE listing_id = $1 AND buyer_id = $2 AND status = 'pending'`, [id, u.id]))
        .rows[0];
      if (pending) throw new AppError(409, 'offer_pending', 'There’s already an offer waiting for an answer in your chat.', { offerId: pending.id });
      const offer = (
        await c.query<{ id: string }>(
          `INSERT INTO market_offers (listing_id, conversation_id, buyer_id, seller_id, made_by, amount_cents, currency) VALUES ($1,$2,$3,$4,'buyer',$5,$6) RETURNING id`,
          [id, chat.conversationId, u.id, l.seller_id, input.amountCents, currency],
        )
      ).rows[0]!.id;
      const messageId = await insertCard(c, chat.conversationId, u.id, offerLine(input.amountCents, currency, false), { offerId: offer });
      await c.query(`UPDATE market_offers SET message_id = $2 WHERE id = $1`, [offer, messageId]);
      return { offer, messageId, chat };
    });
    if (made.chat.created && made.chat.cardId) await deliver(u.id, made.chat.conversationId, made.chat.cardId);
    await deliver(u.id, made.chat.conversationId, made.messageId);
    await notify(db, ctx.realtime, {
      userId: l.seller_id,
      category: 'commerce',
      type: 'market_offer',
      actorId: u.id,
      entityType: 'conversation',
      entityId: made.chat.conversationId,
      data: { listingId: id, title: l.title, amountCents: input.amountCents, currency },
    });
    track(db, u.id, 'market_offer_made', {});
    const { rows } = await db.query(`SELECT ${OFFER_COLS} FROM market_offers o WHERE o.id = $1`, [made.offer]);
    const [offer] = await presentOffers(db, rows, u.id);
    reply.code(201);
    return { conversationId: made.chat.conversationId, offer, message: await h.loadMessage(made.messageId, u.id) };
  });

  /** An offer `u` is part of, locked, with who made it and who answers it. */
  async function offerFor(c: PoolClient, id: string, u: AuthUser) {
    const { rows } = await c.query(
      `SELECT o.*, l.status AS l_status, l.deleted_at AS l_deleted, l.moderation_status AS l_moderation, l.title AS l_title, (l.expires_at <= now()) AS l_expired
       FROM market_offers o JOIN market_listings l ON l.id = o.listing_id WHERE o.id = $1 AND (o.buyer_id = $2 OR o.seller_id = $2) FOR UPDATE OF o`,
      [id, u.id],
    );
    const o = rows[0];
    if (!o) throw notFound('That offer');
    const maker = o.made_by === 'buyer' ? o.buyer_id : o.seller_id;
    const other = o.made_by === 'buyer' ? o.seller_id : o.buyer_id;
    return { o, maker: maker as string, other: other as string };
  }

  const notPending = () => new AppError(409, 'offer_closed', 'This offer has already been answered.');

  /** Answer or withdraw an offer; tells the other person and updates the card for both. */
  async function answer(u: AuthUser, id: string, action: 'accept' | 'decline' | 'withdraw') {
    const done = await tx(db, async (c) => {
      const { o, maker, other } = await offerFor(c, id, u);
      if (o.status !== 'pending') throw notPending();
      if (action === 'withdraw' ? u.id !== maker : u.id !== other)
        throw new AppError(403, 'not_yours_to_answer', action === 'withdraw' ? 'Only the person who made this offer can withdraw it.' : 'You made this offer.');
      if (action === 'accept') {
        if (o.l_deleted || o.l_moderation !== 'normal' || o.l_status === 'sold' || o.l_expired) throw unavailable();
        if (await isBlockedEitherWay(c, o.buyer_id, o.seller_id)) throw forbidden("You can't answer this offer.");
      }
      const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'withdrawn';
      await c.query(`UPDATE market_offers SET status = $2, responded_at = now() WHERE id = $1`, [id, status]);
      // Accepting reserves it for the buyer (the seller can change that from the listing).
      if (action === 'accept')
        await c.query(`UPDATE market_listings SET status = 'reserved', reserved_for = $2, updated_at = now() WHERE id = $1 AND status = 'available'`, [
          o.listing_id,
          o.buyer_id,
        ]);
      return { o, maker };
    });
    if (action !== 'withdraw')
      await notify(db, ctx.realtime, {
        userId: done.maker,
        category: 'commerce',
        type: action === 'accept' ? 'market_offer_accepted' : 'market_offer_declined',
        actorId: u.id,
        entityType: 'conversation',
        entityId: done.o.conversation_id,
        data: { listingId: done.o.listing_id, title: done.o.l_title, amountCents: Number(done.o.amount_cents), currency: done.o.currency.trim() },
      });
    await publishOffer(deps, id);
    if (action === 'accept') await publishListingCards(deps, done.o.listing_id);
    const { rows } = await db.query(`SELECT ${OFFER_COLS} FROM market_offers o WHERE o.id = $1`, [id]);
    return { offer: (await presentOffers(db, rows, u.id))[0] };
  }

  for (const action of ['accept', 'decline', 'withdraw'] as const)
    app.post(`/v1/market/offers/:id/${action}`, { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const { id } = parse(idParam, req.params);
      return answer(me(req), id, action);
    });

  /** Answer an offer with another amount: the first is marked countered and a new card goes in the chat. */
  app.post('/v1/market/offers/:id/counter', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(counterOfferSchema, req.body);
    await assertMessagePace(db, ctx.config, u.id);
    const made = await tx(db, async (c) => {
      const { o, other } = await offerFor(c, id, u);
      if (o.status !== 'pending') throw notPending();
      if (u.id !== other) throw new AppError(403, 'not_yours_to_answer', 'You made this offer.');
      if (o.l_deleted || o.l_moderation !== 'normal' || o.l_status === 'sold' || o.l_expired) throw unavailable();
      if (await isBlockedEitherWay(c, o.buyer_id, o.seller_id)) throw forbidden("You can't answer this offer.");
      await c.query(`UPDATE market_offers SET status = 'countered', responded_at = now() WHERE id = $1`, [id]);
      const role = u.id === o.seller_id ? 'seller' : 'buyer';
      const currency = o.currency.trim();
      const next = (
        await c.query<{ id: string }>(
          `INSERT INTO market_offers (listing_id, conversation_id, buyer_id, seller_id, made_by, amount_cents, currency, counter_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [o.listing_id, o.conversation_id, o.buyer_id, o.seller_id, role, input.amountCents, currency, id],
        )
      ).rows[0]!.id;
      const messageId = await insertCard(c, o.conversation_id, u.id, offerLine(input.amountCents, currency, true), { offerId: next });
      await c.query(`UPDATE market_offers SET message_id = $2 WHERE id = $1`, [next, messageId]);
      return { o, next, messageId, to: o.made_by === 'buyer' ? o.buyer_id : o.seller_id };
    });
    await publishOffer(deps, id);
    await deliver(u.id, made.o.conversation_id, made.messageId);
    await notify(db, ctx.realtime, {
      userId: made.to,
      category: 'commerce',
      type: 'market_offer_countered',
      actorId: u.id,
      entityType: 'conversation',
      entityId: made.o.conversation_id,
      data: { listingId: made.o.listing_id, title: made.o.l_title, amountCents: input.amountCents, currency: made.o.currency.trim() },
    });
    const { rows } = await db.query(`SELECT ${OFFER_COLS} FROM market_offers o WHERE o.id = $1`, [made.next]);
    reply.code(201);
    return { offer: (await presentOffers(db, rows, u.id))[0], message: await h.loadMessage(made.messageId, u.id) };
  });
}
