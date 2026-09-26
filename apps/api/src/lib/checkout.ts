import type { Pool, PoolClient } from 'pg';
import type { PaymentRegistry } from './payments.ts';
import { revokePlusForOrder } from './plus.ts';

type Q = Pick<Pool | PoolClient, 'query'>;

/**
 * Start paying for an order that was just created: pick the provider for its
 * currency (Paystack for NGN, GHS, KES and ZAR when configured, otherwise the
 * default), create the intent and record the payment. Call inside the
 * transaction that created the order. Returns what the checkout needs.
 */
export async function startPayment(
  c: Q,
  payments: PaymentRegistry,
  input: { orderId: string; buyerId: string; amountCents: number; currency: string; idempotencyKey: string },
): Promise<{ provider: string; clientSecret: string }> {
  const provider = payments.forCurrency(input.currency);
  const email = (await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [input.buyerId])).rows[0]?.email;
  const intent = await provider.createIntent({
    amountCents: input.amountCents,
    currency: input.currency,
    orderId: input.orderId,
    idempotencyKey: input.idempotencyKey,
    email,
  });
  await c.query(`INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6)`, [
    input.orderId,
    provider.name,
    intent.providerRef,
    intent.status,
    input.amountCents,
    input.currency,
  ]);
  return { provider: provider.name, clientSecret: intent.clientSecret };
}

/**
 * Refund a paid order in full through the provider that took the payment, and
 * undo what it paid for (ad budget, Plus days, a service booking). Call inside
 * a transaction; the order row should already be locked by the caller.
 */
export async function refundOrder(
  c: PoolClient,
  payments: PaymentRegistry,
  orderId: string,
  actorId: string | null,
  reason: string | null,
): Promise<'succeeded' | 'failed' | 'not_paid'> {
  const r = (
    await c.query(
      `SELECT o.status, pay.id AS payment_id, pay.provider, pay.provider_ref, pay.amount_cents
       FROM orders o JOIN payments pay ON pay.order_id = o.id WHERE o.id = $1 ORDER BY pay.created_at DESC LIMIT 1`,
      [orderId],
    )
  ).rows[0];
  if (!r || r.status !== 'paid') return 'not_paid';
  const provider = payments.byName(r.provider);
  const result = provider ? await provider.refund({ providerRef: r.provider_ref, amountCents: r.amount_cents }) : { status: 'failed' as const };
  await c.query(`INSERT INTO refunds (payment_id, amount_cents, reason, status, requested_by) VALUES ($1,$2,$3,$4,$5)`, [
    r.payment_id,
    r.amount_cents,
    reason,
    result.status,
    actorId,
  ]);
  if (result.status !== 'succeeded') return 'failed';
  // Refunding ad budget takes back what the campaign hasn't spent yet.
  await c.query(
    `UPDATE ad_campaigns SET budget_millicents = greatest(spent_millicents, budget_millicents - $2::bigint * 1000)
     FROM orders o WHERE o.id = $1 AND o.purpose = 'ad_budget' AND ad_campaigns.id = o.campaign_id`,
    [orderId, r.amount_cents],
  );
  // Refunding a Plus month takes those days back.
  await revokePlusForOrder(c, orderId);
  // A refunded subscription ends now, and with it access to subscriber-only posts.
  await c.query(
    `UPDATE creator_subscriptions SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), current_period_end = least(current_period_end, now())
     WHERE order_id = $1 AND status IN ('pending', 'active', 'cancelled')`,
    [orderId],
  );
  // A refunded service booking can't go ahead.
  await c.query(
    `UPDATE bookings SET status = 'cancelled', decided_at = coalesce(decided_at, now()) WHERE order_id = $1 AND status IN ('pending_payment', 'requested', 'confirmed')`,
    [orderId],
  );
  await c.query(`UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`, [orderId]);
  await c.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [r.payment_id]);
  return 'succeeded';
}
