import { describe, expect, it } from 'vitest';
import { CURRENCIES, CURRENCY_SCALE, PLATFORM_FEE_BPS, processingFeeCents } from './constants.ts';

describe('processing fees', () => {
  it('takes a share plus a fixed amount, up to the cap, and never more than the payment', () => {
    expect(processingFeeCents(1000, 'USD')).toBe(59); // 2.9% + 30¢
    expect(processingFeeCents(1300, 'eur')).toBe(63); // case and padding don't matter
    expect(processingFeeCents(150_000, 'NGN')).toBe(2_250); // 1.5%; the ₦100 only from ₦2,500
    expect(processingFeeCents(500_000, 'NGN')).toBe(17_500); // 1.5% + ₦100
    expect(processingFeeCents(50_000_000, 'NGN')).toBe(200_000); // at most ₦2,000
    expect(processingFeeCents(20, 'USD')).toBe(20);
    expect(processingFeeCents(0, 'USD')).toBe(0);
  });

  it('leaves the creator most of the smallest tip in every currency', () => {
    // The smallest tip is 100 hundredths, scaled per currency; processing is charged on top of the 5%.
    for (const currency of CURRENCIES) {
      const amount = 100 * CURRENCY_SCALE[currency];
      const fees = Math.round((amount * PLATFORM_FEE_BPS) / 10_000) + processingFeeCents(amount, currency);
      expect(fees, currency).toBeLessThan(amount / 2);
    }
  });
});
