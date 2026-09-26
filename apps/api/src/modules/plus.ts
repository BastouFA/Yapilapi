import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, featureDisabled, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { MAX_RESUMABLE_BYTES, PLUS_DAYS, PLUS_MAX_AHEAD_DAYS, PLUS_MAX_RESUMABLE_BYTES, PLUS_REEL_MAX_MS, REEL_MAX_MS } from '../lib/plus.ts';
import { isEnabled, track } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const MB = 1024 * 1024;

/**
 * YAPILAPI Plus: one month (30 days) at a time, paid through the normal
 * checkout. The signed payment webhook adds the days (see commerce.ts). There
 * is no automatic renewal, so there is nothing to cancel: Plus simply ends on
 * the date shown unless you buy another month.
 */
export default async function plusModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const price = { priceCents: ctx.config.PLUS_PRICE_CENTS, currency: ctx.config.PLUS_CURRENCY };

  app.get('/v1/plus', async (req) => {
    const benefits = [
      { id: 'no_ads' },
      { id: 'long_reels', minutes: PLUS_REEL_MAX_MS / 60_000, standardMinutes: REEL_MAX_MS / 60_000 },
      { id: 'big_uploads', megabytes: PLUS_MAX_RESUMABLE_BYTES / MB, standardMegabytes: MAX_RESUMABLE_BYTES / MB },
      { id: 'badge' },
    ];
    const base = { ...price, days: PLUS_DAYS, autoRenews: false, benefits };
    if (!req.user) return { ...base, status: null, history: [] };
    const userId = req.user.id;
    const [status, history] = await Promise.all([
      db.query(
        `SELECT plus_until, plus_until > now() AS active, plus_until < now() + make_interval(days => $2) AS can_extend
         FROM profiles WHERE user_id = $1`,
        [userId, PLUS_MAX_AHEAD_DAYS - PLUS_DAYS],
      ),
      db.query(
        `SELECT source, days, starts_at, ends_at, created_at FROM plus_grants WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 24`,
        [userId],
      ),
    ]);
    const s = status.rows[0];
    return {
      ...base,
      status: {
        active: s?.active === true,
        // Only a date in the future is an end date; a past one is shown as "no Plus".
        until: s?.active ? (s.plus_until as Date).toISOString() : null,
        canExtend: s?.can_extend !== false,
      },
      history: history.rows.map((r) => ({
        source: r.source as 'purchase' | 'referral',
        days: r.days as number,
        startsAt: (r.starts_at as Date).toISOString(),
        endsAt: (r.ends_at as Date).toISOString(),
        createdAt: (r.created_at as Date).toISOString(),
      })),
    };
  });

  /** Start paying for a month of Plus. The days are added when the payment provider confirms it. */
  app.post('/v1/plus/checkout', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Payments');
    const u = me(req);
    const { idempotencyKey } = parse(z.object({ idempotencyKey: z.string().min(8).max(100) }), req.body);
    const result = await tx(db, async (c) => {
      const s = await c.query(`SELECT plus_until < now() + make_interval(days => $2) OR plus_until IS NULL AS ok FROM profiles WHERE user_id = $1 FOR UPDATE`, [
        u.id,
        PLUS_MAX_AHEAD_DAYS - PLUS_DAYS,
      ]);
      if (!s.rows[0]?.ok)
        throw new AppError(409, 'conflict', 'You already have Plus for most of the next year. You can add another month closer to the end date.');
      const again = await c.query(`SELECT id FROM orders WHERE buyer_id = $1 AND idempotency_key = $2`, [u.id, idempotencyKey]);
      if (again.rowCount) throw new AppError(409, 'conflict', 'This checkout was already started. Refresh and try again.');
      // The whole amount is YAPILAPI's, like ad budget: there is no payee.
      const { rows } = await c.query(
        `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key, purpose) VALUES ($1,$2,$2,$3,$4,'plus') RETURNING id`,
        [u.id, price.priceCents, price.currency, idempotencyKey],
      );
      const orderId = rows[0].id as string;
      const intent = await ctx.payments.createIntent({ amountCents: price.priceCents, currency: price.currency, orderId, idempotencyKey });
      await c.query(`INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6)`, [
        orderId,
        ctx.payments.name,
        intent.providerRef,
        intent.status,
        price.priceCents,
        price.currency,
      ]);
      return { orderId, clientSecret: intent.clientSecret };
    });
    track(db, u.id, 'plus_checkout');
    reply.code(201);
    return { ...price, days: PLUS_DAYS, payment: { provider: ctx.payments.name, orderId: result.orderId, clientSecret: result.clientSecret } };
  });
}
