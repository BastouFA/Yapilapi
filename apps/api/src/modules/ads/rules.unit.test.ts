import { describe, expect, it } from 'vitest';
import {
  canCampaignMove,
  clickCostMilli,
  clickVerdict,
  dayFraction,
  ecpmCents,
  emptyTargeting,
  frequencyAllows,
  impressionCostMilli,
  impressionVerdict,
  isEditable,
  matchTargeting,
  paceAllowsSpend,
  rankValue,
  smoothedCtr,
  validateTargetUrl,
  validateTargeting,
  withinSchedule,
  type ImpressionFacts,
  type MatchContext,
  type Targeting,
} from './rules.js';

const T = (over: Partial<Targeting> = {}): Targeting => ({ ...emptyTargeting(), ...over });
const C = (over: Partial<MatchContext> = {}): MatchContext => ({
  contextTopics: [],
  language: null,
  country: null,
  city: null,
  interests: [],
  ...over,
});

describe('targeting validation', () => {
  it('accepts contextual/interest/geo/language targeting and normalises it', () => {
    const r = validateTargeting({
      topics: ['Music', 'travel'],
      languages: ['EN'],
      geo: { countries: ['us', 'GB'], cities: ['Lagos'] },
    });
    expect(r).toEqual({
      ok: true,
      targeting: {
        topics: ['music', 'travel'],
        languages: ['en'],
        geo: { countries: ['US', 'GB'], cities: ['lagos'] },
      },
    });
    expect(validateTargeting(undefined)).toEqual({ ok: true, targeting: emptyTargeting() });
    expect(validateTargeting({})).toEqual({ ok: true, targeting: emptyTargeting() });
  });
  it('refuses sensitive keys, sensitive topics, unknown keys and precise location', () => {
    for (const k of [
      'age',
      'age_band',
      'gender',
      'religion',
      'ethnicity',
      'health',
      'lookalike',
      'custom_audience',
      'lat',
      'precise_location',
      'email',
    ]) {
      const r = validateTargeting({ [k]: 'x' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join(' ')).toContain(`"${k}"`);
    }
    for (const t of ['politics', 'faith', 'health', 'mental-health'])
      expect(validateTargeting({ topics: [t] }).ok).toBe(false);
    expect(validateTargeting({ whatever: 1 }).ok).toBe(false);
    expect(validateTargeting({ geo: { lat: 1, lng: 2 } }).ok).toBe(false);
    expect(validateTargeting({ geo: { countries: ['USA'] } }).ok).toBe(false);
    expect(validateTargeting({ topics: Array.from({ length: 21 }, (_, i) => `t${i}x`) }).ok).toBe(
      false,
    );
    expect(validateTargeting('nope').ok).toBe(false);
    expect(validateTargeting([]).ok).toBe(false);
  });
});

describe('matching', () => {
  it('broad ads match anyone', () =>
    expect(matchTargeting(T(), C())).toEqual({ matched: true, score: 0, reasons: [] }));
  it('topics match the page context, or the viewer interests only when they were provided (consent)', () => {
    const t = T({ topics: ['music', 'travel'] });
    expect(matchTargeting(t, C({ contextTopics: ['music'] }))).toMatchObject({
      matched: true,
      score: 2,
      reasons: ['context:music'],
    });
    expect(matchTargeting(t, C({ interests: ['travel'] }))).toMatchObject({
      matched: true,
      score: 1,
      reasons: ['interest:travel'],
    });
    expect(matchTargeting(t, C())).toMatchObject({ matched: false }); // no consent, no context: not shown
    expect(matchTargeting(t, C({ contextTopics: ['gaming'] }))).toMatchObject({ matched: false });
  });
  it('language and geo are hard filters that an absent value cannot satisfy', () => {
    expect(matchTargeting(T({ languages: ['en'] }), C({ language: 'en' })).matched).toBe(true);
    expect(matchTargeting(T({ languages: ['en'] }), C({ language: 'fr' })).matched).toBe(false);
    expect(matchTargeting(T({ languages: ['en'] }), C()).matched).toBe(false);
    const g = T({ geo: { countries: ['US'], cities: [] } });
    expect(matchTargeting(g, C({ country: 'US' })).matched).toBe(true);
    expect(matchTargeting(g, C({ country: 'GB' })).matched).toBe(false);
    expect(matchTargeting(g, C()).matched).toBe(false);
    const both = T({ geo: { countries: ['US'], cities: ['austin'] } });
    expect(matchTargeting(both, C({ country: 'US', city: 'Austin' })).matched).toBe(true);
    expect(matchTargeting(both, C({ country: 'US', city: 'Dallas' })).matched).toBe(false);
    expect(matchTargeting(both, C({ country: 'GB', city: 'Austin' })).matched).toBe(false);
    expect(
      matchTargeting(T({ geo: { countries: [], cities: ['lagos'] } }), C({ city: 'LAGOS' }))
        .matched,
    ).toBe(true);
  });
  it('all dimensions must hold together', () => {
    const t = T({ topics: ['music'], languages: ['en'], geo: { countries: ['US'], cities: [] } });
    expect(
      matchTargeting(t, C({ contextTopics: ['music'], language: 'en', country: 'US' })).score,
    ).toBe(4);
    expect(
      matchTargeting(t, C({ contextTopics: ['music'], language: 'en', country: 'CA' })).matched,
    ).toBe(false);
  });
});

describe('money and ranking', () => {
  it('accrues exactly in milli-cents', () => {
    expect(impressionCostMilli('cpm', 250)).toBe(250); // 2.50 per 1000 = 0.25 cent each
    expect(impressionCostMilli('cpc', 250)).toBe(0);
    expect(clickCostMilli('cpc', 40)).toBe(40_000);
    expect(clickCostMilli('cpm', 40)).toBe(0);
    expect(1000 * impressionCostMilli('cpm', 250)).toBe(250_000); // 1000 impressions = 250 cents
  });
  it('compares cpc and cpm on expected revenue', () => {
    expect(smoothedCtr(0, 0)).toBeCloseTo(0.01);
    expect(smoothedCtr(50, 1000)).toBeCloseTo(51 / 1100);
    expect(ecpmCents('cpm', 200, 0.5)).toBe(200);
    expect(ecpmCents('cpc', 50, 0.02)).toBeCloseTo(1000);
    expect(rankValue(100, 0)).toBe(100);
    expect(rankValue(100, 2)).toBeCloseTo(120);
    expect(rankValue(100, 99)).toBeCloseTo(130);
  });
  it('never spends past the total or daily budget and paces through the day', () => {
    const b = {
      totalMilli: 100_000,
      spentMilli: 0,
      dailyMilli: 10_000,
      spentTodayMilli: 0,
      dayFraction: 0.5,
    };
    expect(paceAllowsSpend(b, 250)).toEqual({ ok: true });
    expect(paceAllowsSpend({ ...b, spentMilli: 99_900 }, 250)).toEqual({
      ok: false,
      reason: 'total_exhausted',
    });
    expect(paceAllowsSpend({ ...b, spentTodayMilli: 9_900 }, 250)).toEqual({
      ok: false,
      reason: 'daily_exhausted',
    });
    expect(paceAllowsSpend({ ...b, spentTodayMilli: 6_400 }, 250)).toEqual({
      ok: false,
      reason: 'pacing',
    }); // 6650 > 65% of the day's budget
    expect(paceAllowsSpend({ ...b, spentTodayMilli: 6_200 }, 250)).toEqual({ ok: true });
    expect(paceAllowsSpend({ ...b, dayFraction: 0 }, 250)).toEqual({ ok: true }); // the first impressions of the day always fit
    expect(paceAllowsSpend({ ...b, dayFraction: 0, spentTodayMilli: 1_500 }, 250)).toEqual({
      ok: false,
      reason: 'pacing',
    });
    expect(paceAllowsSpend({ ...b, dayFraction: 1, spentTodayMilli: 9_750 }, 250)).toEqual({
      ok: true,
    });
    expect(paceAllowsSpend({ ...b, dayFraction: 1, spentTodayMilli: 9_760 }, 250)).toEqual({
      ok: false,
      reason: 'daily_exhausted',
    });
  });
  it('day fraction', () => {
    expect(dayFraction(new Date('2026-01-01T00:00:00Z'))).toBe(0);
    expect(dayFraction(new Date('2026-01-01T12:00:00Z'))).toBe(0.5);
  });
  it('frequency cap', () => {
    expect(frequencyAllows(2, 3)).toBe(true);
    expect(frequencyAllows(3, 3)).toBe(false);
  });
});

describe('invalid traffic', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const ok: ImpressionFacts = {
    issuedAt: new Date(now.getTime() - 5000),
    now,
    userAgent: 'Mozilla/5.0 Chrome',
    recentForViewer: 0,
    frequencyCap: 3,
    recentFromIp: 0,
    isOwnAd: false,
  };
  it('bills a normal impression and flags each kind of abuse', () => {
    expect(impressionVerdict(ok)).toBeNull();
    expect(impressionVerdict({ ...ok, issuedAt: new Date(now.getTime() - 3_600_000) })).toBe(
      'expired_token',
    );
    expect(impressionVerdict({ ...ok, issuedAt: new Date(now.getTime() - 50) })).toBe('too_fast');
    expect(impressionVerdict({ ...ok, userAgent: 'Googlebot/2.1 crawler' })).toBe('bot');
    expect(impressionVerdict({ ...ok, userAgent: 'python-requests/2.0' })).toBe('bot');
    expect(impressionVerdict({ ...ok, recentForViewer: 3 })).toBe('frequency_cap');
    expect(impressionVerdict({ ...ok, recentFromIp: 30 })).toBe('ip_flood');
    expect(impressionVerdict({ ...ok, isOwnAd: true })).toBe('self_view');
    expect(impressionVerdict({ ...ok, userAgent: null })).toBeNull();
  });
  it('clicks need a valid impression and are rate limited per IP', () => {
    const c = {
      impressionValid: true,
      impressionAt: new Date(now.getTime() - 3000),
      now,
      userAgent: 'Mozilla/5.0',
      recentFromIp: 0,
      isOwnAd: false,
    };
    expect(clickVerdict(c)).toBeNull();
    expect(clickVerdict({ ...c, impressionValid: false })).toBe('no_impression');
    expect(clickVerdict({ ...c, impressionAt: new Date(now.getTime() - 100) })).toBe('too_fast');
    expect(clickVerdict({ ...c, userAgent: 'curl/8' })).toBe('bot');
    expect(clickVerdict({ ...c, recentFromIp: 8 })).toBe('ip_flood');
    expect(clickVerdict({ ...c, isOwnAd: true })).toBe('self_click');
  });
});

