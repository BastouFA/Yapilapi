import { describe, expect, it } from 'vitest';
import {
  ACTIVE_ACCESS_SLACK_DAYS,
  PAST_DUE_ACCESS_DAYS,
  addDays,
  addInterval,
  clickVerdict,
  commissionCents,
  entitled,
  isBotUserAgent,
  kAnonymizeCountries,
  nextKycStatus,
  nextPartnershipStatus,
  renewalFailure,
  visitorHash,
  type PartnershipAction,
  type PartnershipStatus,
} from './rules.js';

const d = (s: string) => new Date(s);

describe('kyc workflow', () => {
  it('follows unverified -> pending -> verified|rejected and never verifies without a submission', () => {
    expect(nextKycStatus('unverified', 'submit')).toBe('pending');
    expect(nextKycStatus('pending', 'verify')).toBe('verified');
    expect(nextKycStatus('pending', 'reject')).toBe('rejected');
    expect(nextKycStatus('rejected', 'submit')).toBe('pending');
    expect(nextKycStatus('unverified', 'verify')).toBeNull();
    expect(nextKycStatus('rejected', 'verify')).toBeNull();
    expect(nextKycStatus('verified', 'submit')).toBeNull();
    expect(nextKycStatus('verified', 'reject')).toBeNull();
    expect(nextKycStatus('verified', 'reset')).toBe('unverified');
    expect(nextKycStatus('unverified', 'reset')).toBeNull();
  });
});

