import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { tx } from '@yapilapi/database';
import {
  createBusinessSchema,
  createOrderSchema,
  createPlaceSchema,
  createProductSchema,
  CURRENCY_SCALE,
  EARNINGS_HOLD_DAYS,
  PLACE_CATEGORIES,
  PLATFORM_FEE_BPS,
  processingFeeCents,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, isEnabled, notify, track } from '../lib/services.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { signDevWebhook } from '../lib/payments.ts';
import { businessOverview } from '../lib/ai/agents.ts';
import { refundUnspentBudget } from '../lib/ad-refunds.ts';
import { submitBoostForReview } from '../lib/boosts.ts';
import { assertAdultForMoney, publicUserFrom } from '../lib/users.ts';
import { EVENT_SELECT, toEvent } from './events.ts';
import { eventVisibleSql, liveVisibleSql } from '../lib/visibility.ts';
import { liveChatAudience } from '../lib/live.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';
import { grantPlus } from '../lib/plus.ts';
import { refundOrder, revokeRefundedOrder, sellerFeesSql, startPayment } from '../lib/checkout.ts';
import { assertDigitalCheckoutAllowed } from '../lib/store-purchases.ts';
import { confirmDropOrder, dropGateSql, publishDropChange, releaseDropOrder, takeDropStock } from '../lib/drops.ts';
import { issueOrderTickets, publishDoor } from '../lib/tickets.ts';

const idParam = z.object({ id: z.string().uuid() });

