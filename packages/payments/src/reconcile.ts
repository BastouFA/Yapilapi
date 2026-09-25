import type { ProviderRecord } from './types.js';

/** What our ledger says happened, per external object. */
export interface LedgerRecord {
  kind: 'payment' | 'refund' | 'payout';
  ref: string;
  amount: number;
  currency: string;
  /** Our own status for the object, e.g. captured/succeeded/paid/failed. */
  status: string;
}

export type DiscrepancyType =
  | 'missing_in_ledger'
  | 'missing_at_provider'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'status_mismatch';

export interface Discrepancy {
  type: DiscrepancyType;
  kind: LedgerRecord['kind'];
  ref: string;
  provider?: { amount: number; currency: string; status: string };
  ledger?: { amount: number; currency: string; status: string };
  detail: string;
}

export interface ReconciliationResult {
  ok: boolean;
  matched: number;
  discrepancies: Discrepancy[];
}

/** Provider says money moved (succeeded) => the ledger must have it; the ledger says it moved => the provider must have succeeded it. */
const LEDGER_MOVED = new Set(['captured', 'succeeded', 'paid', 'refunded', 'partially_refunded']);

/**
 * Compare provider records with ledger-backed records. Pure and order-independent. Only *settled* provider records matter for the
 * "missing in ledger" direction (a pending/failed/cancelled payment intent legitimately has no ledger entry).
 */
export function reconcile(
  provider: ProviderRecord[],
  ledger: LedgerRecord[],
): ReconciliationResult {
  const key = (k: string, ref: string) => `${k}:${ref}`;
  const ledgerBy = new Map(ledger.map((l) => [key(l.kind, l.ref), l]));
  const providerBy = new Map(provider.map((p) => [key(p.kind, p.ref), p]));
  const discrepancies: Discrepancy[] = [];
  let matched = 0;

  for (const p of provider) {
    const l = ledgerBy.get(key(p.kind, p.ref));
    const pv = { amount: p.amount, currency: p.currency, status: p.status };
    if (!l) {
      if (p.status === 'succeeded')
        discrepancies.push({
          type: 'missing_in_ledger',
          kind: p.kind,
          ref: p.ref,
          provider: pv,
          detail: `${p.kind} succeeded at the provider but is not in the ledger`,
        });
      continue;
    }
    const lv = { amount: l.amount, currency: l.currency, status: l.status };
    if (p.currency.toUpperCase() !== l.currency.toUpperCase()) {
      discrepancies.push({
        type: 'currency_mismatch',
        kind: p.kind,
        ref: p.ref,
        provider: pv,
        ledger: lv,
        detail: 'currency differs',
      });
    } else if (p.amount !== l.amount) {
      discrepancies.push({
        type: 'amount_mismatch',
        kind: p.kind,
        ref: p.ref,
        provider: pv,
        ledger: lv,
        detail: `provider ${p.amount} vs ledger ${l.amount}`,
      });
    } else if (LEDGER_MOVED.has(l.status) && p.status !== 'succeeded') {
      discrepancies.push({
        type: 'status_mismatch',
        kind: p.kind,
        ref: p.ref,
        provider: pv,
        ledger: lv,
        detail: `ledger recorded ${l.status} but the provider reports ${p.status}`,
      });
    } else if (!LEDGER_MOVED.has(l.status) && p.status === 'succeeded') {
      discrepancies.push({
        type: 'status_mismatch',
        kind: p.kind,
        ref: p.ref,
        provider: pv,
        ledger: lv,
        detail: `provider succeeded but our status is ${l.status}`,
      });
    } else {
      matched += 1;
    }
  }
  for (const l of ledger) {
    if (!providerBy.has(key(l.kind, l.ref)) && LEDGER_MOVED.has(l.status)) {
      discrepancies.push({
        type: 'missing_at_provider',
        kind: l.kind,
        ref: l.ref,
        ledger: { amount: l.amount, currency: l.currency, status: l.status },
        detail: `${l.kind} is in the ledger but the provider has no record in this window`,
      });
    }
  }
  return { ok: discrepancies.length === 0, matched, discrepancies };
}
