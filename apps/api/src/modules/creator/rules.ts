import { createHmac } from 'node:crypto';

/**
 * Pure rules of the creator economy (no database, no HTTP). Everything here has a unit test in rules.unit.test.ts.
 */

// ------------------------------------------------------------------ creator verification (KYC) workflow
export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type KycAction = 'submit' | 'verify' | 'reject' | 'reset';

/**
 * unverified --submit--> pending --verify--> verified
 *                           |--reject--> rejected --submit--> pending
 * `reset` (provider says the account needs attention again) sends verified/pending back to unverified.
 * Staff can only `verify`/`reject` a creator that SUBMITTED; nobody can verify from `unverified`.
 */
export function nextKycStatus(from: KycStatus, action: KycAction): KycStatus | null {
  switch (action) {
    case 'submit':
      return from === 'unverified' || from === 'rejected' ? 'pending' : null;
    case 'verify':
      return from === 'pending' ? 'verified' : null;
    case 'reject':
      return from === 'pending' ? 'rejected' : null;
    case 'reset':
      return from === 'verified' || from === 'pending' ? 'unverified' : null;
  }
}

// ------------------------------------------------------------------ subscription lifecycle
export type SubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'cancelled' | 'expired';
export type Interval = 'month' | 'year';

/** Days after the FIRST failed renewal at which we retry. After the last one fails the subscription expires. */
export const DUNNING_RETRY_DAYS = [1, 3, 5] as const;
/** Access grace while a subscription is past_due (mirrors postVisibleSql). */
export const PAST_DUE_ACCESS_DAYS = 3;
/** Slack after an active period end before access lapses if the renewal job is late (mirrors postVisibleSql). */
export const ACTIVE_ACCESS_SLACK_DAYS = 1;

/** Calendar arithmetic that never overflows a month end (Jan 31 + 1 month = Feb 28/29), always in UTC. */
export function addInterval(from: Date, interval: Interval, count = 1): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + count);
  else d.setUTCFullYear(d.getUTCFullYear() + count);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * 86_400_000);

export interface RenewalFailureOutcome {
  status: 'past_due' | 'expired';
  attempts: number;
  nextRetryAt: Date | null;
}

/**
 * Outcome of a failed renewal charge. `attemptsBefore` = failures already recorded (0 on the first failure); `firstFailureAt` is when the
 * dunning cycle started (the period end). Retries are scheduled RELATIVE TO THE FIRST FAILURE (day 1, 3, 5), so a late job does not stretch the cycle.
 */
export function renewalFailure(
  attemptsBefore: number,
  firstFailureAt: Date,
): RenewalFailureOutcome {
  const attempts = attemptsBefore + 1;
  const retryDay = DUNNING_RETRY_DAYS[attempts - 1];
  if (retryDay === undefined) return { status: 'expired', attempts, nextRetryAt: null };
  return { status: 'past_due', attempts, nextRetryAt: addDays(firstFailureAt, retryDay) };
}

/** Does this subscription entitle its holder to subscriber content right now? Must stay in sync with postVisibleSql. */
export function entitled(
  sub: { status: SubscriptionStatus; currentPeriodEnd: Date },
  now: Date,
): boolean {
  if (sub.status === 'active')
    return addDays(sub.currentPeriodEnd, ACTIVE_ACCESS_SLACK_DAYS).getTime() > now.getTime();
  if (sub.status === 'past_due')
    return addDays(sub.currentPeriodEnd, PAST_DUE_ACCESS_DAYS).getTime() > now.getTime();
  return false;
}

// ------------------------------------------------------------------ brand partnerships
export type PartnershipStatus =
  | 'proposed'
  | 'negotiating'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'paid'
  | 'declined'
  | 'cancelled';
export type PartnershipAction =
  'counter' | 'accept' | 'decline' | 'start' | 'deliver' | 'reopen' | 'pay' | 'cancel';

/**
 * proposed --counter--> negotiating --counter--> negotiating ...
 * proposed|negotiating --accept (by the side that did not make the current terms)--> accepted --start--> in_progress
 * in_progress --deliver (every deliverable approved)--> delivered --pay (captured)--> paid
 * decline: proposed|negotiating. cancel: anything not yet paid/declined/cancelled. reopen: delivered -> in_progress (a deliverable was rejected later).
 */