export default async function commerceModule(app: FastifyInstance, ctx: AppContext) {
  /** A paid tip sent during a live shows up in that live's chat as a gift, for everyone watching (minor safety as for chat). */
  async function announceLiveGift(c: { query: typeof ctx.db.query }, orderId: string) {
    const t = (
      await c.query(
        `SELECT t.live_id, t.message, t.from_id, o.total_cents, o.currency FROM tips t JOIN orders o ON o.id = t.order_id
         JOIN live_sessions l ON l.id = t.live_id WHERE t.order_id = $1 AND l.status = 'live'`,
        [orderId],
      )
    ).rows[0];
    if (!t) return;
    const { rows } = await c.query(
      `INSERT INTO live_chat (session_id, user_id, kind, body, amount_cents, currency) VALUES ($1,$2,'gift',$3,$4,$5) RETURNING id, created_at`,
      [t.live_id, t.from_id, t.message ?? '', t.total_cents, t.currency],
    );
    const author = (
      await c.query(
        `SELECT user_id AS a_id, username AS a_username, display_name AS a_display_name, avatar_url AS a_avatar_url, mode AS a_mode FROM profiles WHERE user_id = $1`,
        [t.from_id],
      )
    ).rows[0];
    const audience = await liveChatAudience(c, t.live_id, t.from_id);
    const message = {
      id: rows[0].id,
      kind: 'gift',
      body: t.message ?? '',
      answered: false,
      amountCents: t.total_cents,
      currency: t.currency,
      author: publicUserFrom(author, 'a_'),
      createdAt: rows[0].created_at,
    };
    await ctx.realtime.publish(audience, { type: 'live.chat', data: { liveId: t.live_id, message } });
  }

  const db = ctx.db;

  // ── Businesses ────────────────────────────────────────────────────────
  app.post('/v1/businesses', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(createBusinessSchema, req.body);
    const taken = await db.query(`SELECT 1 FROM businesses WHERE lower(slug) = $1`, [input.slug]);
    if (taken.rowCount) throw new AppError(409, 'conflict', 'That address is taken.', { fields: { slug: 'Taken.' } });
    const { rows } = await db.query(
      `INSERT INTO businesses (owner_id, slug, name, description, category, website) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, slug, name, description, category, website, created_at`,
      [u.id, input.slug, input.name, input.description, input.category, input.website ?? null],
    );
    await db.query(`UPDATE profiles SET mode = 'business' WHERE user_id = $1 AND mode = 'personal'`, [u.id]);
    reply.code(201);
    return { business: rows[0] };
  });

  app.get('/v1/me/businesses', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT id, slug, name FROM businesses WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [me(req).id]);
    return { items: rows };
  });

  app.get('/v1/businesses/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().max(40) }), req.params);
    const { rows } = await db.query(
      `SELECT b.id, b.slug, b.name, b.description, b.category, b.website, b.verified_at, b.created_at,
              pr.user_id AS o_id, pr.username AS o_username, pr.display_name AS o_display_name, pr.avatar_url AS o_avatar_url, pr.mode AS o_mode
       FROM businesses b JOIN profiles pr ON pr.user_id = b.owner_id WHERE lower(b.slug) = lower($1) AND b.deleted_at IS NULL`,
      [slug],
    );
    const b = rows[0];
    if (!b) throw notFound('Business');
    if (req.user && req.user.id !== b.o_id)
      void db
        .query(`INSERT INTO business_views (business_id, kind, target_id, viewer_id) VALUES ($1,'business',$1,$2) ON CONFLICT DO NOTHING`, [b.id, req.user.id])
        .catch(() => {});
    const [places, products] = await Promise.all([
      db.query(`SELECT id, name, category, address, city FROM places WHERE business_id = $1 AND deleted_at IS NULL`, [b.id]),
      db.query(
        `SELECT id, kind, title, description, price_cents, currency, inventory FROM products WHERE business_id = $1 AND deleted_at IS NULL AND status = 'active' ORDER BY created_at DESC`,
        [b.id],
      ),
    ]);
    return {
      business: {
        id: b.id,
        slug: b.slug,
        name: b.name,
        description: b.description,
        category: b.category,
        website: b.website,
        verified: !!b.verified_at,
        owner: publicUserFrom(b, 'o_'),
      },
      places: places.rows,
      products: products.rows.map(productDto),
    };
  });

  // ── Places ────────────────────────────────────────────────────────────
  app.post('/v1/places', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(createPlaceSchema, req.body);
    if (input.businessId) {
      const own = await db.query(`SELECT 1 FROM businesses WHERE id = $1 AND owner_id = $2`, [input.businessId, u.id]);
      if (!own.rowCount) throw forbidden('You can only attach places to your own business.');
    }
    const { rows } = await db.query(
      `INSERT INTO places (name, category, description, address, city, country, lat, lng, business_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.name,
        input.category,
        input.description,
        input.address ?? null,
        input.city ?? null,
        input.country?.toUpperCase() ?? null,
        input.lat ?? null,
        input.lng ?? null,
        input.businessId ?? null,
        u.id,
      ],
    );
    reply.code(201);
    return { place: await loadPlace(rows[0].id, u.id) };
  });

  /** A place, with its business; `business.mine` tells its owner apart (only they can read its bookings). */
  async function loadPlace(id: string, viewer: string | null) {
    const { rows } = await db.query(
      `SELECT pl.id, pl.name, pl.category, pl.description, pl.address, pl.city, pl.country, pl.lat, pl.lng, pl.hours,
              b.slug AS business_slug, b.name AS business_name, (b.owner_id = $2) AS business_mine
       FROM places pl LEFT JOIN businesses b ON b.id = pl.business_id WHERE pl.id = $1 AND pl.deleted_at IS NULL`,
      [id, viewer],
    );
    if (!rows[0]) throw notFound('Place');
    const { business_slug, business_name, business_mine, ...r } = rows[0];
    return { ...r, business: business_slug ? { slug: business_slug, name: business_name, mine: business_mine === true } : null };
  }

  app.get('/v1/places', async (req) => {
    const q = parse(
      z.object({
        category: z.enum(PLACE_CATEGORIES).optional(),
        city: z.string().max(100).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        radiusKm: z.coerce.number().min(0.1).max(100).default(10),
        limit: z.coerce.number().min(1).max(50).default(20),
      }),
      req.query,
    );
    const where = ['pl.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (q.category) where.push(`pl.category = $${params.push(q.category)}`);
    if (q.city) where.push(`lower(pl.city) = lower($${params.push(q.city)})`);
    let order = 'pl.created_at DESC';
    if (q.lat !== undefined && q.lng !== undefined) {
      // Bounding box prefilter, then haversine ordering.
      const dLat = q.radiusKm / 111;
      const dLng = q.radiusKm / (111 * Math.cos((q.lat * Math.PI) / 180) || 1);
      const a = params.push(q.lat);
      const b = params.push(q.lng);
      where.push(`pl.lat BETWEEN $${a} - ${dLat} AND $${a} + ${dLat} AND pl.lng BETWEEN $${b} - ${dLng} AND $${b} + ${dLng}`);
      order = `2 * 6371 * asin(sqrt(power(sin(radians(pl.lat - $${a}) / 2), 2) + cos(radians($${a})) * cos(radians(pl.lat)) * power(sin(radians(pl.lng - $${b}) / 2), 2)))`;
    }
    const { rows } = await db.query(
      `SELECT pl.id, pl.name, pl.category, pl.description, pl.address, pl.city, pl.country, pl.lat, pl.lng FROM places pl WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.push(q.limit)}`,
      params,
    );
    return { items: rows };
  });

  app.get('/v1/places/:id', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const place = await loadPlace(id, viewer);
    if (viewer)
      void db
        .query(
          `INSERT INTO business_views (business_id, kind, target_id, viewer_id)
           SELECT pl.business_id, 'place', pl.id, $2 FROM places pl JOIN businesses b ON b.id = pl.business_id WHERE pl.id = $1 AND b.owner_id <> $2
           ON CONFLICT DO NOTHING`,
          [id, viewer],
        )
        .catch(() => {});
    const events = await db.query(
      `${EVENT_SELECT} WHERE e.place_id = $2 AND e.starts_at >= now() - interval '6 hours' AND ${eventVisibleSql('$1')} ORDER BY e.starts_at LIMIT 10`,
      [viewer, id],
    );
    const products = await db.query(
      `SELECT pd.id, pd.kind, pd.title, pd.description, pd.price_cents, pd.currency, pd.inventory FROM products pd JOIN places pl ON pl.business_id = pd.business_id
       WHERE pl.id = $1 AND pd.deleted_at IS NULL AND pd.status = 'active' LIMIT 20`,
      [id],
    );
    return { place, events: events.rows.map(toEvent), products: products.rows.map(productDto) };
  });

  /** Owner-only insights: visits, bookings, reviews, sales and ads over the last N days. */
  app.get('/v1/businesses/:id/analytics', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }), req.query);
    const own = await db.query(`SELECT owner_id FROM businesses WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!own.rows[0]) throw notFound('Business');
    if (own.rows[0].owner_id !== u.id) throw forbidden();
    const [overview, views, ratings, ads, visitors] = await Promise.all([
      businessOverview(db, id, days),
      db.query(
        `SELECT day, count(*) FILTER (WHERE kind = 'business')::int AS business, count(*) FILTER (WHERE kind = 'place')::int AS places, count(DISTINCT viewer_id)::int AS visitors
         FROM business_views WHERE business_id = $1 AND day > current_date - $2::int GROUP BY day ORDER BY day`,
        [id, days],
      ),
      db.query(
        `SELECT date_trunc('week', r.created_at)::date AS week, count(*)::int AS reviews, round(avg(r.rating)::numeric, 2) AS average
         FROM place_reviews r JOIN places pl ON pl.id = r.place_id
         WHERE pl.business_id = $1 AND r.moderation_status IN ('normal','review') AND r.created_at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1`,
        [id, days],
      ),
      db.query(
        `SELECT coalesce(sum(impressions), 0)::int AS impressions, coalesce(sum(clicks), 0)::int AS clicks, coalesce(sum(spent_millicents) / 1000, 0)::int AS spent_cents
         FROM ad_campaigns WHERE business_id = $1`,
        [id],
      ),
      db.query(`SELECT count(DISTINCT viewer_id)::int AS n FROM business_views WHERE business_id = $1 AND day > current_date - $2::int`, [id, days]),
    ]);
    return {
      ...overview,
      views: views.rows,
      // Different people over the whole period (the daily rows count each person once per day).
      visitorsTotal: visitors.rows[0].n,
      ratingTrend: ratings.rows.map((r) => ({ week: r.week, reviews: r.reviews, average: Number(r.average) })),
      ads: { impressions: ads.rows[0].impressions, clicks: ads.rows[0].clicks, spentCents: ads.rows[0].spent_cents },
    };
  });

  // ── Products ──────────────────────────────────────────────────────────
  app.post('/v1/products', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Commerce');
    const u = me(req);
    const input = parse(createProductSchema, req.body);
    // Free, or about $1 at least in every currency: processing would eat less, and tiny prices are how stolen cards get tested.
    const minCents = 100 * CURRENCY_SCALE[input.currency];
    if (input.priceCents > 0 && input.priceCents < minCents) throw badRequest(`A paid item costs at least ${minCents} hundredths of ${input.currency}.`);
    // Selling is for adults (creator and seller terms).
    await assertAdultForMoney(db, u.id);
    if (input.businessId) {
      const own = await db.query(`SELECT 1 FROM businesses WHERE id = $1 AND owner_id = $2`, [input.businessId, u.id]);
      if (!own.rowCount) throw forbidden('You can only sell under your own business.');
    }
    if (input.eventId) {
      const host = await db.query(`SELECT 1 FROM events WHERE id = $1 AND host_id = $2`, [input.eventId, u.id]);
      if (!host.rowCount) throw forbidden('Only the host can sell tickets for this event.');
    }
    const { rows } = await db.query(
      `INSERT INTO products (seller_id, business_id, event_id, kind, title, description, price_cents, currency, inventory) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, kind, title, description, price_cents, currency, inventory`,
      [
        u.id,
        input.businessId ?? null,
        input.eventId ?? null,
        input.kind,
        input.title,
        input.description,
        input.priceCents,
        input.currency,
        input.inventory ?? null,
      ],
    );
    reply.code(201);
    return { product: productDto(rows[0]) };
  });

  app.get('/v1/products', async (req) => {
    const q = parse(z.object({ sellerId: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(50).default(20) }), req.query);
    const { rows } = await db.query(
      `SELECT pd.id, pd.kind, pd.title, pd.description, pd.price_cents, pd.currency, pd.inventory FROM products pd JOIN users u ON u.id = pd.seller_id
       WHERE pd.deleted_at IS NULL AND pd.status = 'active' AND u.status = 'active' ${q.sellerId ? 'AND pd.seller_id = $2' : ''}
         AND coalesce(${dropGateSql('pd.id')}, 'open') = 'open'
       ORDER BY pd.created_at DESC LIMIT $1`,
      q.sellerId ? [q.limit, q.sellerId] : [q.limit],
    );
    return { items: rows.map(productDto) };
  });

  // ── Orders & payments ─────────────────────────────────────────────────
  /** Idempotent: the same idempotencyKey from the same buyer returns the original order. */
  app.post('/v1/orders', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Commerce');
    const u = me(req);
    const input = parse(createOrderSchema, req.body);
    const existing = await db.query(`SELECT id FROM orders WHERE buyer_id = $1 AND idempotency_key = $2`, [u.id, input.idempotencyKey]);
    if (existing.rows[0]) return { order: await loadOrder(existing.rows[0].id, u.id), replayed: true };

    const order = await tx(db, async (c) => {
      const ids = input.items.map((i) => i.productId);
      const { rows: products } = await c.query(
        `SELECT pd.id, pd.seller_id, pd.kind, pd.price_cents, pd.currency, pd.inventory,
                EXISTS (SELECT 1 FROM product_files f WHERE f.product_id = pd.id) AS has_file,
                EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                        WHERE oi.product_id = pd.id AND o.buyer_id = $2 AND o.status = 'paid') AS owned
         FROM products pd WHERE pd.id = ANY($1) AND pd.deleted_at IS NULL AND pd.status = 'active' FOR UPDATE OF pd`,
        [ids, u.id],
      );
      if (products.length !== new Set(ids).size) throw notFound('One of those products');
      // Downloads and tickets to a live are digital goods: the phone apps may not sell them with a card checkout.
      if (products.some((p) => p.kind === 'digital')) assertDigitalCheckoutAllowed(req, ctx.config, 'digital_download');
      if (input.liveSessionId) assertDigitalCheckoutAllowed(req, ctx.config, 'live_ticket');
      for (const p of products) {
        // A download is sold once per buyer, and only once the seller has uploaded the file.
        if (p.kind === 'digital' && !p.has_file) throw new AppError(409, 'not_ready', "This download isn't ready yet. Try again later.");
        if (p.kind === 'digital' && p.owned) throw new AppError(409, 'conflict', 'You already bought this. Find it in your purchases.');
        // Services are booked for a time, from the Book button.
        if (p.kind === 'service') throw badRequest('Book a time for this service instead.');
      }
      if (input.items.some((i) => products.find((p) => p.id === i.productId)!.kind === 'digital' && i.quantity !== 1))
        throw badRequest('Buy one of each download.');
      if (input.liveSessionId) {
        // Only for a live the buyer may see (a live hosted by someone under 18 is for their friends).
        const live = (
          await c.query(`SELECT l.ticket_product_id FROM live_sessions l WHERE l.id = $2 AND l.status <> 'ended' AND ${liveVisibleSql('$1')}`, [
            u.id,
            input.liveSessionId,
          ])
        ).rows[0];
        if (!live?.ticket_product_id || !ids.includes(live.ticket_product_id)) throw badRequest("That isn't the ticket for this live.");
      }
      // Sellers must be adults; a listing made before that rule can't be bought from someone younger.
      for (const seller of new Set(products.map((p) => p.seller_id as string))) if (seller !== u.id) await assertAdultForMoney(c, seller, false);
      const currencies = new Set(products.map((p) => p.currency));
      if (currencies.size > 1) throw badRequest('All items in one order must use the same currency.');
      let total = 0;
      for (const item of input.items) {
        const p = products.find((x) => x.id === item.productId)!;
        if (p.seller_id === u.id) throw badRequest("You can't buy your own product.");
        if (p.inventory !== null && p.inventory < item.quantity) throw new AppError(409, 'out_of_stock', 'Not enough stock for one of the items.');
        total += p.price_cents * item.quantity;
      }
      const fee = Math.round((total * PLATFORM_FEE_BPS) / 10_000);
      const currency = [...currencies][0]!;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, processing_fee_cents, currency, idempotency_key, live_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [u.id, total, fee, Math.min(processingFeeCents(total, currency), total - fee), currency, input.idempotencyKey, input.liveSessionId ?? null],
      );
      const orderId = rows[0]!.id;
      for (const item of input.items) {
        const p = products.find((x) => x.id === item.productId)!;
        await c.query(`INSERT INTO order_items (order_id, product_id, quantity, unit_cents) VALUES ($1,$2,$3,$4)`, [
          orderId,
          p.id,
          item.quantity,
          p.price_cents,
        ]);
      }
      // Products in a drop: only while it's open, from what is really left, within the per-buyer limit.
      await takeDropStock(c, ctx.realtime, { orderId, buyerId: u.id, items: input.items });
      const pay = await startPayment(c, ctx.paymentProviders, {
        orderId,
        buyerId: u.id,
        amountCents: total,
        currency: [...currencies][0],
        idempotencyKey: input.idempotencyKey,
      });
      await audit(c, { actorId: u.id, action: 'order.create', entityType: 'order', entityId: orderId, metadata: { total } });
      return { orderId, ...pay };
    });
    reply.code(201);
    return { order: await loadOrder(order.orderId, u.id), payment: { provider: order.provider, clientSecret: order.clientSecret, orderId: order.orderId } };
  });

  const ORDER_SELECT = `SELECT o.id, o.status, o.total_cents, o.platform_fee_cents, o.processing_fee_cents, o.currency, o.created_at,
         (SELECT json_agg(json_build_object('productId', oi.product_id, 'title', p.title, 'quantity', oi.quantity, 'unitCents', oi.unit_cents))
          FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) AS items
       FROM orders o`;
  const toOrder = (r: Record<string, any>) => ({
    id: r.id,
    status: r.status,
    totalCents: r.total_cents,
    platformFeeCents: r.platform_fee_cents,
    processingFeeCents: r.processing_fee_cents,
    currency: r.currency,
    items: r.items,
    createdAt: r.created_at,
  });

  async function loadOrder(id: string, userId: string) {
    const { rows } = await db.query(
      `${ORDER_SELECT} WHERE o.id = $1 AND (o.buyer_id = $2 OR EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id AND p.seller_id = $2))`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Order');
    return toOrder(rows[0]);
  }

  // Your last 50 orders in one query (not one more query per order).
  app.get('/v1/orders', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`${ORDER_SELECT} WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 50`, [me(req).id]);
    return { items: rows.map(toOrder) };
  });

  app.get('/v1/orders/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { order: await loadOrder(id, me(req).id) };
  });

  /**
   * Provider webhook. Signature is verified before anything is read; each
   * provider event id is processed once (replays are acknowledged and ignored).
   */
  /** What the browser needs to collect payment (the provider's public key, never a secret). */
  app.get('/v1/payments/config', async () => ctx.paymentProviders.publicConfig());

  /**
   * Development only: complete a payment with the test provider, so purchases
   * can be finished locally. It goes through the same signed webhook as a real
   * provider. Not available with a real provider or in production.
   */
  app.post('/v1/payments/dev/complete', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    if (ctx.payments.name !== 'dev' || ctx.config.APP_ENV === 'production') throw notFound('Route');
    const { orderId } = parse(z.object({ orderId: z.string().uuid() }), req.body);
    const pay = (
      await db.query(
        `SELECT p.provider_ref, p.amount_cents, p.status FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.id = $1 AND o.buyer_id = $2 AND p.provider = 'dev'`,
        [orderId, me(req).id],
      )
    ).rows[0];
    if (!pay) throw notFound('Order');
    if (pay.status === 'succeeded') return { status: 'paid' };
    const payload = JSON.stringify({ id: `evt_dev_${orderId}`, type: 'payment.succeeded', providerRef: pay.provider_ref, amountCents: pay.amount_cents });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/webhook/dev',
      payload,
      headers: { 'content-type': 'application/json', 'x-signature': signDevWebhook(ctx.config.PAYMENTS_WEBHOOK_SECRET, payload) },
    });
    if (res.statusCode !== 200) throw new AppError(502, 'payment_failed', "The test payment didn't go through.");
    const o = (await db.query(`SELECT status FROM orders WHERE id = $1`, [orderId])).rows[0];
    return { status: o.status };
  });

  app.post('/v1/payments/webhook/:provider', { config: { rateLimit: false, rawBody: true } }, async (req, reply) => {
    const { provider } = parse(z.object({ provider: z.string() }), req.params);
    const verifier = ctx.paymentProviders.byName(provider);
    if (!verifier) throw notFound('Payment provider');
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    let event;
    try {
      event = verifier.verifyWebhook(raw, req.headers);
    } catch {
      reply.code(400);
      return { error: { code: 'bad_signature', message: 'Webhook signature is invalid.' } };
    }
    if (!event) return { ok: true, ignored: true };
    let duplicate = false;
    let ticketEvents: string[] = [];
    await tx(db, async (c) => {
      // Recorded with its effects in one transaction: if handling it fails, nothing is kept and the provider's retry runs it again.
      const fresh = await c.query(
        `INSERT INTO payment_webhook_events (id, provider, type, payload, processed_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING`,
        [event.id, provider, event.type, event],
      );
      if (!fresh.rowCount) {
        duplicate = true;
        return;
      }
      const pay = await c.query(`SELECT id, order_id, amount_cents, currency, status FROM payments WHERE provider = $1 AND provider_ref = $2 FOR UPDATE`, [
        provider,
        event.providerRef,
      ]);
      const p = pay.rows[0];
      if (!p) return;
      if (event.type === 'payment.succeeded' && p.status !== 'succeeded') {
        // Reconciliation: the amount and currency the provider captured must match what we charged.
        if (event.amountCents !== undefined && event.amountCents !== p.amount_cents) {
          await audit(c, {
            action: 'payment.amount_mismatch',
            entityType: 'payment',
            entityId: p.id,
            metadata: { expected: p.amount_cents, got: event.amountCents },
          });
          return;
        }
        if (event.currency !== undefined && event.currency !== p.currency.trim().toUpperCase()) {
          await audit(c, {
            action: 'payment.currency_mismatch',
            entityType: 'payment',
            entityId: p.id,
            metadata: { expected: p.currency, got: event.currency },
          });
          return;
        }
        await c.query(`UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = $1`, [p.id]);
        await c.query(`UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1`, [p.order_id]);
        // Paid after its hold in a drop ended and the units went to someone else (or the drop closed): the money goes straight back.
        if (!(await confirmDropOrder(c, p.order_id))) {
          await refundOrder(c, ctx.paymentProviders, p.order_id, null, 'The drop items were no longer available when the payment arrived');
          return;
        }
        // Stock is only taken once an order is paid, so it can sell out while a payment is on its way: that money goes straight back.
        await c.query(
          `SELECT 1 FROM products WHERE id IN (SELECT product_id FROM order_items WHERE order_id = $1) AND inventory IS NOT NULL ORDER BY id FOR UPDATE`,
          [p.order_id],
        );
        const short = await c.query(
          `SELECT 1 FROM order_items oi JOIN products pd ON pd.id = oi.product_id
           WHERE oi.order_id = $1 AND pd.inventory IS NOT NULL GROUP BY pd.id, pd.inventory HAVING pd.inventory < sum(oi.quantity)`,
          [p.order_id],
        );
        if (short.rowCount) {
          await refundOrder(c, ctx.paymentProviders, p.order_id, null, 'Sold out before the payment arrived');
          return;
        }
        await c.query(
          `UPDATE products pd SET inventory = pd.inventory - oi.quantity FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = pd.id AND pd.inventory IS NOT NULL`,
          [p.order_id],
        );
        const o = (await c.query(`SELECT buyer_id, purpose, payee_id FROM orders WHERE id = $1`, [p.order_id])).rows[0];
        track(db, o.buyer_id, 'order_paid', { purpose: o.purpose });
        if (o.purpose === 'subscription') {
          const started = await c.query(
            `UPDATE creator_subscriptions SET status = 'active', current_period_end = now() + interval '30 days' WHERE order_id = $1 AND status = 'pending'`,
            [p.order_id],
          );
          // Cancelled (or replaced by a new one) before this payment arrived: the money goes straight back.
          if (!started.rowCount) {
            await refundOrder(c, ctx.paymentProviders, p.order_id, null, 'The subscription was cancelled before the payment arrived');
            return;
          }
          await notify(c, ctx.realtime, {
            userId: o.payee_id,
            category: 'creators',
            type: 'subscription_started',
            actorId: o.buyer_id,
            entityType: 'order',
            entityId: p.order_id,
          });
        }
        if (o.purpose === 'tip') {
          await notify(c, ctx.realtime, {
            userId: o.payee_id,
            category: 'creators',
            type: 'tip_received',
            actorId: o.buyer_id,
            entityType: 'order',
            entityId: p.order_id,
          });
          await announceLiveGift(c, p.order_id);
        }
        if (o.purpose === 'plus') await grantPlus(c, o.buyer_id, 'purchase', { orderId: p.order_id });
        // Tickets for an event go into the buyer's Tickets wallet, and the door's count goes up.
        ticketEvents = await issueOrderTickets(c, p.order_id);
        // A paid service booking goes to the seller to confirm.
        const booked = await c.query(
          `UPDATE bookings bk SET status = 'requested' FROM products pd
           WHERE bk.order_id = $1 AND bk.status = 'pending_payment' AND pd.id = bk.product_id RETURNING bk.id, bk.starts_at, pd.seller_id`,
          [p.order_id],
        );
        // Paid after the booking was cancelled: the money goes straight back.
        const cancelled = await c.query(`SELECT 1 FROM bookings WHERE order_id = $1 AND status = 'cancelled'`, [p.order_id]);
        if (cancelled.rowCount) await refundOrder(c, ctx.paymentProviders, p.order_id, null, 'Booking was cancelled before payment');
        for (const b of booked.rows)
          await notify(c, ctx.realtime, {
            userId: b.seller_id,
            category: 'commerce',
            type: 'booking_request',
            actorId: o.buyer_id,
            entityType: 'booking',
            entityId: b.id,
            data: { startsAt: b.starts_at },
          });
        if (o.purpose === 'ad_budget') {
          const camp = await c.query(
            `UPDATE ad_campaigns SET budget_millicents = budget_millicents + (o.total_cents::bigint * 1000) FROM orders o
             WHERE o.id = $1 AND ad_campaigns.id = o.campaign_id RETURNING ad_campaigns.id, ad_campaigns.status`,
            [p.order_id],
          );
          // Money that arrives after a campaign was rejected or ended goes straight back.
          if (camp.rows[0] && ['rejected', 'ended'].includes(camp.rows[0].status)) await refundUnspentBudget(c, ctx.paymentProviders, camp.rows[0].id, null);
          // A boost goes to ad review once its budget is paid.
          if (camp.rows[0]?.status === 'draft') await submitBoostForReview(c, ctx.paymentProviders, camp.rows[0].id);
        }
        const sellers = await c.query<{ seller_id: string }>(
          `SELECT DISTINCT p.seller_id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
          [p.order_id],
        );
        for (const s of sellers.rows) await emitWebhook(c, s.seller_id, 'order.paid', { orderId: p.order_id });
        for (const s of sellers.rows)
          await notify(c, ctx.realtime, {
            userId: s.seller_id,
            category: 'commerce',
            type: 'order_paid',
            actorId: o.buyer_id,
            entityType: 'order',
            entityId: p.order_id,
          });
      } else if (event.type === 'payment.failed') {
        await c.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
        await c.query(`UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'pending'`, [p.order_id]);
        // Units it held in a drop go back on sale.
        const drops = (await c.query<{ drop_id: string }>(`SELECT DISTINCT drop_id FROM drop_orders WHERE order_id = $1 AND status = 'held'`, [p.order_id]))
          .rows;
        await releaseDropOrder(c, p.order_id);
        for (const d of drops) await publishDropChange(c, ctx.realtime, d.drop_id);
      } else if (event.type === 'refund.succeeded' || event.type === 'payment.disputed') {
        // The money went back outside the app (from the provider's dashboard, or a chargeback): undo what it paid for, as a refund here does.
        // A refund made here arrives too, but its order is already refunded and nothing happens.
        const reason = event.type === 'payment.disputed' ? 'The buyer disputed the payment' : 'Refunded at the payment provider';
        if (await revokeRefundedOrder(c, p.order_id, reason)) {
          await audit(c, { action: 'order.refunded_outside', entityType: 'order', entityId: p.order_id, metadata: { type: event.type } });
          ticketEvents = (await c.query<{ event_id: string }>(`SELECT DISTINCT event_id FROM event_tickets WHERE order_id = $1`, [p.order_id])).rows.map(
            (r) => r.event_id,
          );
        }
      }
    });
    if (duplicate) return { ok: true, duplicate: true };
    for (const eventId of ticketEvents) await publishDoor(db, ctx.realtime, eventId);
    return { ok: true };
  });

  /** Refund workflow: the seller (when everything in the order is theirs) or a platform admin can refund a paid order. */
  app.post('/v1/orders/:id/refund', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    const done = await tx(db, async (c) => {
      const o = await c.query(
        `SELECT o.id, o.status,
                coalesce((SELECT bool_and(p.seller_id = $2) FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id), false) AS is_seller
         FROM orders o WHERE o.id = $1 AND EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id) FOR UPDATE OF o`,
        [id, u.id],
      );
      const r = o.rows[0];
      if (!r || (!r.is_seller && u.role !== 'admin')) throw notFound('Order');
      if (r.status !== 'paid') throw badRequest('Only paid orders can be refunded.');
      const status = await refundOrder(c, ctx.paymentProviders, id, u.id, reason ?? null);
      const result = status === 'succeeded' ? 'succeeded' : 'failed';
      await audit(c, { actorId: u.id, action: 'order.refund', entityType: 'order', entityId: id, metadata: { status: result } });
      return { status: result };
    });
    // Refunded event tickets leave the door's count.
    const events = await db.query<{ event_id: string }>(`SELECT DISTINCT event_id FROM event_tickets WHERE order_id = $1`, [id]);
    for (const e of events.rows) await publishDoor(db, ctx.realtime, e.event_id);
    return done;
  });

  /** Seller earnings and payout requests. Payouts need verification before they are paid. */
  app.get('/v1/me/earnings', { preHandler: requireAuth }, async (req) => {
    return { balances: await earnings(db, me(req).id) };
  });

  app.post('/v1/me/payouts', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(z.object({ amountCents: z.number().int().positive(), currency: z.string().length(3).toUpperCase() }), req.body);
    if (!u.emailVerified) throw forbidden('Verify your email before requesting a payout.');
    await assertAdultForMoney(db, u.id);
    const payout = await tx(db, async (c) => {
      // One request at a time per person, so two at once can't both spend the same balance.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('payout:' || $1))`, [u.id]);
      const available = (await earnings(c, u.id)).find((b) => b.currency === input.currency)?.availableCents ?? 0;
      if (input.amountCents > available) throw badRequest('That is more than you have available to pay out.', { availableCents: Math.max(0, available) });
      return (
        await c.query(`INSERT INTO payouts (user_id, amount_cents, currency) VALUES ($1,$2,$3) RETURNING id, status`, [u.id, input.amountCents, input.currency])
      ).rows[0];
    });
    await audit(db, { actorId: u.id, action: 'payout.request', entityType: 'payout', entityId: payout.id, metadata: input });
    reply.code(201);
    return { payout, message: 'Payout requested. It will be paid after verification.' };
  });

  app.get('/v1/admin/payouts', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(`SELECT id, user_id, amount_cents, currency, status, created_at FROM payouts WHERE status = 'pending' ORDER BY created_at`);
    // What each person still has in that currency with their pending payouts taken off: below zero means refunds have left it uncovered.
    const balances = new Map<string, Awaited<ReturnType<typeof earnings>>>();
    for (const r of rows) if (!balances.has(r.user_id)) balances.set(r.user_id, await earnings(db, r.user_id));
    return {
      items: rows.map((r) => ({ ...r, available_cents: balances.get(r.user_id)!.find((b) => b.currency === r.currency)?.availableCents ?? 0 })),
    };
  });

  app.post('/v1/admin/payouts/:id/verify', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const payout = (await db.query(`SELECT user_id FROM payouts WHERE id = $1 AND status = 'pending'`, [id])).rows[0];
    if (!payout) throw notFound('Payout');
    // Payouts only go to adults, whatever was requested before the rule.
    await assertAdultForMoney(db, payout.user_id, false);
    await tx(db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('payout:' || $1))`, [payout.user_id]);
      const p = (await c.query(`SELECT currency FROM payouts WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id])).rows[0];
      if (!p) throw notFound('Payout');
      // Refunds since the request can leave less than was asked for (pending payouts already count as spent).
      const available = (await earnings(c, payout.user_id)).find((b) => b.currency === p.currency)?.availableCents ?? 0;
      if (available < 0) throw badRequest('Refunds since this request leave the person without enough earnings to cover it.');
      await c.query(`UPDATE payouts SET status = 'verified' WHERE id = $1`, [id]);
    });
    await audit(db, { actorId: me(req).id, action: 'payout.verify', entityType: 'payout', entityId: id });
    return { status: 'verified' };
  });
}

