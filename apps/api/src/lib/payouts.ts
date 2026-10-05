import type { Pool, PoolClient } from 'pg';
import type { PaymentRegistry, WebhookEvent } from './payments.ts';
import type { RealtimeHub } from './realtime.ts';
import { audit, notify } from './services.ts';

type Q = Pool | PoolClient;

/** The job that sends a verified payout (see sendPayout). */
export const PAYOUT_SEND_JOB = 'payout.send';

/**
 * Where a creator's payouts in a currency go: the provider that takes that currency, and their account with it.
 * Stripe keeps one account for all its currencies (currency NULL); Paystack one recipient per currency.
 */
export async function payoutAccountFor(q: Q, payments: PaymentRegistry, userId: string, currency: string) {
  const provider = payments.forCurrency(currency);
  const rail = provider.payouts;
  if (!rail) return { provider: provider.name, rail: null, account: null };
  const { rows } = await q.query<{ id: string; account_ref: string; label: string | null; ready: boolean }>(
    `SELECT id, account_ref, label, ready FROM payout_accounts
     WHERE user_id = $1 AND provider = $2 AND ${rail.kind === 'hosted' ? 'currency IS NULL' : 'currency = $3'}`,
    rail.kind === 'hosted' ? [userId, provider.name] : [userId, provider.name, currency],
  );
  return { provider: provider.name, rail, account: rows[0] ?? null };
}

/**
 * Send a verified payout (the payout.send job). The reference is the payout's own, so a retry after a
 * timeout never pays twice: Stripe and Paystack both refuse a second transfer with the same one.
 */
export async function sendPayout(db: Pool, payments: PaymentRegistry, realtime: RealtimeHub, payoutId: string) {
  const p = (
    await db.query<{ user_id: string; amount_cents: number; currency: string; status: string }>(
      `SELECT user_id, amount_cents, currency, status FROM payouts WHERE id = $1`,
      [payoutId],
    )
  ).rows[0];
  if (!p || p.status !== 'verified') return;
  const currency = p.currency.trim();
  const { provider, rail, account } = await payoutAccountFor(db, payments, p.user_id, currency);
  if (!rail || !account?.ready) {
    await failPayout(db, realtime, payoutId, 'There is no payout account ready for this currency.');
    return;
  }
  const reference = `ypl-payout-${payoutId}`;
  await db.query(`UPDATE payouts SET provider = $2, reference = $3 WHERE id = $1`, [payoutId, provider, reference]);
  // Throws on a network error or a refusal: the job tries again later with the same reference.
  const sent = await rail.transfer({ accountRef: account.account_ref, amountCents: p.amount_cents, currency, reference });
  await db.query(`UPDATE payouts SET status = $2, provider_ref = $3, paid_at = CASE WHEN $2 = 'paid' THEN now() END WHERE id = $1 AND status = 'verified'`, [
    payoutId,
    sent.status,
    sent.providerRef,
  ]);
  if (sent.status === 'paid') await tellPaid(db, realtime, p.user_id, payoutId);
}

async function tellPaid(q: Q, realtime: RealtimeHub, userId: string, payoutId: string) {
  await notify(q, realtime, { userId, category: 'creators', type: 'payout_paid', entityType: 'payout', entityId: payoutId });
}

/** A payout that won't go through: the money goes back to the creator's balance, and they hear why. */
export async function failPayout(q: Q, realtime: RealtimeHub, payoutId: string, reason: string) {
  const { rows } = await q.query<{ user_id: string }>(
    `UPDATE payouts SET status = 'failed', failure_reason = $2 WHERE id = $1 AND status <> 'failed' RETURNING user_id`,
    [payoutId, reason],
  );
  if (!rows[0]) return;
  await audit(q, { action: 'payout.failed', entityType: 'payout', entityId: payoutId, metadata: { reason } });
  await notify(q, realtime, { userId: rows[0].user_id, category: 'creators', type: 'payout_failed', entityType: 'payout', entityId: payoutId });
}

/**
 * A payout provider's webhook: a transfer that arrived or bounced, or a hosted account that became (or stopped
 * being) able to take payouts. Call inside the webhook's transaction. Returns whether the event was a payout one.
 */
export async function applyPayoutEvent(c: PoolClient, realtime: RealtimeHub, provider: string, event: WebhookEvent): Promise<boolean> {
  if (event.type === 'payout_account.updated') {
    await c.query(`UPDATE payout_accounts SET ready = $3, updated_at = now() WHERE provider = $1 AND account_ref = $2`, [
      provider,
      event.providerRef,
      !!event.ready,
    ]);
    return true;
  }
  if (event.type !== 'payout.paid' && event.type !== 'payout.failed') return false;
  // Paystack sends our reference back; Stripe the transfer's id, which is the payout's provider_ref.
  const p = (
    await c.query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, status FROM payouts WHERE provider = $1 AND (reference = $2 OR provider_ref = $2) FOR UPDATE`,
      [provider, event.providerRef],
    )
  ).rows[0];
  if (!p) return true;
  if (event.type === 'payout.paid') {
    const r = await c.query(`UPDATE payouts SET status = 'paid', paid_at = now() WHERE id = $1 AND status IN ('verified', 'processing')`, [p.id]);
    if (r.rowCount) await tellPaid(c, realtime, p.user_id, p.id);
  } else {
    await failPayout(c, realtime, p.id, event.reason ?? 'The payout did not go through.');
  }
  return true;
}
