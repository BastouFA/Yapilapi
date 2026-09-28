import { formatMoney, type MessageKey, type PluralKey } from './i18n-core.ts';
import type { PRODUCT_KINDS, REPORT_TARGETS } from './constants.ts';
import { formatList, type ReasonTranslator } from './feed-reasons.ts';
import type { AdWhy, AdWhyCode, NoticeCode, SuggestionReasonCode } from './types.ts';

/**
 * Sentences the API used to write in English and the apps showed as they were: notes after
 * publishing something that waits for review, why an ad is shown, why someone is suggested,
 * and the assistant's buttons. The API now sends a code (and the numbers or names it needs);
 * the web and the phone put it into words here, and the API still writes the English for older
 * apps from the same messages. The phone imports this file directly, so no zod.
 */

export const NOTICE_KEYS: Record<NoticeCode, MessageKey> = {
  post_limited: 'notice.postLimited',
  post_held: 'notice.postHeld',
  answer_held: 'notice.answerHeld',
  question_held: 'notice.questionHeld',
  listing_held: 'notice.listingHeld',
  message_held: 'notice.messageHeld',
};

type T = ReasonTranslator['t'];

/**
 * A note from the API in the reader's language: `{ code, message }` (a moderation notice), or
 * `{ code: r.noticeCode, message: r.notice }`. Falls back to the English message from an older
 * API; undefined when there is no note.
 */
export function noticeText(n: { code?: NoticeCode | null; message?: string | null } | null | undefined, t: T): string | undefined {
  const key = n?.code ? NOTICE_KEYS[n.code] : undefined;
  return key ? t(key) : n?.message || undefined;
}

export const AD_WHY_KEYS: Record<AdWhyCode, MessageKey> = {
  opted_in: 'ads.why.optedIn',
  topics: 'ads.why.topics',
  language: 'ads.why.language',
  country: 'ads.why.country',
};

/** One line of "Why am I seeing this ad?", topics joined for the language. */
export function adWhyText(w: AdWhy, tr: Pick<ReasonTranslator, 't' | 'locale'>): string {
  const key = AD_WHY_KEYS[w.code];
  return key ? tr.t(key, { topics: formatList(w.params?.topics ?? [], tr.locale, (k) => tr.t(k)) }) : '';
}

/** Counted reasons come in `.one` / `.other` pairs. */
export const SUGGESTION_REASON_KEYS: { mutual: PluralKey; shared_interests: PluralKey } & Record<
  Exclude<SuggestionReasonCode, 'mutual' | 'shared_interests'>,
  MessageKey
> = {
  mutual: 'suggest.reason.mutual',
  shared_interests: 'suggest.reason.sharedInterests',
  topical: 'suggest.reason.topical',
  reels: 'suggest.reason.reels',
  popular: 'suggest.reason.popular',
};

/** Why someone is suggested, or the English `reason` from an older API. */
export function suggestionReasonText(
  s: { reason?: string; reasonCode?: SuggestionReasonCode; reasonParams?: { count?: number } },
  tr: Pick<ReasonTranslator, 't' | 'tp'>,
): string {
  const code = s.reasonCode;
  if (!code || !(code in SUGGESTION_REASON_KEYS)) return s.reason ?? '';
  if (code === 'mutual' || code === 'shared_interests') return tr.tp(SUGGESTION_REASON_KEYS[code], s.reasonParams?.count ?? 0);
  return tr.t(SUGGESTION_REASON_KEYS[code]);
}

export type AgentActionKind = 'rsvp' | 'book' | 'buy' | 'follow' | 'join';

export const AGENT_ACTION_KEYS: Record<AgentActionKind, MessageKey> = {
  rsvp: 'agent.action.rsvp',
  book: 'agent.action.book',
  buy: 'agent.action.buy',
  follow: 'agent.action.follow',
  join: 'agent.action.join',
};

/** An assistant's proposed action as a button label ("Join: Film Club"), or the English label for a kind this app doesn't know. */
export function agentActionLabel(a: { kind: string; label: string; target: { title: string } }, t: T): string {
  const key = AGENT_ACTION_KEYS[a.kind as AgentActionKind];
  return key ? t(key, { title: a.target.title }) : a.label;
}

export const PRODUCT_KIND_KEYS: Record<(typeof PRODUCT_KINDS)[number], MessageKey> = {
  product: 'shop.kind.product',
  service: 'm.shop.service',
  ticket: 'tickets.label.type',
  booking: 'shop.kind.booking',
  digital: 'shop.kind.digital',
};

