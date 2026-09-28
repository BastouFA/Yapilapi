import type { PublicAuthor, PublicUser } from './types.ts';

/**
 * Drops: a seller announces a launch of some of their products ahead of time. People can ask to
 * be told when it opens; at the start time the products go on sale through the usual checkout,
 * with real quantities and an optional limit per buyer. Timing is written plainly ("Opens Friday
 * 6:00 PM"), never as pressure.
 */

export const DROP_TITLE_MAX = 80;
export const DROP_DESCRIPTION_MAX = 500;
export const DROP_COVER_ALT_MAX = 300;
/** Products in one drop. */
export const DROP_MAX_ITEMS = 12;
/** A drop opens at least this long after it is scheduled or changed. */
export const DROP_MIN_LEAD_MINUTES = 5;
/** ...and at most this far ahead. */
export const DROP_MAX_LEAD_DAYS = 180;
/** When it has an end time: open at least this long... */
export const DROP_MIN_OPEN_MINUTES = 15;
/** ...and at most this long. */
export const DROP_MAX_OPEN_DAYS = 30;
export const DROP_MAX_QUANTITY = 100_000;
export const DROP_MAX_PER_BUYER = 100;
/** Units in an unpaid order are held for the buyer this long, then go back on sale. */
export const DROP_HOLD_MINUTES = 15;

export const DROP_STATUSES = ['draft', 'scheduled', 'open', 'ended', 'cancelled'] as const;
export type DropStatus = (typeof DROP_STATUSES)[number];

/** One product in a drop, with what is really left. */
export interface DropItem {
  productId: string;
  kind: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  /** How many the drop has. null: no set number. */
  quantity: number | null;
  /** Most one person can buy. null: no limit (downloads are always one each). */
  perBuyerLimit: number | null;
  /** quantity minus units sold or held in unpaid orders. null when there is no set number. */
  remaining: number | null;
  soldOut: boolean;
  soldOutAt: string | null;
  /** Units you have bought or are paying for right now (signed in only). */
  yours?: number;
}

/** What the seller sees about their own drop. Nobody else gets these numbers. */
export interface DropStats {
  /** People waiting to be told when it opens. */
  waiting: number;
  /** Paid orders. */
  orders: number;
  unitsSold: number;
  /** Units in orders that aren't paid yet (held for up to DROP_HOLD_MINUTES). */
  unitsHeld: number;
  revenue: { currency: string; grossCents: number }[];
  items: { productId: string; sold: number; held: number; grossCents: number; soldOutAt: string | null }[];
}

export interface Drop {
  id: string;
  title: string;
  description: string;
  coverUrl: string | null;
  coverAlt: string | null;
  startsAt: string;
  endsAt: string | null;
  status: DropStatus;
  /** Why an ended drop ended. */
  endReason: 'time' | 'sold_out' | null;
  seller: PublicUser;
  items: DropItem[];
  /** You asked to be told when it opens. */
  reminded: boolean;
  isSeller: boolean;
  publishedAt: string | null;
  openedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  stats?: DropStats;
}

/** "Your drops": drops you are waiting for, and what you bought in drops. */
export interface DropActivity {
  drop: Drop;
  purchases: { orderId: string; productId: string; title: string; quantity: number; status: 'held' | 'paid' | 'released'; createdAt: string }[];
}

/** What anyone can see of a shared drop link (Open Graph, the signed-out page). */
export interface PublicDropPreview {
  id: string;
  title: string;
  excerpt: string;
  seller: PublicAuthor;
  coverUrl: string | null;
  startsAt: string;
  endsAt: string | null;
  status: Exclude<DropStatus, 'draft'>;
  itemCount: number;
}

export type DropScheduleProblem = 'startInvalid' | 'startTooSoon' | 'startTooLate' | 'endInvalid' | 'endTooSoon' | 'endTooLate';

/**
 * Whether a start and optional end time can be used: the start from DROP_MIN_LEAD_MINUTES to
 * DROP_MAX_LEAD_DAYS ahead, the end DROP_MIN_OPEN_MINUTES to DROP_MAX_OPEN_DAYS after the start.
 * `slackMs` forgives a form that took a moment to send. Returns the problem, or null.
 */
