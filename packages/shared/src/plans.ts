import type { MessageKey, PluralKey } from './i18n-core.ts';
import type { PublicUser } from './types.ts';

/**
 * Go out together (docs/product/go-out-together.md), step 2 of "Your city, alive": say you're
 * free, make plans with your friends around what Wander shows, answer I'm in / Maybe / Can't,
 * talk it over in the plan's own group chat (with polls to pick a time or a place), and keep track
 * of who paid for what. No money moves through YAPILAPI: the cost split only keeps count.
 *
 * Pure helpers and types, safe for the phone (no zod; the request schemas are in plan-schemas.ts).
 */

export const PLAN_ANSWERS = ['in', 'maybe', 'cant'] as const;
export type PlanAnswer = (typeof PLAN_ANSWERS)[number];
/** Someone invited who hasn't answered yet is 'pending'. */
export type PlanPersonAnswer = PlanAnswer | 'pending';

/** Where a plan happens: a place page, an event or a stash from Wander, or just words. */
export const PLAN_PLACE_KINDS = ['place', 'event', 'stash', 'text'] as const;
export type PlanPlaceKind = (typeof PLAN_PLACE_KINDS)[number];

export const PLAN_RULES = {
  titleMax: 80,
  noteMax: 300,
  placeMax: 80,
  /** People in one plan, its maker and everyone invited included. */
  maxPeople: 30,
  /** A plan can be up to this many days ahead. */
  aheadDays: 90,
  /** Plans one person can make in a day. */
  perDay: 20,
  /** "I'm free": a few words, and how long it can last (it ends by itself). */
  freeNoteMax: 80,
  freeMinMinutes: 15,
  freeMaxHours: 18,
  /** "Now" means the next two hours. */
  freeNowHours: 2,
  /** Cost split: what it was for, the biggest amount (in cents, about a million units), and how many in one plan. */
  expenseTitleMax: 60,
  maxExpenseCents: 100_000_000,
  maxExpenses: 100,
} as const;

/** Where, as the viewer may see it: the linked thing only when they can see it themselves. */
export interface PlanPlace {
  kind: PlanPlaceKind;
  /** The place, event or stash; null for words. */
  id: string | null;
  name: string | null;
}

export interface PlanPerson {
  user: PublicUser;
  answer: PlanPersonAnswer;
  /** The person who made the plan. */
  maker: boolean;
}

export interface PlanCounts {
  in: number;
  maybe: number;
  cant: number;
  pending: number;
}

/** One share of an expense: who and how much (in cents). */
export interface PlanShare {
  userId: string;
  shareCents: number;
}

export interface PlanExpense {
  id: string;
  title: string;
  amountCents: number;
  currency: string;
  paidBy: string;
  addedBy: string;
  shares: PlanShare[];
  createdAt: string;
  /** Whoever added it, or the plan's maker, can remove it. */
  canRemove: boolean;
}

/** "Bola paid Ada back ₦5,000": marked by one of the two. */
export interface PlanSettlement {
  id: string;
  from: string;
  to: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  /** Whoever marked it can undo it. */
  canUndo: boolean;
}

/** Who owes whom, simplified: as few payments as possible settle everything. */
export interface PlanDebt {
  from: string;
  to: string;
  amountCents: number;
  currency: string;
}

export interface PlanCosts {
  expenses: PlanExpense[];
  settlements: PlanSettlement[];
  debts: PlanDebt[];
}

export interface Plan {
  id: string;
  title: string;
  note: string;
  startsAt: string;
  place: PlanPlace | null;
  status: 'active' | 'cancelled';
  maker: PublicUser;
  /** The squad it was made for, for people in that squad. */
  squad: { id: string; name: string } | null;
  /** Everyone in it (people blocked either way with the viewer left out), the maker first. */
  people: PlanPerson[];
  counts: PlanCounts;
  viewer: { answer: PlanPersonAnswer; maker: boolean; canInvite: boolean };
  /** The plan's group chat, for the people in it (in or maybe, and the maker). */
  conversationId: string | null;
  /** Who paid for what, for everyone who has answered. */
  costs: PlanCosts | null;
  createdAt: string;
  updatedAt: string;
}

/** A plan in your list. */
export interface PlanCard {
  id: string;
  title: string;
  startsAt: string;
  place: PlanPlace | null;
  status: 'active' | 'cancelled';
  maker: PublicUser;
  answer: PlanPersonAnswer;
  counts: PlanCounts;
  conversationId: string | null;
}

/** "I'm free": your own, while it lasts. */
export interface FreeNow {
  note: string;
  until: string;
}

/** A friend who said they're free. */
export interface FreeFriend {
  user: PublicUser;
  note: string;
  until: string;
}

// ─── Cost split ─────────────────────────────────────────────────────────

/**
 * Split an amount (in cents) equally between people, in the order given with duplicates left out.
 * Cents that don't divide go one each to the first people, so the shares always add up.
 */
