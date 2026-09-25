import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { analyzeText } from '../lib/moderation.ts';
import { audit, isEnabled, notify } from '../lib/services.ts';
import { isBlockedEitherWay, publicUserFrom } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const PLATFORM_FEE_BPS = 500;

/**
 * Creator economy: monthly subscriptions and tips, plus place reviews and
 * bookings. Money moves only through the payment provider; an order is marked
 * paid by the signed webhook, which then activates the subscription.
 */
export default async function economyModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const commerceOn = async () => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Payments');
  };

  async function createPaymentOrder(
    c: { query: typeof db.query },
    buyerId: string,
    payeeId: string,
    purpose: 'subscription' | 'tip',
    amountCents: number,
    currency: string,
    idempotencyKey: string,
  ) {
    const fee = Math.round((amountCents * PLATFORM_FEE_BPS) / 10_000);
    const { rows } = await c.query(
      `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key, purpose, payee_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [buyerId, amountCents, fee, currency, idempotencyKey, purpose, payeeId],
    );
    const orderId = rows[0].id as string;
    const intent = await ctx.payments.createIntent({ amountCents, currency, orderId, idempotencyKey });
    await c.query(`INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6)`, [
      orderId,
      ctx.payments.name,
      intent.providerRef,
      intent.status,
      amountCents,
      currency,
    ]);
    return { orderId, clientSecret: intent.clientSecret };
  }

  // ── Subscriptions ─────────────────────────────────────────────────────
  app.post('/v1/creator/plans', { preHandler: requireAuth }, async (req, reply) => {
    await commerceOn();
    const u = me(req);
    const input = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        description: z.string().trim().max(500).default(''),
        priceCents: z.number().int().min(100).max(100_000),
        currency: z.string().length(3).toUpperCase().default('USD'),
      }),
      req.body,
    );
    const count = await db.query(`SELECT count(*) AS n FROM creator_plans WHERE creator_id = $1 AND active`, [u.id]);
    if (Number(count.rows[0].n) >= 5) throw new AppError(409, 'conflict', 'You can have up to 5 plans.');
    const { rows } = await db.query(`INSERT INTO creator_plans (creator_id, name, description, price_cents, currency) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
      u.id,
      input.name,
      input.description,
      input.priceCents,
      input.currency,
    ]);
    await db.query(`UPDATE profiles SET mode = 'creator' WHERE user_id = $1 AND mode = 'personal'`, [u.id]);
    reply.code(201);
    return { plan: planDto(rows[0]) };
  });

  app.get('/v1/users/:id/plans', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rows } = await db.query(`SELECT * FROM creator_plans WHERE creator_id = $1 AND active ORDER BY price_cents`, [id]);
    const mine = req.user
      ? (
          await db.query(
            `SELECT plan_id, status, current_period_end FROM creator_subscriptions WHERE subscriber_id = $1 AND creator_id = $2 AND status IN ('pending','active')`,
            [req.user.id, id],
          )
        ).rows[0]
      : null;
    return { items: rows.map(planDto), mySubscription: mine ?? null };
  });

  app.post('/v1/creator/plans/:id/subscribe', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    await commerceOn();
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { idempotencyKey } = parse(z.object({ idempotencyKey: z.string().min(8).max(100) }), req.body);
    const plan = (await db.query(`SELECT * FROM creator_plans WHERE id = $1 AND active`, [id])).rows[0];
    if (!plan) throw notFound('Plan');
    if (plan.creator_id === u.id) throw badRequest("You can't subscribe to yourself.");
    if (await isBlockedEitherWay(db, u.id, plan.creator_id)) throw forbidden();
    const result = await tx(db, async (c) => {
      const existing = await c.query(
        `SELECT id, status FROM creator_subscriptions WHERE subscriber_id = $1 AND creator_id = $2 AND status IN ('pending','active')`,
        [u.id, plan.creator_id],
      );
      if (existing.rows[0]?.status === 'active') throw new AppError(409, 'conflict', "You're already subscribed.");
      if (existing.rows[0]) await c.query(`UPDATE creator_subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [existing.rows[0].id]);
      const pay = await createPaymentOrder(c, u.id, plan.creator_id, 'subscription', plan.price_cents, plan.currency, idempotencyKey);
      const { rows } = await c.query(
        `INSERT INTO creator_subscriptions (plan_id, subscriber_id, creator_id, order_id) VALUES ($1,$2,$3,$4) RETURNING id, status`,
        [id, u.id, plan.creator_id, pay.orderId],
      );
      return { subscription: rows[0], payment: { provider: ctx.payments.name, clientSecret: pay.clientSecret, orderId: pay.orderId } };
    });
    reply.code(201);
    return result;
  });

  app.get('/v1/me/subscriptions', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT s.id, s.status, s.current_period_end, p.name AS plan, p.price_cents, p.currency,
              pr.user_id AS c_id, pr.username AS c_username, pr.display_name AS c_display_name, pr.avatar_url AS c_avatar_url, pr.mode AS c_mode
       FROM creator_subscriptions s JOIN creator_plans p ON p.id = s.plan_id JOIN profiles pr ON pr.user_id = s.creator_id
       WHERE s.subscriber_id = $1 AND s.status IN ('pending','active') ORDER BY s.created_at DESC`,
      [me(req).id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        currentPeriodEnd: r.current_period_end,
        plan: r.plan,
        priceCents: r.price_cents,
        currency: r.currency,
        creator: publicUserFrom(r, 'c_'),
      })),
    };
  });

  app.post('/v1/creator/subscriptions/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    // Cancelling stops renewal; access continues until the paid period ends.
    const r = await db.query(
      `UPDATE creator_subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND subscriber_id = $2 AND status IN ('pending','active') RETURNING current_period_end`,
      [id, me(req).id],
    );
    if (!r.rowCount) throw notFound('Subscription');
    return { status: 'cancelled', accessUntil: r.rows[0].current_period_end };
  });

  app.get('/v1/creator/subscribers', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'cancelled') AS cancelled FROM creator_subscriptions WHERE creator_id = $1`,
      [me(req).id],
    );
    return { active: Number(rows[0].active), cancelled: Number(rows[0].cancelled) };
  });

  // ── Tips ──────────────────────────────────────────────────────────────
  app.post('/v1/users/:id/tips', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    await commerceOn();
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(
      z.object({
        amountCents: z.number().int().min(100).max(50_000),
        currency: z.string().length(3).toUpperCase().default('USD'),
        message: z.string().trim().max(200).default(''),
        postId: z.string().uuid().optional(),
        liveId: z.string().uuid().optional(),
        idempotencyKey: z.string().min(8).max(100),
      }),
      req.body,
    );
    if (id === u.id) throw badRequest("You can't tip yourself.");
    if (await isBlockedEitherWay(db, u.id, id)) throw forbidden();
    if (input.message && analyzeText(input.message).risk !== 'normal') throw new AppError(422, 'content_blocked', "That message can't be sent.");
    const result = await tx(db, async (c) => {
      const pay = await createPaymentOrder(c, u.id, id, 'tip', input.amountCents, input.currency, input.idempotencyKey);
      await c.query(`INSERT INTO tips (from_id, to_id, post_id, live_id, message, order_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
        u.id,
        id,
        input.postId ?? null,
        input.liveId ?? null,
        input.message,
        pay.orderId,
      ]);
      return { payment: { provider: ctx.payments.name, clientSecret: pay.clientSecret, orderId: pay.orderId } };
    });
    reply.code(201);
    return result;
  });

  // ── Place reviews ─────────────────────────────────────────────────────
  app.get('/v1/places/:id/reviews', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rows } = await db.query(
      `SELECT r.id, r.rating, r.body, r.created_at, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM place_reviews r JOIN profiles pr ON pr.user_id = r.author_id WHERE r.place_id = $1 AND r.moderation_status IN ('normal','review') ORDER BY r.created_at DESC LIMIT 100`,
      [id],
    );
    const stats = (
      await db.query(
        `SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM place_reviews WHERE place_id = $1 AND moderation_status IN ('normal','review')`,
        [id],
      )
    ).rows[0];
    return {
      average: stats.avg === null ? null : Number(stats.avg),
      count: Number(stats.n),
      items: rows.map((r) => ({ id: r.id, rating: r.rating, body: r.body, createdAt: r.created_at, author: publicUserFrom(r, 'a_') })),
    };
  });

  app.put('/v1/places/:id/reviews', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).default('') }), req.body);
    const place = (
      await db.query(`SELECT p.id, b.owner_id FROM places p LEFT JOIN businesses b ON b.id = p.business_id WHERE p.id = $1 AND p.deleted_at IS NULL`, [id])
    ).rows[0];
    if (!place) throw notFound('Place');
    if (place.owner_id === u.id) throw forbidden("You can't review your own place.");
    const risk = analyzeText(input.body).risk;
    if (risk === 'escalate') throw new AppError(422, 'content_blocked', "This review can't be posted.");
    await db.query(
      `INSERT INTO place_reviews (place_id, author_id, rating, body, moderation_status) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (place_id, author_id) DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, moderation_status = EXCLUDED.moderation_status, updated_at = now()`,
      [id, u.id, input.rating, input.body, risk === 'normal' ? 'normal' : risk === 'review' ? 'review' : 'restricted'],
    );
    return { ok: true };
  });

  // ── Bookings ──────────────────────────────────────────────────────────
  app.post('/v1/places/:id/bookings', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(
      z.object({ partySize: z.number().int().min(1).max(50), startsAt: z.string().datetime({ offset: true }), note: z.string().trim().max(500).default('') }),
      req.body,
    );
    if (new Date(input.startsAt) < new Date()) throw badRequest('Choose a time in the future.');
    const place = (
      await db.query(
        `SELECT p.id, p.name, p.booking_capacity, b.owner_id FROM places p JOIN businesses b ON b.id = p.business_id WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [id],
      )
    ).rows[0];
    if (!place) throw badRequest('This place does not take bookings on YAPILAPI.');
    if (place.booking_capacity) {
      const taken = await db.query(
        `SELECT coalesce(sum(party_size), 0) AS n FROM bookings WHERE place_id = $1 AND status IN ('requested','confirmed') AND starts_at BETWEEN $2::timestamptz - interval '90 minutes' AND $2::timestamptz + interval '90 minutes'`,
        [id, input.startsAt],
      );
      if (Number(taken.rows[0].n) + input.partySize > place.booking_capacity)
        throw new AppError(409, 'fully_booked', 'That time is fully booked. Try another time.');
    }
    const { rows } = await db.query(
      `INSERT INTO bookings (place_id, user_id, party_size, starts_at, note) VALUES ($1,$2,$3,$4,$5) RETURNING id, status, party_size, starts_at`,
      [id, u.id, input.partySize, input.startsAt, input.note],
    );
    await notify(db, ctx.realtime, {
      userId: place.owner_id,
      category: 'commerce',
      type: 'booking_request',
      actorId: u.id,
      entityType: 'booking',
      entityId: rows[0].id,
      data: { partySize: input.partySize, startsAt: input.startsAt },
    });
    reply.code(201);
    return { booking: rows[0] };
  });

  app.get('/v1/me/bookings', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT bk.id, bk.status, bk.party_size, bk.starts_at, bk.note, p.id AS place_id, p.name AS place_name FROM bookings bk JOIN places p ON p.id = bk.place_id
       WHERE bk.user_id = $1 ORDER BY bk.starts_at DESC LIMIT 100`,
      [me(req).id],
    );
    return { items: rows };
  });

  app.get('/v1/places/:id/bookings', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const own = await db.query(`SELECT 1 FROM places p JOIN businesses b ON b.id = p.business_id WHERE p.id = $1 AND b.owner_id = $2`, [id, me(req).id]);
    if (!own.rowCount) throw notFound('Place');
    const { rows } = await db.query(
      `SELECT bk.id, bk.status, bk.party_size, bk.starts_at, bk.note, pr.display_name AS guest FROM bookings bk JOIN profiles pr ON pr.user_id = bk.user_id
       WHERE bk.place_id = $1 AND bk.starts_at > now() - interval '1 day' ORDER BY bk.starts_at`,
      [id],
    );
    return { items: rows };
  });

  app.post('/v1/bookings/:id/decide', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { confirm } = parse(z.object({ confirm: z.boolean() }), req.body);
    const r = await db.query(
      `UPDATE bookings bk SET status = $3, decided_at = now() FROM places p JOIN businesses b ON b.id = p.business_id
       WHERE bk.id = $1 AND p.id = bk.place_id AND b.owner_id = $2 AND bk.status = 'requested' RETURNING bk.user_id`,
      [id, u.id, confirm ? 'confirmed' : 'declined'],
    );
    if (!r.rowCount) throw notFound('Booking');
    await notify(db, ctx.realtime, {
      userId: r.rows[0].user_id,
      category: 'commerce',
      type: 'booking_decided',
      actorId: u.id,
      entityType: 'booking',
      entityId: id,
      data: { confirmed: confirm },
    });
    await audit(db, { actorId: u.id, action: `booking.${confirm ? 'confirm' : 'decline'}`, entityType: 'booking', entityId: id });
    return { status: confirm ? 'confirmed' : 'declined' };
  });

  app.post('/v1/bookings/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await db.query(
      `UPDATE bookings SET status = 'cancelled', decided_at = now() WHERE id = $1 AND user_id = $2 AND status IN ('requested','confirmed')`,
      [id, me(req).id],
    );
    if (!r.rowCount) throw notFound('Booking');
    return { status: 'cancelled' };
  });
}

function planDto(r: Record<string, any>) {
  return { id: r.id, name: r.name, description: r.description, priceCents: r.price_cents, currency: r.currency };
}