export function dropScheduleProblem(
  startsAt: string | Date,
  endsAt: string | Date | null | undefined,
  now: Date = new Date(),
  slackMs = 30_000,
): { field: 'startsAt' | 'endsAt'; problem: DropScheduleProblem } | null {
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) return { field: 'startsAt', problem: 'startInvalid' };
  if (start < now.getTime() + DROP_MIN_LEAD_MINUTES * 60_000 - slackMs) return { field: 'startsAt', problem: 'startTooSoon' };
  if (start > now.getTime() + DROP_MAX_LEAD_DAYS * 86_400_000) return { field: 'startsAt', problem: 'startTooLate' };
  if (endsAt === null || endsAt === undefined) return null;
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return { field: 'endsAt', problem: 'endInvalid' };
  if (end < start + DROP_MIN_OPEN_MINUTES * 60_000) return { field: 'endsAt', problem: 'endTooSoon' };
  if (end > start + DROP_MAX_OPEN_DAYS * 86_400_000) return { field: 'endsAt', problem: 'endTooLate' };
  return null;
}

/** Plain English for each problem, for the API (the apps have their own translated text). */
export const DROP_SCHEDULE_MESSAGES: Record<DropScheduleProblem, string> = {
  startInvalid: 'Choose a date and time.',
  startTooSoon: `Choose a start at least ${DROP_MIN_LEAD_MINUTES} minutes from now.`,
  startTooLate: `Choose a start within the next ${DROP_MAX_LEAD_DAYS} days.`,
  endInvalid: 'Choose a date and time.',
  endTooSoon: `Choose an end at least ${DROP_MIN_OPEN_MINUTES} minutes after the start.`,
  endTooLate: `Choose an end within ${DROP_MAX_OPEN_DAYS} days of the start.`,
};

/** The calendar day of `x` in that zone (or on this device), as a UTC midnight to count days between. */
function dayKey(x: Date, timeZone?: string): number {
  if (!timeZone) return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }).formatToParts(x);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
}

/**
 * What a drop's time says, for plain wording: "today", "tomorrow", a weekday within the next
 * six days, or a date. `day` is the weekday or date text and `time` the time, both in the
 * viewer's locale and time zone.
 */
export function dropDay(
  at: string | Date,
  locale: string,
  now: Date = new Date(),
  timeZone?: string,
): { kind: 'today' | 'tomorrow' | 'weekday' | 'date'; day: string; time: string } {
  const d = new Date(at);
  const zone = timeZone ? { timeZone } : {};
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...zone }).format(d);
  const key = (x: Date) => dayKey(x, timeZone);
  const days = Math.round((key(d) - key(now)) / 86_400_000);
  if (days === 0) return { kind: 'today', day: '', time };
  if (days === 1) return { kind: 'tomorrow', day: '', time };
  if (days > 1 && days < 7) return { kind: 'weekday', day: new Intl.DateTimeFormat(locale, { weekday: 'long', ...zone }).format(d), time };
  const sameYear = new Date(key(d)).getUTCFullYear() === new Date(key(now)).getUTCFullYear();
  return {
    kind: 'date',
    day: new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), ...zone }).format(d),
    time,
  };
}

/**
 * How long until a moment, for a calm "in 2 days": hours or minutes (rounded down, never seconds)
 * within a day; beyond that, calendar days, counted like dropDay so the two agree ("Opens Wednesday
 * · in 2 days" on a Monday, even when it's 47 hours away). null once it has passed.
 */
export function dropCountdown(at: string | Date, now: Date = new Date(), timeZone?: string): { value: number; unit: 'day' | 'hour' | 'minute' } | null {
  const ms = new Date(at).getTime() - now.getTime();
  if (!(ms > 0)) return null;
  if (ms >= 86_400_000) return { value: Math.max(1, Math.round((dayKey(new Date(at), timeZone) - dayKey(now, timeZone)) / 86_400_000)), unit: 'day' };
  if (ms >= 3_600_000) return { value: Math.floor(ms / 3_600_000), unit: 'hour' };
  return { value: Math.max(1, Math.floor(ms / 60_000)), unit: 'minute' };
}

/**
 * Where a drop is for a viewer right now. A scheduled drop whose start has passed but that the
 * server hasn't opened yet reads as "opening" (it opens within moments).
 */
export function dropPhase(d: Pick<Drop, 'status' | 'startsAt'>, now: Date = new Date()): 'draft' | 'upcoming' | 'opening' | 'open' | 'ended' | 'cancelled' {
  if (d.status === 'scheduled') return new Date(d.startsAt).getTime() <= now.getTime() ? 'opening' : 'upcoming';
  return d.status === 'draft' ? 'draft' : d.status;
}