export function splitEvenly(amountCents: number, userIds: string[]): PlanShare[] {
  const ids = [...new Set(userIds)];
  if (!ids.length || amountCents <= 0) return [];
  const base = Math.floor(amountCents / ids.length);
  const extra = amountCents - base * ids.length;
  return ids.map((userId, i) => ({ userId, shareCents: base + (i < extra ? 1 : 0) }));
}

/**
 * Who owes whom, per currency, in as few payments as this simple way finds: everyone's balance
 * (what they paid, less their shares, plus what they paid back, less what they were paid back),
 * then the person who owes most pays the person owed most, and so on. Debts under a cent vanish.
 * The order is stable: by currency, then the largest first, then by id.
 */
export function planDebts(
  expenses: { paidBy: string; currency: string; shares: PlanShare[] }[],
  settlements: { from: string; to: string; amountCents: number; currency: string }[],
): PlanDebt[] {
  const net = new Map<string, Map<string, number>>();
  const add = (currency: string, user: string, cents: number) => {
    const m = net.get(currency) ?? new Map<string, number>();
    m.set(user, (m.get(user) ?? 0) + cents);
    net.set(currency, m);
  };
  for (const e of expenses)
    for (const s of e.shares) {
      add(e.currency, e.paidBy, s.shareCents);
      add(e.currency, s.userId, -s.shareCents);
    }
  for (const s of settlements) {
    add(s.currency, s.from, s.amountCents);
    add(s.currency, s.to, -s.amountCents);
  }
  const debts: PlanDebt[] = [];
  for (const currency of [...net.keys()].sort()) {
    const byBalance = (sign: 1 | -1) =>
      [...net.get(currency)!.entries()]
        .filter(([, v]) => sign * v > 0)
        .map(([id, v]) => ({ id, left: Math.abs(v) }))
        .sort((a, b) => b.left - a.left || (a.id < b.id ? -1 : 1));
    const owed = byBalance(1);
    const owing = byBalance(-1);
    let i = 0;
    let j = 0;
    while (i < owing.length && j < owed.length) {
      const pay = Math.min(owing[i]!.left, owed[j]!.left);
      if (pay > 0) debts.push({ from: owing[i]!.id, to: owed[j]!.id, amountCents: pay, currency });
      owing[i]!.left -= pay;
      owed[j]!.left -= pay;
      if (owing[i]!.left === 0) i++;
      if (owed[j]!.left === 0) j++;
    }
  }
  return debts;
}

/** What one person owes in a currency right now (0 when nothing), from the simplified debts. */
export const owedBy = (debts: PlanDebt[], from: string, to: string, currency: string): number =>
  debts.filter((d) => d.from === from && d.to === to && d.currency === currency).reduce((n, d) => n + d.amountCents, 0);

// ─── Words ──────────────────────────────────────────────────────────────

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;
type TrPlural = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

export const PLAN_NOTICES = ['plan_invite', 'plan_answer', 'plan_changed', 'plan_cancelled'] as const;

export const PLAN_ANSWER_KEYS: Record<PlanPersonAnswer, MessageKey> = {
  in: 'plans.answer.in',
  maybe: 'plans.answer.maybe',
  cant: 'plans.answer.cant',
  pending: 'plans.answer.pending',
};

/**
 * Notifications about plans, in the reader's language, or null for other kinds: "Ada invited you:
 * Suya and a film", "Ada is in: Suya and a film", "Ada and 2 others answered: …", "Ada changed the
 * plan: …", "Ada cancelled: …".
 */
export function planNoticeText(n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> }, t: Tr, tp: TrPlural): string | null {
  const name = n.actor?.displayName ?? t('push.someone');
  const plan = String(n.data.title ?? '');
  switch (n.type) {
    case 'plan_invite':
      return t('push.plan_invite', { name, plan });
    case 'plan_answer': {
      const others = Math.max(0, (Number(n.data.count ?? 1) || 1) - 1);
      if (others) return tp('push.plan_answer', others, { name, plan });
      const answer = n.data.answer === 'maybe' ? 'maybe' : n.data.answer === 'cant' ? 'cant' : 'in';
      return t(`plans.notif.${answer}`, { name, plan });
    }
    case 'plan_changed':
      return t('push.plan_changed', { name, plan });
    case 'plan_cancelled':
      return t('push.plan_cancelled', { name, plan });
    default:
      return null;
  }
}

/** The plan a notification opens, or null for other kinds. */
export function planNoticeHref(n: { type: string; entityId?: string | null }): string | null {
  return (PLAN_NOTICES as readonly string[]).includes(n.type) && n.entityId ? n.entityId : null;
}

/** "Tonight" for "I'm free": until midnight where you are, at least FREE_MIN_MINUTES from now (just after midnight: the next two hours). */
export function freeTonightUntil(now: Date = new Date()): Date {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const min = now.getTime() + PLAN_RULES.freeMinMinutes * 60_000;
  return midnight.getTime() - now.getTime() > PLAN_RULES.freeMaxHours * 3_600_000 || midnight.getTime() < min
    ? new Date(now.getTime() + PLAN_RULES.freeNowHours * 3_600_000)
    : midnight;
}
