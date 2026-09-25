import { describe, expect, it } from 'vitest';
import { DEFAULT_FRAUD_CONFIG, approxUsd, evaluateFraud, type FraudInput } from './fraud.js';

const base = (over: Partial<FraudInput> = {}): FraudInput => ({
  amountMinor: 2_500,
  currency: 'USD',
  accountAgeHours: 24 * 60,
  user: {
    ordersLastHour: 0,
    ordersLast24h: 0,
    failedPaymentsLast24h: 0,
    avgPaidOrderMinor: null,
    paidOrders: 0,
  },
  network: { ipDistinctUsers24h: 0, fingerprintDistinctUsers24h: 0 },
  geo: { accountCountry: 'US', shippingCountry: 'US', cardCountry: 'US' },
  ...over,
});
const codes = (r: ReturnType<typeof evaluateFraud>) => r.reasons.map((x) => x.code);

describe('fraud rules engine', () => {
  it('allows an ordinary purchase', () => {
    const r = evaluateFraud(base());
    expect(r).toEqual({ decision: 'allow', score: 0, reasons: [] });
  });

  it('user velocity: review at 5/hour, block at 12/hour', () => {
    expect(evaluateFraud(base({ user: { ...base().user, ordersLastHour: 4 } })).decision).toBe(
      'allow',
    );
    const review = evaluateFraud(base({ user: { ...base().user, ordersLastHour: 5 } }));
    expect(review.decision).toBe('review');
    expect(codes(review)).toContain('velocity_user_hour');
    const block = evaluateFraud(base({ user: { ...base().user, ordersLastHour: 12 } }));
    expect(block.decision).toBe('block');
    expect(codes(block)).toContain('velocity_user_hour_extreme');
  });

  it('card fingerprint shared across accounts', () => {
    expect(
      evaluateFraud(base({ network: { ipDistinctUsers24h: 0, fingerprintDistinctUsers24h: 3 } }))
        .decision,
    ).toBe('review');
    expect(
      evaluateFraud(base({ network: { ipDistinctUsers24h: 0, fingerprintDistinctUsers24h: 2 } }))
        .decision,
    ).toBe('allow');
    expect(
      evaluateFraud(base({ network: { ipDistinctUsers24h: 0, fingerprintDistinctUsers24h: 6 } }))
        .decision,
    ).toBe('block');
  });

  it('IP sharing alone is a weak signal, but combines with others', () => {
    const ip = evaluateFraud(
      base({ network: { ipDistinctUsers24h: 5, fingerprintDistinctUsers24h: 0 } }),
    );
    expect(ip.decision).toBe('allow');
    expect(ip.score).toBe(35);
    const combo = evaluateFraud(
      base({
        network: { ipDistinctUsers24h: 5, fingerprintDistinctUsers24h: 0 },
        geo: { accountCountry: 'US', shippingCountry: 'FR', cardCountry: 'US' },
      }),
    );
    expect(combo.decision).toBe('review');
  });

  it('repeated failed payments', () => {
    expect(
      evaluateFraud(base({ user: { ...base().user, failedPaymentsLast24h: 3 } })).decision,
    ).toBe('review');
    expect(
      evaluateFraud(base({ user: { ...base().user, failedPaymentsLast24h: 8 } })).decision,
    ).toBe('block');
  });

  it('amount anomalies use the buyer history and absolute value', () => {
    const anomaly = evaluateFraud(
      base({
        amountMinor: 30_000,
        user: { ...base().user, avgPaidOrderMinor: 5_000, paidOrders: 3 },
      }),
    );
    expect(codes(anomaly)).toContain('amount_anomaly');
    expect(anomaly.decision).toBe('allow'); // 40 < 50: an anomaly alone does not hold an established buyer's order
    expect(
      codes(
        evaluateFraud(
          base({
            amountMinor: 30_000,
            user: { ...base().user, avgPaidOrderMinor: 5_000, paidOrders: 1 },
          }),
        ),
      ),
    ).not.toContain('amount_anomaly');
    expect(codes(evaluateFraud(base({ amountMinor: 250_000 })))).toContain('high_value');
    const both = evaluateFraud(
      base({
        amountMinor: 250_000,
        geo: { accountCountry: 'US', shippingCountry: 'DE', cardCountry: 'US' },
      }),
    );
    expect(both.decision).toBe('review');
  });

  it('new account + high value is held for review', () => {
    const r = evaluateFraud(base({ accountAgeHours: 2, amountMinor: 25_000 }));
    expect(r.decision).toBe('review');
    expect(codes(r)).toEqual(['new_account_high_value']);
    expect(evaluateFraud(base({ accountAgeHours: 2, amountMinor: 5_000 })).decision).toBe('allow');
    expect(evaluateFraud(base({ accountAgeHours: 72, amountMinor: 25_000 })).decision).toBe(
      'allow',
    );
  });

  it('country mismatch: two countries weak, three strong', () => {
    const two = evaluateFraud(
      base({ geo: { accountCountry: 'US', shippingCountry: 'US', cardCountry: 'NG' } }),
    );
    expect(codes(two)).toEqual(['country_mismatch']);
    expect(two.decision).toBe('allow');
    const three = evaluateFraud(
      base({ geo: { accountCountry: 'US', shippingCountry: 'GB', cardCountry: 'NG' } }),
    );
    expect(codes(three)).toEqual(['country_mismatch_multiple']);
    expect(three.decision).toBe('review');
    expect(evaluateFraud(base({ geo: {} })).decision).toBe('allow'); // unknown is not suspicious
  });

  it('thresholds are configurable and scores add up', () => {
    const strict = { ...DEFAULT_FRAUD_CONFIG, reviewAt: 20 };
    expect(
      evaluateFraud(
        base({ geo: { accountCountry: 'US', shippingCountry: 'US', cardCountry: 'NG' } }),
        strict,
      ).decision,
    ).toBe('review');
    const r = evaluateFraud(
      base({ user: { ...base().user, ordersLastHour: 5, failedPaymentsLast24h: 3 } }),
    );
    expect(r.score).toBe(r.reasons.reduce((s, x) => s + x.weight, 0));
    expect(r.decision).toBe('block');
  });

  it('currency-aware thresholds (zero-decimal currencies are not treated as huge)', () => {
    expect(approxUsd(250_000, 'JPY')).toBeCloseTo(1_675, 0);
    expect(
      evaluateFraud(base({ currency: 'JPY', amountMinor: 20_000, accountAgeHours: 1 })).decision,
    ).toBe('allow'); // ~USD 134
    expect(
      evaluateFraud(base({ currency: 'JPY', amountMinor: 40_000, accountAgeHours: 1 })).decision,
    ).toBe('review'); // ~USD 268
  });
});
