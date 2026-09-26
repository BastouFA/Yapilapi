import type { PoolClient } from 'pg';
import type { PaymentRegistry } from './payments.ts';

/**
 * Hand back what a campaign didn't spend: rejected or ended campaigns can't
 * run again, so their remaining budget is refunded to the payments that funded
 * them, newest first. Call inside a transaction. The campaign's budget is
 * reduced by what was refunded, so it can never be spent afterwards.
 * Returns the cents refunded.
 */
export async function refundUnspentBudget(c: PoolClient, payments: PaymentRegistry, campaignId: string, actorId: string | null): Promise<number> {
  const camp = (await c.query(`SELECT budget_millicents, spent_millicents FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [campaignId])).rows[0];
  if (!camp) return 0;
  let owed = Math.floor((Number(camp.budget_millicents) - Number(camp.spent_millicents)) / 1000);
  if (owed <= 0) return 0;
  const funding = await c.query(
    `SELECT o.id AS order_id, pay.id AS payment_id, pay.provider, pay.provider_ref, pay.amount_cents,
            coalesce((SELECT sum(r.amount_cents) FROM refunds r WHERE r.payment_id = pay.id AND r.status = 'succeeded'), 0)::int AS refunded
     FROM orders o JOIN payments pay ON pay.order_id = o.id
     WHERE o.campaign_id = $1 AND o.purpose = 'ad_budget' AND o.status = 'paid'
     ORDER BY o.created_at DESC`,
    [campaignId],
  );
  let refunded = 0;
  for (const f of funding.rows) {
    if (owed <= 0) break;
    const take = Math.min(owed, f.amount_cents - f.refunded);
    if (take <= 0) continue;
    // The provider that took this payment gives it back.
    const provider = payments.byName(f.provider);
    const result = provider ? await provider.refund({ providerRef: f.provider_ref, amountCents: take }) : { status: 'failed' as const };
    await c.query(`INSERT INTO refunds (payment_id, amount_cents, reason, status, requested_by) VALUES ($1,$2,$3,$4,$5)`, [
      f.payment_id,
      take,
      'Unspent ad budget',
      result.status,
      actorId,
    ]);
    if (result.status !== 'succeeded') continue;
    refunded += take;
    owed -= take;
    if (f.refunded + take >= f.amount_cents) {
      await c.query(`UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`, [f.order_id]);
      await c.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [f.payment_id]);
    }
  }
  if (refunded)
    await c.query(
      `UPDATE ad_campaigns SET budget_millicents = budget_millicents - $2::bigint * 1000, refunded_millicents = refunded_millicents + $2::bigint * 1000 WHERE id = $1`,
      [campaignId, refunded],
    );
  return refunded;
}