/** An amount in the reader's format, or plain digits and the currency code where the device can't format it. */
function money(cents: number, currency: string, locale: string | undefined): string {
  try {
    return formatMoney(cents, currency, locale ?? 'en');
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * The small line under an assistant's card: a community's member count, or a product's price
 * and kind ("₦5,000.00 · Download"), in the reader's language; else what the API sent.
 */
export function agentSubtitle(
  e: { type: string; subtitle?: string; memberCount?: number; priceCents?: number; currency?: string; productKind?: string },
  tr: Pick<ReasonTranslator, 't' | 'tp' | 'locale'>,
): string | undefined {
  if (e.type === 'community' && typeof e.memberCount === 'number') return tr.tp('m.community.members', e.memberCount);
  if (e.type === 'product' && typeof e.priceCents === 'number' && e.currency) {
    const key = PRODUCT_KIND_KEYS[e.productKind as keyof typeof PRODUCT_KIND_KEYS];
    return [money(e.priceCents, e.currency, tr.locale), key ? tr.t(key) : ''].filter(Boolean).join(' · ');
  }
  return e.subtitle;
}

/**
 * The `new_sign_in` notification as a sentence: which device, and roughly where when known. The
 * API names both in the reader's language (`deviceLabel`, `placeLabel`: the phone can't name
 * countries itself); older APIs sent them in English only. Null for other kinds.
 */
export function signInNoticeText(n: { type: string; data: Record<string, unknown> }, t: T): string | null {
  if (n.type !== 'new_sign_in') return null;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const device = text(n.data.deviceLabel) ?? text(n.data.device) ?? '';
  const place = text(n.data.placeLabel) ?? text(n.data.place);
  return place ? t('m.notif.newSignInPlace', { device, place }) : t('m.notif.newSignIn', { device });
}

/** A campaign's name: a boost is named after its post ("Boost: Our new menu"), in the reader's language; others as their owner wrote it. */
export function campaignName(c: { name: string; nameCode?: string | null; nameParams?: { excerpt?: string } | null }, t: T): string {
  if (c.nameCode !== 'boost') return c.name;
  const excerpt = c.nameParams?.excerpt?.trim();
  return excerpt ? t('ads.boostName', { excerpt }) : t('ads.boostNameEmpty');
}

export type ModerationDecision = 'no_action' | 'restrict' | 'remove' | 'suspend_user';
export type AppealStatus = 'open' | 'upheld' | 'overturned';

/** What a decision was about, as a short label ("Post", "Your account"). */
export const MODERATION_TARGET_KEYS: Record<(typeof REPORT_TARGETS)[number], MessageKey> = {
  user: 'moderation.target.user',
  post: 'moderation.target.post',
  comment: 'moderation.target.comment',
  message: 'moderation.target.message',
  community: 'moderation.target.community',
  event: 'moderation.target.event',
  product: 'moderation.target.product',
  story: 'moderation.target.story',
  room: 'moderation.target.room',
  live: 'moderation.target.live',
  question: 'moderation.target.question',
  answer: 'moderation.target.answer',
  drop: 'moderation.target.drop',
  mix: 'moderation.target.mix',
  together_item: 'moderation.target.togetherItem',
  listing: 'moderation.target.listing',
};

export const MODERATION_DECISION_KEYS: Record<ModerationDecision, MessageKey> = {
  no_action: 'moderation.decision.noAction',
  restrict: 'moderation.decision.restrict',
  remove: 'moderation.decision.remove',
  suspend_user: 'moderation.decision.suspendUser',
};

export const APPEAL_STATUS_KEYS: Record<AppealStatus, MessageKey> = {
  open: 'moderation.appeal.open',
  upheld: 'moderation.appeal.upheld',
  overturned: 'moderation.appeal.overturned',
};

/** A decision about your content in Settings: "Post: Removed". Codes this app doesn't know are shown readably. */
export function moderationCaseText(c: { target_type: string; decision: string }, t: T): string {
  const target = MODERATION_TARGET_KEYS[c.target_type as keyof typeof MODERATION_TARGET_KEYS];
  const decision = MODERATION_DECISION_KEYS[c.decision as ModerationDecision];
  return t('moderation.case', {
    target: target ? t(target) : c.target_type.replace(/_/g, ' '),
    decision: decision ? t(decision) : c.decision.replace(/_/g, ' '),
  });
}

/** Where your appeal is, as a sentence. */
export function appealStatusText(status: string, t: T): string {
  const key = APPEAL_STATUS_KEYS[status as AppealStatus];
  return key ? t(key) : t('settings.appeal.status', { status: status.replace(/_/g, ' ') });
}
