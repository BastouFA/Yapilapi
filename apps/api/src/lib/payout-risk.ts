import type { Pool, PoolClient } from 'pg';

type Q = Pick<Pool | PoolClient, 'query'>;

/**
 * Signs a payout deserves a closer look before it's approved. They warn, they don't block: the team decides.
 *   new_account          the account is under 14 days old
 *   new_payout_account   where the money goes was set up or changed in the last 3 days (a stolen account
 *                        often changes the bank, then withdraws)
 *   one_buyer            over half of the last 30 days' earnings came from one buyer (paying yourself from
 *                        another account, often with stolen cards)
 *   new_buyers           over half came from buyers whose accounts were under a week old when they paid
 *   refunds              over 1 in 10 of their orders in the last 90 days were refunded or disputed
 *   first_payout         nothing has been paid out to them before
 */
export const PAYOUT_RISKS = ['new_account', 'new_payout_account', 'one_buyer', 'new_buyers', 'refunds', 'first_payout'] as const;
export type PayoutRisk = (typeof PAYOUT_RISKS)[number];

export async function payoutRisks(q: Q, userId: string, payoutAccountId: string | null): Promise<PayoutRisk[]> {
  const { rows } = await q.query(
    `WITH sales AS (
       SELECT o.id, o.buyer_id, o.status, o.paid_at, o.total_cents AS cents
       FROM orders o
       WHERE (o.payee_id = $1 OR EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id AND p.seller_id = $1))
         AND o.status IN ('paid', 'refunded') AND o.created_at > now() - interval '90 days'
     ), recent AS (
       SELECT s.buyer_id, s.cents, bu.created_at > s.paid_at - interval '7 days' AS new_buyer
       FROM sales s JOIN users bu ON bu.id = s.buyer_id WHERE s.status = 'paid' AND s.paid_at > now() - interval '30 days'
     )
     SELECT
       (SELECT created_at > now() - interval '14 days' FROM users WHERE id = $1) AS new_account,
       coalesce((SELECT greatest(created_at, updated_at) > now() - interval '3 days' FROM payout_accounts WHERE id = $2), false) AS new_payout_account,
       coalesce((SELECT max(t) FROM (SELECT sum(cents) AS t FROM recent GROUP BY buyer_id) x), 0) AS top_buyer,
       coalesce((SELECT sum(cents) FROM recent WHERE new_buyer), 0) AS from_new_buyers,
       coalesce((SELECT sum(cents) FROM recent), 0) AS recent_total,
       (SELECT count(*) FILTER (WHERE status = 'refunded') FROM sales) AS refunded,
       (SELECT count(*) FROM sales) AS sold,
       NOT EXISTS (SELECT 1 FROM payouts WHERE user_id = $1 AND status = 'paid') AS first_payout`,
    [userId, payoutAccountId],
  );
  const r = rows[0];
  const total = Number(r.recent_total);
  const risks: PayoutRisk[] = [];
  if (r.new_account) risks.push('new_account');
  if (r.new_payout_account) risks.push('new_payout_account');
  if (total > 0 && Number(r.top_buyer) * 2 > total) risks.push('one_buyer');
  if (total > 0 && Number(r.from_new_buyers) * 2 > total) risks.push('new_buyers');
  if (Number(r.sold) > 0 && Number(r.refunded) * 10 > Number(r.sold)) risks.push('refunds');
  if (r.first_payout) risks.push('first_payout');
  return risks;
}