describe('interval arithmetic', () => {
  it('never overflows month ends and keeps the anchor day when possible', () => {
    expect(addInterval(d('2027-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
    expect(addInterval(d('2028-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
    expect(addInterval(d('2027-03-15T00:00:00Z'), 'month').toISOString()).toBe(
      '2027-04-15T00:00:00.000Z',
    );
    expect(addInterval(d('2027-12-31T00:00:00Z'), 'month').toISOString()).toBe(
      '2028-01-31T00:00:00.000Z',
    );
    expect(addInterval(d('2028-02-29T00:00:00Z'), 'year').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
  });
});

describe('dunning', () => {
  const start = d('2027-05-01T00:00:00Z');
  it('retries on days 1, 3 and 5 after the first failure, then expires', () => {
    const a = renewalFailure(0, start);
    expect(a).toMatchObject({ status: 'past_due', attempts: 1 });
    expect(a.nextRetryAt?.toISOString()).toBe('2027-05-02T00:00:00.000Z');
    expect(renewalFailure(1, start).nextRetryAt?.toISOString()).toBe('2027-05-04T00:00:00.000Z');
    expect(renewalFailure(2, start).nextRetryAt?.toISOString()).toBe('2027-05-06T00:00:00.000Z');
    expect(renewalFailure(3, start)).toEqual({ status: 'expired', attempts: 4, nextRetryAt: null });
  });
});

describe('entitlement', () => {
  const end = d('2027-05-01T00:00:00Z');
  it('active is entitled until the slack passes; past_due until the grace passes; everything else never', () => {
    expect(entitled({ status: 'active', currentPeriodEnd: end }, addDays(end, -1))).toBe(true);
    expect(
      entitled(
        { status: 'active', currentPeriodEnd: end },
        addDays(end, ACTIVE_ACCESS_SLACK_DAYS - 0.01),
      ),
    ).toBe(true);
    expect(
      entitled(
        { status: 'active', currentPeriodEnd: end },
        addDays(end, ACTIVE_ACCESS_SLACK_DAYS + 0.01),
      ),
    ).toBe(false);
    expect(
      entitled(
        { status: 'past_due', currentPeriodEnd: end },
        addDays(end, PAST_DUE_ACCESS_DAYS - 0.01),
      ),
    ).toBe(true);
    expect(
      entitled(
        { status: 'past_due', currentPeriodEnd: end },
        addDays(end, PAST_DUE_ACCESS_DAYS + 0.01),
      ),
    ).toBe(false);
    for (const status of ['incomplete', 'cancelled', 'expired'] as const)
      expect(entitled({ status, currentPeriodEnd: addDays(end, 100) }, end)).toBe(false);
  });
});

describe('brand partnership state machine', () => {
  const all: PartnershipStatus[] = [
    'proposed',
    'negotiating',
    'accepted',
    'in_progress',
    'delivered',
    'paid',
    'declined',
    'cancelled',
  ];
  it('allows the documented path', () => {
    expect(nextPartnershipStatus('proposed', 'counter')).toBe('negotiating');
    expect(nextPartnershipStatus('negotiating', 'counter')).toBe('negotiating');
    expect(nextPartnershipStatus('negotiating', 'accept')).toBe('accepted');
    expect(nextPartnershipStatus('accepted', 'start')).toBe('in_progress');
    expect(nextPartnershipStatus('in_progress', 'deliver')).toBe('delivered');
    expect(nextPartnershipStatus('delivered', 'pay')).toBe('paid');
  });
  it('rejects everything else, and terminal states never move', () => {
    expect(nextPartnershipStatus('proposed', 'pay')).toBeNull();
    expect(nextPartnershipStatus('accepted', 'deliver')).toBeNull();
    expect(nextPartnershipStatus('in_progress', 'accept')).toBeNull();
    const actions: PartnershipAction[] = [
      'counter',
      'accept',
      'decline',
      'start',
      'deliver',
      'reopen',
      'pay',
      'cancel',
    ];
    for (const t of ['paid', 'declined', 'cancelled'] as const)
      for (const a of actions) expect(nextPartnershipStatus(t, a)).toBeNull();
    expect(all.filter((s) => nextPartnershipStatus(s, 'cancel'))).toEqual([
      'proposed',
      'negotiating',
      'accepted',
      'in_progress',
      'delivered',
    ]);
  });
});

describe('k-anonymity of audience countries', () => {
  it('hides small countries and only reports the remainder when it is itself large enough', () => {
    const r = kAnonymizeCountries(
      [
        { country: 'US', count: 120 },
        { country: 'GB', count: 25 },
        { country: 'IS', count: 3 },
        { country: 'NZ', count: 4 },
      ],
      20,
    );
    expect(r.countries).toEqual([
      { country: 'US', count: 120 },
      { country: 'GB', count: 25 },
    ]);
    expect(r.other).toBeNull();
    expect(
      kAnonymizeCountries(
        [
          { country: 'AA', count: 12 },
          { country: 'BB', count: 11 },
          { country: 'US', count: 50 },
        ],
        20,
      ),
    ).toEqual({ countries: [{ country: 'US', count: 50 }], other: 23 });
  });
  it('a group of exactly k is shown, k-1 is not', () => {
    expect(kAnonymizeCountries([{ country: 'US', count: 20 }], 20).countries).toHaveLength(1);
    expect(kAnonymizeCountries([{ country: 'US', count: 19 }], 20).countries).toHaveLength(0);
  });
});

describe('affiliate click rules', () => {
  it('recognises automation by user agent', () => {
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent('curl/8.4.0')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      ),
    ).toBe(false);
  });
  it('verdict order: bot, self, excessive, counted', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    expect(
      clickVerdict({ userAgent: 'curl/8', viewerId: null, creatorId: 'c', hitsToday: 1 }),
    ).toBe('bot');
    expect(clickVerdict({ userAgent: ua, viewerId: 'c', creatorId: 'c', hitsToday: 1 })).toBe(
      'self',
    );
    expect(clickVerdict({ userAgent: ua, viewerId: null, creatorId: 'c', hitsToday: 26 })).toBe(
      'excessive',
    );
    expect(clickVerdict({ userAgent: ua, viewerId: 'v', creatorId: 'c', hitsToday: 1 })).toBe(
      'counted',
    );
  });
  it('the visitor hash is stable within a day and differs across days, users and secrets', () => {
    const a = visitorHash('s', '1.2.3.4', 'UA', '2027-01-01');
    expect(a).toBe(visitorHash('s', '1.2.3.4', 'UA', '2027-01-01'));
    expect(a).not.toBe(visitorHash('s', '1.2.3.4', 'UA', '2027-01-02'));
    expect(a).not.toBe(visitorHash('s', '1.2.3.5', 'UA', '2027-01-01'));
    expect(a).not.toBe(visitorHash('t', '1.2.3.4', 'UA', '2027-01-01'));
    expect(a).not.toContain('1.2.3.4');
  });
  it('commission is floored integer minor units', () => {
    expect(commissionCents(2000, 1000)).toBe(200);
    expect(commissionCents(999, 1500)).toBe(149);
    expect(commissionCents(1, 5000)).toBe(0);
  });
});