/**
 * What someone earned per currency after the platform fee and payment processing. A sale's share is held for EARNINGS_HOLD_DAYS
 * after it was paid (heldCents); what's left once payouts (other than failed ones) are taken off can be
 * paid out (availableCents).
 */
async function earnings(q: Pick<Pool, 'query'>, userId: string) {
  const { rows } = await q.query(
    `SELECT currency, sum(gross) AS gross, sum(fees) AS fees, sum(gross - fees) FILTER (WHERE held) AS held FROM (
       SELECT o.currency, oi.quantity * oi.unit_cents AS gross, ${sellerFeesSql} AS fees, o.paid_at > now() - make_interval(days => $2) AS held
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
       WHERE p.seller_id = $1 AND o.status = 'paid'
       UNION ALL
       SELECT o.currency, o.total_cents, o.platform_fee_cents + o.processing_fee_cents, o.paid_at > now() - make_interval(days => $2) FROM orders o
       WHERE o.payee_id = $1 AND o.status = 'paid' AND o.purpose IN ('subscription', 'tip')
     ) x GROUP BY currency`,
    [userId, EARNINGS_HOLD_DAYS],
  );
  const payouts = await q.query(`SELECT currency, sum(amount_cents) AS paid FROM payouts WHERE user_id = $1 AND status <> 'failed' GROUP BY currency`, [
    userId,
  ]);
  // Payouts count even in a currency with nothing earned any more (refunded since), which leaves less than nothing available.
  const currencies = [...new Set<string>([...rows.map((r) => r.currency), ...payouts.rows.map((p) => p.currency)])];
  return currencies.map((currency) => {
    const r = rows.find((x) => x.currency === currency);
    const gross = Number(r?.gross ?? 0);
    const fees = Number(r?.fees ?? 0);
    const held = Number(r?.held ?? 0);
    const paid = Number(payouts.rows.find((p) => p.currency === currency)?.paid ?? 0);
    return { currency, grossCents: gross, feeCents: fees, heldCents: held, availableCents: gross - fees - held - paid };
  });
}

function productDto(r: Record<string, any>) {
  return { id: r.id, kind: r.kind, title: r.title, description: r.description, priceCents: r.price_cents, currency: r.currency, inventory: r.inventory };
}
