import { MoneyError, assertMinorAmount } from './money.js';
import { feeReturnedForRefund } from './fees.js';

/**
 * Double-entry ledger vocabulary. Per currency, every transaction's debits equal its credits (also enforced in the database by a
 * deferred constraint trigger). Convention: debit increases assets, credit increases liabilities/revenue.
 *
 *   provider:clearing               ASSET      platform money held at the payment provider
 *   seller:<user|business>:<id>:payable   LIABILITY  what we owe a seller (net of platform fee)
 *   platform:fees                   REVENUE    platform fees earned
 */
export const PROVIDER_CLEARING = 'provider:clearing';
export const PLATFORM_FEES = 'platform:fees';

export type PayeeType = 'user' | 'business';
export const sellerPayable = (type: PayeeType, id: string): string =>
  `seller:${type}:${id}:payable`;

export interface LedgerEntryDraft {
  account: string;
  direction: 'debit' | 'credit';
  amount: number;
}

export function assertBalanced(entries: LedgerEntryDraft[]): void {
  let d = 0;
  let c = 0;
  for (const e of entries) {
    assertMinorAmount(e.amount, 'ledger amount');
    if (e.amount <= 0) throw new MoneyError('ledger entries must be positive');
    if (e.direction === 'debit') d += e.amount;
    else c += e.amount;
  }
  if (d !== c) throw new MoneyError(`unbalanced ledger transaction: debit ${d} != credit ${c}`);
  if (!entries.length) throw new MoneyError('empty ledger transaction');
}

const compact = (entries: LedgerEntryDraft[]): LedgerEntryDraft[] =>
  entries.filter((e) => e.amount > 0);

/** Buyer payment captured: debit provider clearing (gross); credit seller payable (gross - fee) and platform fees (fee). */
export function paymentCapturedEntries(p: {
  payee: { type: PayeeType; id: string };
  amount: number;
  fee: number;
}): LedgerEntryDraft[] {
  if (p.fee > p.amount) throw new MoneyError('fee exceeds amount');
  const entries = compact([
    { account: PROVIDER_CLEARING, direction: 'debit', amount: p.amount },
    {
      account: sellerPayable(p.payee.type, p.payee.id),
      direction: 'credit',
      amount: p.amount - p.fee,
    },
    { account: PLATFORM_FEES, direction: 'credit', amount: p.fee },
  ]);
  assertBalanced(entries);
  return entries;
}

/**
 * Refund: reverse part of the capture. Debit seller payable (refund - fee returned) and platform fees (fee returned) and credit provider
 * clearing (refund). Never mutates earlier entries; the fee share is proportional and cumulative (see feeReturnedForRefund).
 */
export function refundEntries(p: {
  payee: { type: PayeeType; id: string };
  paymentAmount: number;
  paymentFee: number;
  refundedBefore: number;
  refund: number;
}): { entries: LedgerEntryDraft[]; feeReturned: number } {
  const feeReturned = feeReturnedForRefund(
    p.paymentAmount,
    p.paymentFee,
    p.refundedBefore,
    p.refund,
  );
  const entries = compact([
    {
      account: sellerPayable(p.payee.type, p.payee.id),
      direction: 'debit',
      amount: p.refund - feeReturned,
    },
    { account: PLATFORM_FEES, direction: 'debit', amount: feeReturned },
    { account: PROVIDER_CLEARING, direction: 'credit', amount: p.refund },
  ]);
  assertBalanced(entries);
  return { entries, feeReturned };
}

/** Payout to a seller: debit seller payable, credit provider clearing (cash leaves the platform's provider balance). */
export function payoutEntries(p: {
  payee: { type: PayeeType; id: string };
  amount: number;
}): LedgerEntryDraft[] {
  const entries: LedgerEntryDraft[] = [
    { account: sellerPayable(p.payee.type, p.payee.id), direction: 'debit', amount: p.amount },
    { account: PROVIDER_CLEARING, direction: 'credit', amount: p.amount },
  ];
  assertBalanced(entries);
  return entries;
}

/** A failed/reversed payout puts the money back on the seller's payable. */
export function payoutReversalEntries(p: {
  payee: { type: PayeeType; id: string };
  amount: number;
}): LedgerEntryDraft[] {
  const entries: LedgerEntryDraft[] = [
    { account: PROVIDER_CLEARING, direction: 'debit', amount: p.amount },
    { account: sellerPayable(p.payee.type, p.payee.id), direction: 'credit', amount: p.amount },
  ];
  assertBalanced(entries);
  return entries;
}

/** Signed balance of one account across entries: credits - debits (liability view; negate for assets). */
export function creditBalance(entries: Array<LedgerEntryDraft>, account: string): number {
  let b = 0;
  for (const e of entries)
    if (e.account === account) b += e.direction === 'credit' ? e.amount : -e.amount;
  return b;
}
