import { MoneyError, assertMinorAmount, mulDiv, type Rounding } from './money.js';

export interface FeeOptions {
  /** Platform fee in basis points (500 = 5.00%). */
  bps: number;
  /** Rounding of the fee in the currency's minor unit. Default half_up (the platform never rounds against itself by more than half a unit). */
  rounding?: Rounding;
  /** Floor for non-zero amounts, in minor units. Default 0. */
  minFeeMinor?: number;
  /** Cap, in minor units. Default: none. */
  maxFeeMinor?: number;
}

export interface FeeBreakdown {
  gross: number;
  fee: number;
  /** What the seller earns from `gross` (gross - fee). */
  net: number;
}

/**
 * Platform fee on an amount, in integer minor units. Rules:
 *  - fee = round(gross * bps / 10_000) with the chosen rounding (default half-up);
 *  - a non-zero gross never yields a fee below minFeeMinor, and the fee never exceeds gross or maxFeeMinor;
 *  - zero-decimal currencies need no special handling because the minor unit IS the whole unit; the fee is rounded to it;
 *  - net + fee === gross always.
 */
export function calculatePlatformFee(gross: number, opts: FeeOptions): FeeBreakdown {
  assertMinorAmount(gross, 'gross');
  if (!Number.isInteger(opts.bps) || opts.bps < 0 || opts.bps > 10_000)
    throw new MoneyError('bps must be an integer between 0 and 10000');
  let fee = mulDiv(gross, opts.bps, 10_000, opts.rounding ?? 'half_up');
  if (gross > 0 && opts.minFeeMinor !== undefined)
    fee = Math.max(fee, assertMinorAmount(opts.minFeeMinor, 'minFeeMinor'));
  if (opts.maxFeeMinor !== undefined)
    fee = Math.min(fee, assertMinorAmount(opts.maxFeeMinor, 'maxFeeMinor'));
  fee = Math.min(fee, gross);
  return { gross, fee, net: gross - fee };
}

/**
 * Platform fee returned to the seller for a (partial) refund. The refunded share of the fee is proportional to the refunded
 * share of the payment and computed CUMULATIVELY so the parts always add up: after the payment is fully refunded exactly the
 * whole fee has been returned, no more and no less.
 *
 * @param paymentAmount  total captured amount
 * @param paymentFee     platform fee taken from that payment
 * @param refundedBefore sum of previously succeeded refunds
 * @param refund         the refund being processed
 */
export function feeReturnedForRefund(
  paymentAmount: number,
  paymentFee: number,
  refundedBefore: number,
  refund: number,
): number {
  assertMinorAmount(paymentAmount, 'paymentAmount');
  assertMinorAmount(paymentFee, 'paymentFee');
  assertMinorAmount(refundedBefore, 'refundedBefore');
  assertMinorAmount(refund, 'refund');
  if (paymentFee > paymentAmount) throw new MoneyError('fee exceeds payment');
  if (refundedBefore + refund > paymentAmount)
    throw new MoneyError('refund exceeds the captured amount');
  if (paymentAmount === 0) return 0;
  const cum = (r: number) =>
    r === paymentAmount ? paymentFee : mulDiv(paymentFee, r, paymentAmount, 'half_up');
  return Math.min(refund, cum(refundedBefore + refund) - cum(refundedBefore));
}
