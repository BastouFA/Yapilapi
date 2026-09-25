import { z } from 'zod';

/**
 * Pure ADS rules: what may be targeted, who matches, how spend is paced, what an impression or click costs, which traffic is invalid.
 * No I/O; every branch is unit-tested (rules.unit.test.ts). The API layer (service.ts) applies these to database rows.
 */

// ------------------------------------------------------------------ targeting: contextual, interest and coarse geo ONLY
export const PLACEMENTS = ['feed', 'search', 'discover', 'profile'] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** Topics that may never be used to target people (special-category / sensitive inferences). */
export const SENSITIVE_TOPICS: ReadonlySet<string> = new Set([
  'politics',
  'faith',
  'health',
  'mental-health',
]);
/** Keys people ask for that we refuse by name, so the error is useful instead of a generic "unknown key". */
export const FORBIDDEN_TARGETING_KEYS: ReadonlySet<string> = new Set([
  'age',
  'age_band',
  'ageBand',
  'gender',
  'sex',
  'sexuality',
  'orientation',
  'religion',
  'ethnicity',
  'race',
  'politics',
  'health',
  'disability',
  'union',
  'income',
  'relationship',
  'lookalike',
  'contacts',
  'email',
  'phone',
  'device',
  'precise_location',
  'lat',
  'lng',
  'audience',
  'custom_audience',
]);

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}$/);
export const targetingSchema = z.strictObject({
  /** Canonical topic slugs. Matched against the page's context always, and against the viewer's interests only with advertising consent. */
  topics: z.array(slug).max(20).default([]),
  languages: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z]{2,3}$/),
    )
    .max(10)
    .default([]),
  /** Coarse geography: countries (ISO 3166-1 alpha-2) and city names. Never coordinates. */
  geo: z
    .strictObject({
      countries: z
        .array(
          z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z]{2}$/),
        )
        .max(30)
        .default([]),
      cities: z.array(z.string().trim().toLowerCase().min(2).max(60)).max(20).default([]),
    })
    .default({ countries: [], cities: [] }),
});
export type Targeting = z.infer<typeof targetingSchema>;
export const emptyTargeting = (): Targeting => ({
  topics: [],
  languages: [],
  geo: { countries: [], cities: [] },
});

export type TargetingResult = { ok: true; targeting: Targeting } | { ok: false; issues: string[] };
/** Validate stored/submitted targeting. Everything not listed above is refused; sensitive keys and topics get a specific message. */
export function validateTargeting(raw: unknown): TargetingResult {
  const issues: string[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw))
      if (FORBIDDEN_TARGETING_KEYS.has(k)) issues.push(`Targeting by "${k}" is not allowed`);
  }
  const p = targetingSchema.safeParse(raw ?? {});
  if (!p.success)
    for (const i of p.error.issues) issues.push(`${i.path.join('.') || 'targeting'}: ${i.message}`);
  else
    for (const t of p.data.topics)
      if (SENSITIVE_TOPICS.has(t))
        issues.push(`The topic "${t}" is sensitive and cannot be used for targeting`);
  if (issues.length) return { ok: false, issues };
  return { ok: true, targeting: (p as { data: Targeting }).data };
}

export interface MatchContext {
  /** Topics of the page/feed the ad appears in (supplied by the client, never inferred from the person). */
  contextTopics: readonly string[];
  language: string | null;
  country: string | null;
  city: string | null;
  /** Viewer's explicit interests: ONLY passed when hasConsent('advertising'). */
  interests: readonly string[];
}
export interface MatchResult {
  matched: boolean;
  /** 0 = broad; higher = more specific */ score: number;
  reasons: string[];
}

/**
 * Does the ad's targeting accept this viewer/context? Empty dimensions accept everyone. Language and geo are hard filters; topics need a hit in
 * the context (weight 2) or, with consent, in the viewer's interests (weight 1). Missing geo/language in the request cannot satisfy a geo/language filter.
 */
