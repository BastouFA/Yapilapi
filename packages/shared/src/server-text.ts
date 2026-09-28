import type { MessageKey, PluralKey } from './i18n-core.ts';
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
  return key ? tr.t(key, { topics: formatList(w.params?.topics ?? [], tr.locale) }) : '';
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

/** The small line under an assistant's card: a community's member count in words, else what the API sent. */
export function agentSubtitle(e: { type: string; subtitle?: string; memberCount?: number }, tp: ReasonTranslator['tp']): string | undefined {
  return e.type === 'community' && typeof e.memberCount === 'number' ? tp('m.community.members', e.memberCount) : e.subtitle;
}