const PARTNERSHIP: Record<PartnershipAction, { from: PartnershipStatus[]; to: PartnershipStatus }> =
  {
    counter: { from: ['proposed', 'negotiating'], to: 'negotiating' },
    accept: { from: ['proposed', 'negotiating'], to: 'accepted' },
    decline: { from: ['proposed', 'negotiating'], to: 'declined' },
    start: { from: ['accepted'], to: 'in_progress' },
    deliver: { from: ['in_progress'], to: 'delivered' },
    reopen: { from: ['delivered'], to: 'in_progress' },
    pay: { from: ['delivered'], to: 'paid' },
    cancel: {
      from: ['proposed', 'negotiating', 'accepted', 'in_progress', 'delivered'],
      to: 'cancelled',
    },
  };
export function nextPartnershipStatus(
  from: PartnershipStatus,
  action: PartnershipAction,
): PartnershipStatus | null {
  const t = PARTNERSHIP[action];
  return t.from.includes(from) ? t.to : null;
}
export const PARTNERSHIP_TERMINAL: readonly PartnershipStatus[] = ['paid', 'declined', 'cancelled'];

// ------------------------------------------------------------------ analytics privacy
export interface CountryBucket {
  country: string;
  count: number;
}

/**
 * k-anonymity for audience geography: a country is reported only when at least `k` distinct people share it. Suppressed countries are
 * merged into "other" and "other" itself is reported only when it reaches k (otherwise its people are simply not reported). The total
 * of reported + withheld is never revealed when it would isolate a small group.
 */
export function kAnonymizeCountries(
  buckets: CountryBucket[],
  k: number,
): { countries: CountryBucket[]; other: number | null } {
  const shown = buckets
    .filter((b) => b.count >= k)
    .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));
  const hidden = buckets.filter((b) => b.count < k).reduce((n, b) => n + b.count, 0);
  return { countries: shown, other: hidden >= k ? hidden : null };
}

// ------------------------------------------------------------------ affiliate clicks
const BOT_UA =
  /bot|crawl|spider|slurp|headless|httpclient|curl\/|wget|python-requests|python-urllib|go-http-client|okhttp\/[0-9]|java\/|libwww|scrapy|monitor|preview|facebookexternalhit|embedly|node-fetch|axios/i;

export const isBotUserAgent = (ua: string | undefined | null): boolean =>
  !ua || ua.trim().length < 8 || BOT_UA.test(ua);

/** Visitor identity for dedupe: keyed HMAC of (ip, user agent, UTC day). It cannot be compared across days and never stores the address. */
export function visitorHash(secret: string, ip: string, userAgent: string, day: string): string {
  return createHmac('sha256', secret)
    .update(`${ip}\n${userAgent}\n${day}`)
    .digest('hex')
    .slice(0, 32);
}

export type ClickVerdict = 'counted' | 'bot' | 'self' | 'excessive';
/** More hits than this from one visitor on one link in one day are treated as automation (the first still counts once). */
export const MAX_HITS_PER_VISITOR_DAY = 25;

export function clickVerdict(i: {
  userAgent: string | undefined;
  viewerId: string | null;
  creatorId: string;
  hitsToday: number;
}): ClickVerdict {
  if (isBotUserAgent(i.userAgent)) return 'bot';
  if (i.viewerId && i.viewerId === i.creatorId) return 'self';
  if (i.hitsToday > MAX_HITS_PER_VISITOR_DAY) return 'excessive';
  return 'counted';
}

/** Attribution window: the buyer must have a counted click on the link within this many days before the order. */
export const ATTRIBUTION_WINDOW_DAYS = 30;

export const commissionCents = (lineCents: number, bps: number): number =>
  Math.floor((lineCents * bps) / 10_000);

export const affiliateAttributionNote = `Last-click attribution: a paid order line counts when the buyer had a counted click on your link within ${ATTRIBUTION_WINDOW_DAYS} days before ordering. Bot, self and flood clicks are recorded but never counted, and commission settles after the payout hold period when nothing was refunded.`;
