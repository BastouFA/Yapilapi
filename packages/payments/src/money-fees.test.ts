import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addMinor,
  allocate,
  assertMinorAmount,
  currencyExponent,
  formatMoney,
  mulDiv,
  mulMinor,
  normalizeCurrency,
  parseMoney,
} from './money.js';
import { calculatePlatformFee, feeReturnedForRefund } from './fees.js';

describe('money helpers', () => {
  it('knows currency exponents', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('XOF')).toBe(0);
  });
  it('normalises and validates currency codes', () => {
    expect(normalizeCurrency(' usd ')).toBe('USD');
    expect(() => normalizeCurrency('US')).toThrow(MoneyError);
    expect(() => normalizeCurrency('ZZZ')).toThrow(MoneyError);
    expect(() => normalizeCurrency('12A')).toThrow(MoneyError);
  });
  it('parses and formats decimal strings without floating point', () => {
    expect(parseMoney('12.34', 'USD')).toBe(1234);
    expect(parseMoney('12.3', 'USD')).toBe(1230);
    expect(parseMoney('12', 'USD')).toBe(1200);
    expect(parseMoney('1500', 'JPY')).toBe(1500);
    expect(parseMoney('1.234', 'KWD')).toBe(1234);
    expect(parseMoney('0.1', 'USD') + parseMoney('0.2', 'USD')).toBe(30);
    expect(() => parseMoney('12.345', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('1.5', 'JPY')).toThrow(MoneyError);
    expect(() => parseMoney('-1', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('1e3', 'USD')).toThrow(MoneyError);
    expect(formatMoney(1234, 'USD')).toBe('12.34');
    expect(formatMoney(5, 'USD')).toBe('0.05');
    expect(formatMoney(1500, 'JPY')).toBe('1500');
    expect(formatMoney(1234, 'KWD')).toBe('1.234');
  });
  it('guards amounts', () => {
    expect(() => assertMinorAmount(1.5)).toThrow(MoneyError);
    expect(() => assertMinorAmount(-1)).toThrow(MoneyError);
    expect(() => assertMinorAmount(Number.MAX_SAFE_INTEGER)).toThrow(MoneyError);
    expect(addMinor(1, 2, 3)).toBe(6);
    expect(() => addMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
    expect(mulMinor(250, 4)).toBe(1000);
    expect(() => mulMinor(1e11, 5)).toThrow(MoneyError);
  });
  it('mulDiv rounds exactly', () => {
    expect(mulDiv(1, 5, 10, 'half_up')).toBe(1);
    expect(mulDiv(1, 5, 10, 'down')).toBe(0);
    expect(mulDiv(1, 1, 10, 'up')).toBe(1);
    expect(mulDiv(99_999_999_999, 9_999, 10_000, 'half_up')).toBe(99_989_999_999);
  });
  it('allocate always sums to the total (largest remainder)', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5, [1, 1])).toEqual([3, 2]);
    expect(allocate(0, [3, 2])).toEqual([0, 0]);
    for (const total of [1, 7, 99, 1001]) {
      const parts = allocate(total, [3, 5, 11, 1]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(() => allocate(10, [])).toThrow(MoneyError);
  });
});