export function matchTargeting(t: Targeting, c: MatchContext): MatchResult {
  const reasons: string[] = [];
  let score = 0;
  if (t.languages.length) {
    if (!c.language || !t.languages.includes(c.language))
      return { matched: false, score: 0, reasons: [] };
    reasons.push(`language:${c.language}`);
    score += 1;
  }
  if (t.geo.countries.length || t.geo.cities.length) {
    const countryOk =
      t.geo.countries.length > 0 && c.country !== null && t.geo.countries.includes(c.country);
    const cityOk =
      t.geo.cities.length > 0 && c.city !== null && t.geo.cities.includes(c.city.toLowerCase());
    // Both lists given = both must hold (a city alone is ambiguous across countries).
    if (
      t.geo.countries.length && t.geo.cities.length
        ? !(countryOk && cityOk)
        : !(countryOk || cityOk)
    )
      return { matched: false, score: 0, reasons: [] };
    if (countryOk) reasons.push(`country:${c.country}`);
    if (cityOk) reasons.push(`city:${c.city!.toLowerCase()}`);
    score += 1;
  }
  if (t.topics.length) {
    const ctx = t.topics.filter((x) => c.contextTopics.includes(x));
    const intr = t.topics.filter((x) => !ctx.includes(x) && c.interests.includes(x));
    if (!ctx.length && !intr.length) return { matched: false, score: 0, reasons: [] };
    for (const x of ctx) reasons.push(`context:${x}`);
    for (const x of intr) reasons.push(`interest:${x}`);
    score += ctx.length ? 2 : 1;
  }
  return { matched: true, score, reasons };
}

// ------------------------------------------------------------------ money: milli-cents (1/1000 cent), exact per-event accrual
export type BidModel = 'cpm' | 'cpc';
/** cpm: bid is cents per 1000 impressions = bid milli-cents per impression; cpc: bid cents per click. Impressions cost nothing under cpc and vice versa. */
export const impressionCostMilli = (model: BidModel, bidCents: number): number =>
  model === 'cpm' ? bidCents : 0;
export const clickCostMilli = (model: BidModel, bidCents: number): number =>
  model === 'cpc' ? bidCents * 1000 : 0;
/** Assumed click-through rate for ranking cpc bids against cpm bids: smoothed history, (clicks+1)/(impressions+100). */
export const smoothedCtr = (clicks: number, impressions: number): number =>
  (clicks + 1) / (impressions + 100);
/** Expected revenue per 1000 impressions in cents, so cpm and cpc campaigns compete on the same scale. */
export const ecpmCents = (model: BidModel, bidCents: number, ctr: number): number =>
  model === 'cpm' ? bidCents : bidCents * ctr * 1000;
/** Final ordering value: expected revenue, lifted a little by relevance (never more than +30%). */
export const rankValue = (ecpm: number, relevance: number): number =>
  ecpm * (1 + Math.min(relevance, 3) * 0.1);

