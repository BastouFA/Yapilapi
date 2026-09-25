import { reconcile, type Discrepancy, type LedgerRecord } from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { getPaymentProvider } from './provider.js';
import type { DbRow } from '../../lib/db-row.js';

export interface IntegrityIssue {
  type: string;
  ref: string;
  detail: string;
}

export interface ReconciliationReport {
  provider: string;
  from: string;
  to: string;
  ok: boolean;
  providerRecords: number;
  ledgerRecords: number;
  matched: number;
  discrepancies: Discrepancy[];
  /** Internal consistency checks that need no provider: ledger balance, ledger vs. payment/refund/payout rows, stuck webhooks. */
  integrity: IntegrityIssue[];
}

/**
 * Staff reconciliation: (1) provider-side records vs. what our ledger-backed rows say (pure `reconcile()`), (2) internal invariants.
 * Read-only. `ok` is true only when both lists are empty.
 */
export async function runReconciliation(
  ctx: AppContext,
  range: { from: Date; to: Date },
): Promise<ReconciliationReport> {
  const provider = getPaymentProvider(ctx);
  const providerRecords = await provider.listRecords(range);

  const ledger: LedgerRecord[] = [];
  const pays = await ctx.db.query<{ provider_ref: string; amount_cents: number; currency: string }>(
    `SELECT p.provider_ref, p.amount_cents, p.currency FROM payments p
      WHERE p.provider = $1 AND p.provider_ref IS NOT NULL AND p.created_at BETWEEN $2 AND $3
        AND p.status IN ('captured','partially_refunded','refunded','disputed')
        AND EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.kind = 'payment_captured' AND t.ref_type = 'payment' AND t.ref_id = p.id)`,
    [provider.name, range.from, range.to],
  );
  for (const p of pays.rows)
    ledger.push({
      kind: 'payment',
      ref: p.provider_ref,
      amount: p.amount_cents,
      currency: p.currency,
      status: 'captured',
    });
  const refunds = await ctx.db.query<{
    provider_ref: string;
    amount_cents: number;
    currency: string;
  }>(
    `SELECT r.provider_ref, r.amount_cents, r.currency FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE p.provider = $1 AND r.provider_ref IS NOT NULL AND r.status = 'succeeded' AND r.succeeded_at BETWEEN $2 AND $3`,
    [provider.name, range.from, range.to],
  );
  for (const r of refunds.rows)
    ledger.push({
      kind: 'refund',
      ref: r.provider_ref,
      amount: r.amount_cents,
      currency: r.currency,
      status: 'succeeded',
    });
  const payouts = await ctx.db.query<{
    provider_ref: string;
    amount_cents: number;
    currency: string;
  }>(
    `SELECT po.provider_ref, po.amount_cents, po.currency FROM payouts po JOIN payout_accounts a ON a.id = po.account_id
      WHERE a.provider = $1 AND po.provider_ref IS NOT NULL AND po.status = 'paid' AND po.created_at BETWEEN $2 AND $3`,
    [provider.name, range.from, range.to],
  );
  for (const po of payouts.rows)
    ledger.push({
      kind: 'payout',
      ref: po.provider_ref,
      amount: po.amount_cents,
      currency: po.currency,
      status: 'paid',
    });

  const result = reconcile(providerRecords, ledger);
  const integrity = await integrityChecks(ctx);
  return {
    provider: provider.name,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    ok: result.ok && integrity.length === 0,
    providerRecords: providerRecords.length,
    ledgerRecords: ledger.length,
    matched: result.matched,
    discrepancies: result.discrepancies,
    integrity,
  };
}

