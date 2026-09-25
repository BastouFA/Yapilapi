import type { Queryable } from '@yapilapi/database';
import {
  assertBalanced,
  sellerPayable,
  type LedgerEntryDraft,
  type PayeeType,
} from '@yapilapi/payments';

export interface Payee {
  type: PayeeType;
  id: string;
}

export const payeeKey = (p: Payee) => `${p.type}:${p.id}`;

/**
 * Append a balanced transaction to the ledger. Idempotent: (kind, refType, refId) is unique, so replays (duplicate webhooks,
 * retried jobs) return false and write nothing. Balance is verified here and again by the deferred constraint trigger at COMMIT.
 */
export async function postLedger(
  db: Queryable,
  t: {
    kind: 'payment_captured' | 'refund' | 'payout' | 'fee' | 'adjustment';
    refType: string;
    refId: string;
    currency: string;
    entries: LedgerEntryDraft[];
  },
): Promise<boolean> {
  assertBalanced(t.entries);
  const ins = await db.query<{ id: string }>(
    `INSERT INTO ledger_transactions (kind, ref_type, ref_id, currency) VALUES ($1,$2,$3,$4) ON CONFLICT (kind, ref_type, ref_id) DO NOTHING RETURNING id`,
    [t.kind, t.refType, t.refId, t.currency],
  );
  const id = ins.rows[0]?.id;
  if (!id) return false;
  const values: unknown[] = [id];
  const rows = t.entries.map((e, i) => {
    values.push(e.account, e.direction, e.amount);
    return `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`;
  });
  await db.query(
    `INSERT INTO ledger_entries (transaction_id, account, direction, amount_cents) VALUES ${rows.join(',')}`,
    values,
  );
  return true;
}

/** credits - debits on one account in one currency (liability view). */
export async function accountBalance(
  db: Queryable,
  account: string,
  currency: string,
): Promise<number> {
  const { rows } = await db.query<{ b: number }>(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0)::bigint AS b
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE e.account = $1 AND t.currency = $2`,
    [account, currency],
  );
  return rows[0]!.b;
}

export interface PayeeBalance {
  currency: string;
  /** Everything the platform owes the payee. */
  total: number;
  /** Payable now: matured payments (older than the hold period) net of refunds and payouts. Never negative. */
  available: number;
  /** total - available: still inside the hold period. */
  pending: number;
}

/**
 * Balances of a seller's payable account per currency, computed from the ledger only.
 * A payment's net becomes available `holdDays` after it was captured; refunds/disputes of a payment count in the same bucket as
 * the payment they reverse (so refunding a payment that is still on hold nets to zero on hold), payouts count immediately.
 */
export async function payeeBalances(
  db: Queryable,
  payee: Payee,
  holdDays: number,
  now: Date = new Date(),
): Promise<PayeeBalance[]> {
  const cutoff = new Date(now.getTime() - holdDays * 86_400_000);
  const { rows } = await db.query<{ currency: string; total: number; available: number }>(
    `WITH tx AS (
       SELECT t.id, t.currency,
              CASE
                WHEN t.kind = 'payment_captured' THEN t.ref_id
                WHEN t.kind = 'refund' AND t.ref_type = 'refund' THEN (SELECT r.payment_id FROM refunds r WHERE r.id = t.ref_id)
                WHEN t.kind = 'adjustment' AND t.ref_type = 'dispute_lost' THEN (SELECT d.payment_id FROM disputes d WHERE d.id = t.ref_id)
              END AS payment_id
         FROM ledger_transactions t
     )
     SELECT tx.currency,
            COALESCE(SUM(s.signed), 0)::bigint AS total,
            COALESCE(SUM(s.signed) FILTER (WHERE tx.payment_id IS NULL OR cap.created_at <= $2), 0)::bigint AS available
       FROM (SELECT e.transaction_id, CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END AS signed
               FROM ledger_entries e WHERE e.account = $1) s
       JOIN tx ON tx.id = s.transaction_id
       LEFT JOIN ledger_transactions cap ON cap.kind = 'payment_captured' AND cap.ref_type = 'payment' AND cap.ref_id = tx.payment_id
      GROUP BY tx.currency ORDER BY tx.currency`,
    [sellerPayable(payee.type, payee.id), cutoff],
  );
  return rows.map((r) => ({
    currency: r.currency,
    total: r.total,
    available: Math.max(0, r.available),
    pending: r.total - Math.max(0, r.available),
  }));
}
