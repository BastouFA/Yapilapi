import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { createBusinessSchema, createOrderSchema, createPlaceSchema, createProductSchema, PLACE_CATEGORIES } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, isEnabled, notify, track } from '../lib/services.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { publicUserFrom } from '../lib/users.ts';
import { EVENT_SELECT, toEvent } from './events.ts';
import { eventVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const PLATFORM_FEE_BPS = 500; // 5%

export default async function commerceModule(app: FastifyInstance, ctx: AppContext) {
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
    return { place: await loadPlace(rows[0].id) };
  });

  async function loadPlace(id: string) {
    const { rows } = await db.query(
      `SELECT pl.id, pl.name, pl.category, pl.description, pl.address, pl.city, pl.country, pl.lat, pl.lng, pl.hours,
              b.slug AS business_slug, b.name AS business_name
       FROM places pl LEFT JOIN businesses b ON b.id = pl.business_id WHERE pl.id = $1 AND pl.deleted_at IS NULL`,
      [id],
    );
    if (!rows[0]) throw notFound('Place');
    const r = rows[0];
    return { ...r, business: r.business_slug ? { slug: r.business_slug, name: r.business_name } : null, business_slug: undefined, business_name: undefined };
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
    const place = await loadPlace(id);
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

  // ── Products ──────────────────────────────────────────────────────────
  app.post('/v1/products', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Commerce');
    const u = me(req);
    const input = parse(createProductSchema, req.body);
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
        `SELECT id, seller_id, price_cents, currency, inventory FROM products WHERE id = ANY($1) AND deleted_at IS NULL AND status = 'active' FOR UPDATE`,
        [ids],
      );
      if (products.length !== new Set(ids).size) throw notFound('One of those products');
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
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [u.id, total, fee, [...currencies][0], input.idempotencyKey],
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
      const intent = await ctx.payments.createIntent({ amountCents: total, currency: [...currencies][0], orderId, idempotencyKey: input.idempotencyKey });
      await c.query(`INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6)`, [
        orderId,
        ctx.payments.name,
        intent.providerRef,
        intent.status,
        total,
        [...currencies][0],
      ]);
      await audit(c, { actorId: u.id, action: 'order.create', entityType: 'order', entityId: orderId, metadata: { total } });
      return { orderId, clientSecret: intent.clientSecret };
    });
    reply.code(201);
    return { order: await loadOrder(order.orderId, u.id), payment: { provider: ctx.payments.name, clientSecret: order.clientSecret } };
  });

  async function loadOrder(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_cents, o.platform_fee_cents, o.currency, o.created_at,
         (SELECT json_agg(json_build_object('productId', oi.product_id, 'title', p.title, 'quantity', oi.quantity, 'unitCents', oi.unit_cents))
          FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) AS items
       FROM orders o WHERE o.id = $1 AND (o.buyer_id = $2 OR EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id AND p.seller_id = $2))`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Order');
    const r = rows[0];
    return {
      id: r.id,
      status: r.status,
      totalCents: r.total_cents,
      platformFeeCents: r.platform_fee_cents,
      currency: r.currency,
      items: r.items,
      createdAt: r.created_at,
    };
  }

  app.get('/v1/orders', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT id FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT 50`, [me(req).id]);
    return { items: await Promise.all(rows.map((r) => loadOrder(r.id, me(req).id))) };
  });

  app.get('/v1/orders/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { order: await loadOrder(id, me(req).id) };
  });

  /**
   * Provider webhook. Signature is verified before anything is read; each
   * provider event id is processed once (replays are acknowledged and ignored).
   */
  app.post('/v1/payments/webhook/:provider', { config: { rateLimit: false, rawBody: true } }, async (req, reply) => {
    const { provider } = parse(z.object({ provider: z.string() }), req.params);
    if (provider !== ctx.payments.name) throw notFound('Payment provider');
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    let event;
    try {
      event = ctx.payments.verifyWebhook(raw, req.headers['x-signature'] as string | undefined);
    } catch {
      reply.code(400);
      return { error: { code: 'bad_signature', message: 'Webhook signature is invalid.' } };
    }
    const fresh = await db.query(`INSERT INTO payment_webhook_events (id, provider, type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
      event.id,
      provider,
      event.type,
      event,
    ]);
    if (!fresh.rowCount) return { ok: true, duplicate: true };
    await tx(db, async (c) => {
      const pay = await c.query(`SELECT id, order_id, amount_cents, status FROM payments WHERE provider = $1 AND provider_ref = $2 FOR UPDATE`, [
        provider,
        event.providerRef,
      ]);
      const p = pay.rows[0];
      if (!p) return;
      if (event.type === 'payment.succeeded' && p.status !== 'succeeded') {
        // Reconciliation: the amount the provider captured must match what we charged.
        if (event.amountCents !== undefined && event.amountCents !== p.amount_cents) {
          await audit(c, {
            action: 'payment.amount_mismatch',
            entityType: 'payment',
            entityId: p.id,
            metadata: { expected: p.amount_cents, got: event.amountCents },
          });
          return;
        }
        await c.query(`UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = $1`, [p.id]);
        await c.query(`UPDATE orders SET status = 'paid', updated_at = now() WHERE id = $1`, [p.order_id]);
        await c.query(
          `UPDATE products pd SET inventory = pd.inventory - oi.quantity FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = pd.id AND pd.inventory IS NOT NULL`,
          [p.order_id],
        );
        const o = (await c.query(`SELECT buyer_id, purpose, payee_id FROM orders WHERE id = $1`, [p.order_id])).rows[0];
        track(db, o.buyer_id, 'order_paid', { purpose: o.purpose });
        if (o.purpose === 'subscription') {
          await c.query(
            `UPDATE creator_subscriptions SET status = 'active', current_period_end = now() + interval '30 days' WHERE order_id = $1 AND status = 'pending'`,
            [p.order_id],
          );
          await notify(c, ctx.realtime, {
            userId: o.payee_id,
            category: 'creators',
            type: 'subscription_started',
            actorId: o.buyer_id,
            entityType: 'order',
            entityId: p.order_id,
          });
        }
        if (o.purpose === 'tip')
          await notify(c, ctx.realtime, {
            userId: o.payee_id,
            category: 'creators',
            type: 'tip_received',
            actorId: o.buyer_id,
            entityType: 'order',
            entityId: p.order_id,
          });
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
      }
    });
    await db.query(`UPDATE payment_webhook_events SET processed_at = now() WHERE id = $1`, [event.id]);
    return { ok: true };
  });

  /** Refund workflow: the seller or a platform admin can refund a paid order. */
  app.post('/v1/orders/:id/refund', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    return tx(db, async (c) => {
      const o = await c.query(
        `SELECT o.id, o.status, pay.id AS payment_id, pay.provider_ref, pay.amount_cents,
                EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id AND p.seller_id = $2) AS is_seller
         FROM orders o JOIN payments pay ON pay.order_id = o.id WHERE o.id = $1 FOR UPDATE OF o`,
        [id, u.id],
      );
      const r = o.rows[0];
      if (!r || (!r.is_seller && u.role !== 'admin')) throw notFound('Order');
      if (r.status !== 'paid') throw badRequest('Only paid orders can be refunded.');
      const result = await ctx.payments.refund({ providerRef: r.provider_ref, amountCents: r.amount_cents });
      await c.query(`INSERT INTO refunds (payment_id, amount_cents, reason, status, requested_by) VALUES ($1,$2,$3,$4,$5)`, [
        r.payment_id,
        r.amount_cents,
        reason ?? null,
        result.status,
        u.id,
      ]);
      if (result.status === 'succeeded') {
        await c.query(`UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`, [id]);
        await c.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [r.payment_id]);
      }
      await audit(c, { actorId: u.id, action: 'order.refund', entityType: 'order', entityId: id, metadata: { status: result.status } });
      return { status: result.status };
    });
  });

  /** Seller earnings and payout requests. Payouts need verification before they are paid. */
  app.get('/v1/me/earnings', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT currency, sum(gross) AS gross, sum(fees) AS fees FROM (
         SELECT o.currency, oi.quantity * oi.unit_cents AS gross, round(oi.quantity * oi.unit_cents * ${PLATFORM_FEE_BPS} / 10000.0) AS fees
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
         WHERE p.seller_id = $1 AND o.status = 'paid'
         UNION ALL
         SELECT o.currency, o.total_cents, o.platform_fee_cents FROM orders o WHERE o.payee_id = $1 AND o.status = 'paid' AND o.purpose IN ('subscription', 'tip')
       ) x GROUP BY currency`,
      [u.id],
    );
    const payouts = await db.query(`SELECT currency, sum(amount_cents) AS paid FROM payouts WHERE user_id = $1 AND status <> 'failed' GROUP BY currency`, [
      u.id,
    ]);
    return {
      balances: rows.map((r) => {
        const net = Number(r.gross) - Number(r.fees);
        const paid = Number(payouts.rows.find((p) => p.currency === r.currency)?.paid ?? 0);
        return { currency: r.currency, grossCents: Number(r.gross), feeCents: Number(r.fees), availableCents: net - paid };
      }),
    };
  });

  app.post('/v1/me/payouts', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(z.object({ amountCents: z.number().int().positive(), currency: z.string().length(3).toUpperCase() }), req.body);
    if (!u.emailVerified) throw forbidden('Verify your email before requesting a payout.');
    const { rows } = await db.query(`INSERT INTO payouts (user_id, amount_cents, currency) VALUES ($1,$2,$3) RETURNING id, status`, [
      u.id,
      input.amountCents,
      input.currency,
    ]);
    await audit(db, { actorId: u.id, action: 'payout.request', entityType: 'payout', entityId: rows[0].id, metadata: input });
    reply.code(201);
    return { payout: rows[0], message: 'Payout requested. It will be paid after verification.' };
  });

  app.get('/v1/admin/payouts', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(`SELECT id, user_id, amount_cents, currency, status, created_at FROM payouts WHERE status = 'pending' ORDER BY created_at`);
    return { items: rows };
  });

  app.post('/v1/admin/payouts/:id/verify', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE payouts SET status = 'verified' WHERE id = $1 AND status = 'pending'`, [id]);
    if (!r.rowCount) throw notFound('Payout');
    await audit(db, { actorId: me(req).id, action: 'payout.verify', entityType: 'payout', entityId: id });
    return { status: 'verified' };
  });
}

function productDto(r: Record<string, any>) {
  return { id: r.id, kind: r.kind, title: r.title, description: r.description, priceCents: r.price_cents, currency: r.currency, inventory: r.inventory };
}