/** Invariants that must always hold; every row returned is a bug or an operational problem worth a human's attention. */
export async function integrityChecks(ctx: AppContext): Promise<IntegrityIssue[]> {
  const q = async (
    type: string,
    sql: string,
    detail: (r: DbRow) => string,
  ): Promise<IntegrityIssue[]> => {
    const { rows } = await ctx.db.query<DbRow>(sql);
    return rows.map((r) => ({ type, ref: String(r.ref), detail: detail(r) }));
  };
  const out = await Promise.all([
    q(
      'unbalanced_ledger_transaction',
      `SELECT transaction_id::text AS ref, sum(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END)::bigint AS d, sum(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END)::bigint AS c
         FROM ledger_entries GROUP BY transaction_id HAVING sum(CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END) <> 0 LIMIT 100`,
      (r) => `debits ${r.d} <> credits ${r.c}`,
    ),
    q(
      'captured_payment_without_ledger',
      `SELECT p.id::text AS ref, p.amount_cents FROM payments p WHERE p.status IN ('captured','partially_refunded','refunded','disputed')
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.kind = 'payment_captured' AND t.ref_type = 'payment' AND t.ref_id = p.id) LIMIT 100`,
      () => 'payment is captured but has no payment_captured ledger transaction',
    ),
    q(
      'refund_without_ledger',
      `SELECT r.id::text AS ref FROM refunds r WHERE r.status = 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.kind = 'refund' AND t.ref_type = 'refund' AND t.ref_id = r.id) LIMIT 100`,
      () => 'refund succeeded but has no refund ledger transaction',
    ),
    q(
      'refund_total_mismatch',
      `SELECT p.id::text AS ref, p.refunded_cents AS have, COALESCE((SELECT sum(r.amount_cents) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded'), 0)::bigint AS want
         FROM payments p WHERE p.status <> 'disputed' AND p.refunded_cents <> COALESCE((SELECT sum(r.amount_cents) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded'), 0)
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.kind = 'adjustment' AND t.ref_type = 'dispute_lost' AND t.ref_id IN (SELECT d.id FROM disputes d WHERE d.payment_id = p.id)) LIMIT 100`,
      (r) => `payment.refunded_cents ${r.have} <> sum of succeeded refunds ${r.want}`,
    ),
    q(
      'payout_without_ledger',
      `SELECT po.id::text AS ref FROM payouts po WHERE po.status IN ('pending','approved','held','paid')
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.kind = 'payout' AND t.ref_type = 'payout' AND t.ref_id = po.id) LIMIT 100`,
      () => 'payout is live but has no ledger debit',
    ),
    q(
      'failed_payout_not_reversed',
      `SELECT po.id::text AS ref FROM payouts po WHERE po.status = 'failed'
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.kind = 'adjustment' AND t.ref_type = 'payout_failed' AND t.ref_id = po.id) LIMIT 100`,
      () => 'payout failed but the ledger debit was not reversed',
    ),
    q(
      'auto_refund_failed',
      `SELECT r.id::text AS ref, r.failure_code FROM refunds r WHERE r.auto AND r.status IN ('failed','processing') AND r.created_at < now() - interval '5 minutes' LIMIT 100`,
      (r) =>
        `automatic refund is ${r.failure_code ?? 'stuck'}: the customer's money has not been returned`,
    ),
    q(
      'negative_seller_balance',
      `SELECT e.account AS ref, sum(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END)::bigint AS bal
         FROM ledger_entries e WHERE e.account LIKE 'seller:%' GROUP BY e.account HAVING sum(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END) < 0 LIMIT 100`,
      (r) => `seller payable balance is ${r.bal}`,
    ),
    q(
      'paid_order_without_captured_payment',
      `SELECT o.id::text AS ref FROM orders o WHERE o.status IN ('paid','fulfilled','completed')
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('captured','partially_refunded','refunded','disputed')) LIMIT 100`,
      () => 'order is paid but has no captured payment',
    ),
    q(
      'webhook_unprocessed',
      `SELECT w.id::text AS ref, w.event_type FROM payment_webhook_events w WHERE w.processed_at IS NULL AND w.received_at < now() - interval '5 minutes' LIMIT 100`,
      (r) => `${r.event_type} received but never processed`,
    ),
    q(
      'entitlement_failed',
      `SELECT e.id::text AS ref, e.kind, e.last_error FROM order_entitlements e WHERE e.status = 'pending' AND e.attempts >= 5 LIMIT 100`,
      (r) =>
        `${r.kind} entitlement still pending after repeated attempts: ${String(r.last_error ?? '').slice(0, 100)}`,
    ),
  ]);
  return out.flat();
}