describe('platform fee calculator', () => {
  it('computes 5% half-up in integer minor units', () => {
    expect(calculatePlatformFee(10_000, { bps: 500 })).toEqual({
      gross: 10_000,
      fee: 500,
      net: 9_500,
    });
    expect(calculatePlatformFee(1_999, { bps: 500 })).toEqual({
      gross: 1_999,
      fee: 100,
      net: 1_899,
    }); // 99.95 -> 100
    expect(calculatePlatformFee(1_990, { bps: 500 })).toEqual({
      gross: 1_990,
      fee: 100,
      net: 1_890,
    }); // 99.5 -> 100 (half up)
    expect(calculatePlatformFee(1_989, { bps: 500 }).fee).toBe(99); // 99.45 -> 99
    expect(calculatePlatformFee(1, { bps: 500 }).fee).toBe(0);
    expect(calculatePlatformFee(10, { bps: 500 }).fee).toBe(1); // 0.5 -> 1
  });
  it('supports down/up rounding, floors and caps, never exceeding gross', () => {
    expect(calculatePlatformFee(1_999, { bps: 500, rounding: 'down' }).fee).toBe(99);
    expect(calculatePlatformFee(1_991, { bps: 500, rounding: 'up' }).fee).toBe(100);
    expect(calculatePlatformFee(100, { bps: 500, minFeeMinor: 30 }).fee).toBe(30);
    expect(calculatePlatformFee(10, { bps: 500, minFeeMinor: 30 }).fee).toBe(10);
    expect(calculatePlatformFee(0, { bps: 500, minFeeMinor: 30 }).fee).toBe(0);
    expect(calculatePlatformFee(1_000_000, { bps: 500, maxFeeMinor: 10_000 }).fee).toBe(10_000);
    expect(calculatePlatformFee(1_000, { bps: 10_000 })).toEqual({
      gross: 1_000,
      fee: 1_000,
      net: 0,
    });
  });
  it('works for zero-decimal and three-decimal currencies (minor unit is the rounding unit)', () => {
    expect(calculatePlatformFee(1_500, { bps: 500 })).toEqual({
      gross: 1_500,
      fee: 75,
      net: 1_425,
    }); // JPY 1500
    expect(calculatePlatformFee(999, { bps: 500 }).fee).toBe(50); // JPY 999 -> 49.95 -> 50
    expect(calculatePlatformFee(12_345, { bps: 250 }).fee).toBe(309); // KWD 12.345 -> 308.625 -> 309
  });
  it('net + fee === gross for many amounts and rates', () => {
    for (const bps of [0, 1, 250, 500, 999, 5000]) {
      for (const gross of [0, 1, 2, 3, 99, 100, 101, 12_345, 999_999, 4_000_000_001]) {
        const r = calculatePlatformFee(gross, { bps });
        expect(r.fee + r.net).toBe(gross);
        expect(r.fee).toBeGreaterThanOrEqual(0);
        expect(r.fee).toBeLessThanOrEqual(gross);
      }
    }
  });
  it('rejects invalid input', () => {
    expect(() => calculatePlatformFee(1.5, { bps: 500 })).toThrow(MoneyError);
    expect(() => calculatePlatformFee(100, { bps: -1 })).toThrow(MoneyError);
    expect(() => calculatePlatformFee(100, { bps: 10_001 })).toThrow(MoneyError);
    expect(() => calculatePlatformFee(100, { bps: 5.5 })).toThrow(MoneyError);
  });
});

describe('fee returned on refunds', () => {
  it('is proportional and cumulative so a full refund returns exactly the whole fee', () => {
    // payment 1999 with fee 100
    expect(feeReturnedForRefund(1_999, 100, 0, 1_999)).toBe(100);
    expect(feeReturnedForRefund(1_999, 100, 0, 1_000)).toBe(50); // 50.02 -> 50
    expect(feeReturnedForRefund(1_999, 100, 1_000, 999)).toBe(50);
    let refunded = 0;
    let returned = 0;
    for (const part of [333, 333, 333, 1_000]) {
      returned += feeReturnedForRefund(1_999, 100, refunded, part);
      refunded += part;
    }
    expect(refunded).toBe(1_999);
    expect(returned).toBe(100);
  });
  it('never returns more than the refund and refuses over-refunds', () => {
    expect(feeReturnedForRefund(100, 100, 0, 10)).toBeLessThanOrEqual(10);
    expect(() => feeReturnedForRefund(1_000, 50, 900, 200)).toThrow(MoneyError);
    expect(feeReturnedForRefund(1_000, 0, 0, 500)).toBe(0);
  });
});