export interface BudgetState {
  totalMilli: number;
  spentMilli: number;
  dailyMilli: number;
  spentTodayMilli: number;
  /** Fraction of the UTC day elapsed, 0..1. */
  dayFraction: number;
}
/** Even pacing: by a given time of day an ad may have spent its daily budget times the elapsed fraction plus a 15% burst allowance (minimum one cost unit). */
export function paceAllowsSpend(
  b: BudgetState,
  nextCostMilli: number,
): { ok: boolean; reason?: 'total_exhausted' | 'daily_exhausted' | 'pacing' } {
  if (b.spentMilli + nextCostMilli > b.totalMilli) return { ok: false, reason: 'total_exhausted' };
  if (b.spentTodayMilli + nextCostMilli > b.dailyMilli)
    return { ok: false, reason: 'daily_exhausted' };
  const allowedByNow = Math.max(nextCostMilli, b.dailyMilli * Math.min(1, b.dayFraction + 0.15));
  if (b.spentTodayMilli + nextCostMilli > allowedByNow) return { ok: false, reason: 'pacing' };
  return { ok: true };
}
export const dayFraction = (now: Date): number =>
  (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 86_400;
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** Per-viewer frequency cap: impressions of the same ad in the last 24 h. */
export const frequencyAllows = (recentImpressions: number, cap: number): boolean =>
  recentImpressions < cap;

// ------------------------------------------------------------------ invalid traffic
export type InvalidReason =
  | 'expired_token'
  | 'too_fast'
  | 'frequency_cap'
  | 'ip_flood'
  | 'self_view'
  | 'bot'
  | 'budget_exhausted'
  | 'not_serving'
  | 'no_impression'
  | 'self_click';
export const TOKEN_TTL_MS = 30 * 60_000;
export const MIN_VIEW_MS = 250;
export const MIN_CLICK_AFTER_VIEW_MS = 300;
export const MAX_IMPRESSIONS_PER_IP_PER_AD_HOUR = 30;
export const MAX_CLICKS_PER_IP_PER_CAMPAIGN_HOUR = 8;

export const BOT_UA =
  /\b(bot|crawler|spider|headless|curl|wget|python-requests|httpclient|scrapy|phantomjs)\b/i;

export interface ImpressionFacts {
  issuedAt: Date;
  now: Date;
  userAgent: string | null;
  recentForViewer: number;
  frequencyCap: number;
  recentFromIp: number;
  isOwnAd: boolean;
}
/** null = a valid, billable impression. Otherwise the recorded reason (the row is kept with cost 0 so reports can show filtered traffic). */
export function impressionVerdict(f: ImpressionFacts): InvalidReason | null {
  if (f.now.getTime() - f.issuedAt.getTime() > TOKEN_TTL_MS) return 'expired_token';
  if (f.isOwnAd) return 'self_view';
  if (f.now.getTime() - f.issuedAt.getTime() < MIN_VIEW_MS) return 'too_fast';
  if (f.userAgent && BOT_UA.test(f.userAgent)) return 'bot';
  if (!frequencyAllows(f.recentForViewer, f.frequencyCap)) return 'frequency_cap';
  if (f.recentFromIp >= MAX_IMPRESSIONS_PER_IP_PER_AD_HOUR) return 'ip_flood';
  return null;
}
export interface ClickFacts {
  impressionValid: boolean;
  impressionAt: Date;
  now: Date;
  userAgent: string | null;
  recentFromIp: number;
  isOwnAd: boolean;
}
export function clickVerdict(f: ClickFacts): InvalidReason | null {
  if (f.isOwnAd) return 'self_click';
  if (!f.impressionValid) return 'no_impression';
  if (f.now.getTime() - f.impressionAt.getTime() < MIN_CLICK_AFTER_VIEW_MS) return 'too_fast';
  if (f.userAgent && BOT_UA.test(f.userAgent)) return 'bot';
  if (f.recentFromIp >= MAX_CLICKS_PER_IP_PER_CAMPAIGN_HOUR) return 'ip_flood';
  return null;
}

// ------------------------------------------------------------------ campaign lifecycle
export type CampaignStatus =
  'draft' | 'pending_review' | 'active' | 'paused' | 'ended' | 'rejected';
const CAMPAIGN_NEXT: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ['pending_review', 'ended'],
  pending_review: ['active', 'rejected', 'draft'],
  active: ['paused', 'ended'],
  paused: ['active', 'draft', 'pending_review', 'ended'],
  ended: [],
  rejected: ['draft', 'pending_review', 'ended'],
};
export const canCampaignMove = (from: CampaignStatus, to: CampaignStatus): boolean =>
  CAMPAIGN_NEXT[from].includes(to);
/** Campaigns whose content/targeting the owner may edit (an active campaign is paused first; edits that change what is reviewed send it back to draft). */
export const isEditable = (s: CampaignStatus): boolean =>
  s === 'draft' || s === 'rejected' || s === 'paused';

/** Is the ad allowed to be served now? Schedule + status only; budgets/pacing are separate (they depend on spend so far). */
export function withinSchedule(startsAt: Date | null, endsAt: Date | null, now: Date): boolean {
  return (!startsAt || startsAt <= now) && (!endsAt || endsAt > now);
}

export const SPONSORED_LABEL = 'Sponsored';

// ------------------------------------------------------------------ destination URLs
/** Ads may link only to https URLs on a public host: no credentials, no IP literals, no localhost/internal names. */
export function validateTargetUrl(raw: string): string | null {
  if (raw.length > 500) return 'The link is too long';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'The link is not a valid URL';
  }
  if (u.protocol !== 'https:') return 'Ad links must use https';
  if (u.username || u.password) return 'Ad links cannot contain credentials';
  const h = u.hostname.toLowerCase();
  if (
    !h.includes('.') ||
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.localhost')
  )
    return 'Ad links must point to a public website';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('['))
    return 'Ad links cannot use IP addresses';
  return null;
}
