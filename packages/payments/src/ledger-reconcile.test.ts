import { describe, expect, it } from 'vitest';
import {
  PLATFORM_FEES,
  PROVIDER_CLEARING,
  assertBalanced,
  creditBalance,
  paymentCapturedEntries,
  payoutEntries,
  payoutReversalEntries,
  refundEntries,
  sellerPayable,
} from './ledger.js';
import { reconcile, type LedgerRecord } from './reconcile.js';
import type { ProviderRecord } from './types.js';
import { MoneyError } from './money.js';

const payee = { type: 'user', id: 'u1' } as const;

describe('ledger entry builders', () => {
  it('capture: debits clearing, credits seller net and platform fee', () => {
    const e = paymentCapturedEntries({ payee, amount: 10_000, fee: 500 });
    expect(e).toEqual([
      { account: PROVIDER_CLEARING, direction: 'debit', amount: 10_000 },
      { account: sellerPayable('user', 'u1'), direction: 'credit', amount: 9_500 },
      { account: PLATFORM_FEES, direction: 'credit', amount: 500 },
    ]);
    expect(() => assertBalanced(e)).not.toThrow();
  });
  it('capture with zero fee omits the fee line', () => {
    expect(paymentCapturedEntries({ payee, amount: 100, fee: 0 })).toHaveLength(2);
  });
  it('refund reverses proportionally; full sequence nets every account to zero', () => {
    const cap = paymentCapturedEntries({ payee, amount: 1_999, fee: 100 });
    const parts = [700, 600, 699];
    let before = 0;
    const all = [...cap];
    for (const r of parts) {
      const { entries, feeReturned } = refundEntries({
        payee,
        paymentAmount: 1_999,
        paymentFee: 100,
        refundedBefore: before,
        refund: r,
      });
      expect(feeReturned).toBeLessThanOrEqual(r);
      assertBalanced(entries);
      all.push(...entries);
      before += r;
    }
    expect(creditBalance(all, sellerPayable('user', 'u1'))).toBe(0);
    expect(creditBalance(all, PLATFORM_FEES)).toBe(0);
    expect(creditBalance(all, PROVIDER_CLEARING)).toBe(0);
  });
  it('rejects over-refunds and unbalanced transactions', () => {
    expect(() =>
      refundEntries({ payee, paymentAmount: 100, paymentFee: 5, refundedBefore: 90, refund: 20 }),
    ).toThrow(MoneyError);
    expect(() =>
      assertBalanced([
        { account: 'a', direction: 'debit', amount: 5 },
        { account: 'b', direction: 'credit', amount: 4 },
      ]),
    ).toThrow(MoneyError);
    expect(() => assertBalanced([])).toThrow(MoneyError);
    expect(() => assertBalanced([{ account: 'a', direction: 'debit', amount: 0 }])).toThrow(
      MoneyError,
    );
  });
  it('payouts and their reversal', () => {
    const all = [
      ...paymentCapturedEntries({ payee, amount: 1_000, fee: 50 }),
      ...payoutEntries({ payee, amount: 950 }),
    ];
    expect(creditBalance(all, sellerPayable('user', 'u1'))).toBe(0);
    const back = [...all, ...payoutReversalEntries({ payee, amount: 950 })];
    expect(creditBalance(back, sellerPayable('user', 'u1'))).toBe(950);
  });
});

describe('reconciliation', () => {
  const now = new Date();
  const p = (
    o: Partial<ProviderRecord> & Pick<ProviderRecord, 'kind' | 'ref'>,
  ): ProviderRecord => ({
    paymentRef: null,
    amount: 1_000,
    currency: 'USD',
    status: 'succeeded',
    createdAt: now,
    ...o,
  });
  const l = (o: Partial<LedgerRecord> & Pick<LedgerRecord, 'kind' | 'ref'>): LedgerRecord => ({
    amount: 1_000,
    currency: 'USD',
    status: 'captured',
    ...o,
  });

  it('matches identical records', () => {
    const r = reconcile(
      [p({ kind: 'payment', ref: 'pi_1' }), p({ kind: 'refund', ref: 're_1', amount: 200 })],
      [
        l({ kind: 'payment', ref: 'pi_1' }),
        l({ kind: 'refund', ref: 're_1', amount: 200, status: 'succeeded' }),
      ],
    );
    expect(r).toEqual({ ok: true, matched: 2, discrepancies: [] });
  });
  it('reports every kind of discrepancy', () => {
    const r = reconcile(
      [
        p({ kind: 'payment', ref: 'pi_missing_ledger' }),
        p({ kind: 'payment', ref: 'pi_amount', amount: 999 }),
        p({ kind: 'payment', ref: 'pi_cur', currency: 'EUR' }),
        p({ kind: 'payment', ref: 'pi_status', status: 'failed' }),
        p({ kind: 'payment', ref: 'pi_pending_ok', status: 'pending' }),
        p({ kind: 'payout', ref: 'po_ok' }),
      ],
      [
        l({ kind: 'payment', ref: 'pi_amount' }),
        l({ kind: 'payment', ref: 'pi_cur' }),
        l({ kind: 'payment', ref: 'pi_status' }),
        l({ kind: 'payment', ref: 'pi_missing_provider' }),
        l({ kind: 'payout', ref: 'po_ok', status: 'paid' }),
      ],
    );
    const by = Object.fromEntries(r.discrepancies.map((d) => [d.ref, d.type]));
    expect(by).toEqual({
      pi_missing_ledger: 'missing_in_ledger',
      pi_amount: 'amount_mismatch',
      pi_cur: 'currency_mismatch',
      pi_status: 'status_mismatch',
      pi_missing_provider: 'missing_at_provider',
    });
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(1);
  });
  it('a failed payout in the ledger is not expected at the provider', () => {
    expect(reconcile([], [l({ kind: 'payout', ref: 'po_f', status: 'failed' })]).ok).toBe(true);
  });
});