describe('campaign lifecycle', () => {
  it('moves through review only', () => {
    expect(canCampaignMove('draft', 'pending_review')).toBe(true);
    expect(canCampaignMove('draft', 'active')).toBe(false);
    expect(canCampaignMove('pending_review', 'active')).toBe(true);
    expect(canCampaignMove('rejected', 'active')).toBe(false);
    expect(canCampaignMove('active', 'paused')).toBe(true);
    expect(canCampaignMove('paused', 'active')).toBe(true);
    expect(canCampaignMove('ended', 'active')).toBe(false);
    expect(isEditable('draft') && isEditable('paused') && isEditable('rejected')).toBe(true);
    expect(isEditable('active') || isEditable('pending_review') || isEditable('ended')).toBe(false);
  });
  it('schedule window', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(withinSchedule(null, null, now)).toBe(true);
    expect(withinSchedule(new Date('2026-01-02T00:00:00Z'), null, now)).toBe(false);
    expect(withinSchedule(null, new Date('2025-12-31T00:00:00Z'), now)).toBe(false);
    expect(
      withinSchedule(new Date('2025-12-31T00:00:00Z'), new Date('2026-01-02T00:00:00Z'), now),
    ).toBe(true);
  });
});

describe('destination URLs', () => {
  it('accepts public https links only', () => {
    expect(validateTargetUrl('https://shop.example.com/sale?x=1')).toBeNull();
    for (const bad of [
      'http://example.com',
      'javascript:alert(1)',
      'https://user:pw@example.com',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.1',
      'https://intranet/x',
      'https://a.internal/x',
      'https://[::1]/x',
      'not a url',
      `https://example.com/${'a'.repeat(500)}`,
    ]) {
      expect(validateTargetUrl(bad), bad).not.toBeNull();
    }
  });
});
