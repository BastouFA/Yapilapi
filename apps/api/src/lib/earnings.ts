import type { Pool, PoolClient } from 'pg';
import { EARNINGS_HOLD_DAYS } from '@yapilapi/shared';
import { sellerFeesSql } from './checkout.ts';

/**
 * What someone earned per currency after the platform fee and payment processing. A sale's share is held for EARNINGS_HOLD_DAYS
 * after it was paid (heldCents); what's left once payouts (other than failed ones) are taken off can be
 * paid out (availableCents).
 */
export async function earnings(q: Pick<Pool | PoolClient, 'query'>, userId: string) {
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
