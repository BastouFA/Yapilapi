import type { MessageKey, PluralKey } from './i18n-core.ts';
import type { PostReasonCode, PostReasonParams, WhyReason, WhyReasonCode } from './types.ts';

/**
 * Why a post is in your feed, in the reader's language.
 *
 * The API sends a code and the names it mentions (`Post.reasonCode` and `reasonParams`, and the
 * lines of GET /v1/posts/:id/why); the web and the phone put them into words here, and the API
 * writes its English `reason` for older apps with the same keys. The phone imports this file
 * directly, so no zod.
 */

export const POST_REASON_KEYS: Record<PostReasonCode, MessageKey> = {
  own: 'feed.reason.own',
  friend: 'feed.reason.friend',
  follow: 'feed.reason.follow',
  reposted: 'feed.reason.reposted',
  community_member: 'feed.reason.communityMember',
  interest: 'feed.reason.interest',
  community_popular: 'feed.reason.communityPopular',
  popular: 'feed.reason.popular',
};

/** "Why am I seeing this?" lines. Topics come in a plural pair, by how many topics it's in. */
export const WHY_REASON_KEYS: Record<Exclude<WhyReasonCode, 'topics'>, MessageKey> & { topics: PluralKey } = {
  personalization_off: 'feed.why.personalizationOff',
  friend: 'feed.why.friend',
  follow: 'feed.why.follow',
  community: 'feed.why.community',
  topics: 'feed.why.topics',
  engagement: 'feed.why.engagement',
  fallback: 'feed.why.fallback',
};

type Vars = Record<string, string | number>;
export interface ReasonTranslator {
  t: (key: MessageKey, vars?: Vars) => string;
  tp: (key: PluralKey, count: number, vars?: Vars) => string;
  /** For joining a list of topics ("a, b and c"); without it they're joined with commas. */
  locale?: string;
}

/** Why the post is in your feed, or null when the feed didn't say. Falls back to the English `reason` from an older API. */
export function postReasonText(
  post: { reason?: string; reasonCode?: PostReasonCode; reasonParams?: PostReasonParams },
  tr: Pick<ReasonTranslator, 't'>,
): string | null {
  const key = post.reasonCode ? POST_REASON_KEYS[post.reasonCode] : undefined;
  if (!key) return post.reason || null;
  const p = post.reasonParams ?? {};
  return tr.t(key, { name: p.name ?? '', community: p.community ?? '', topic: p.topic ?? '' });
}

/** "a, b and c" in the language of `locale`; without one (or without list formatting on the device), "a, b, c". */
export function formatList(items: string[], locale: string | undefined): string {
  if (locale) {
    try {
      return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
    } catch {
      // No list formatting on this device or for this tag: commas below.
    }
  }
  return items.join(', ');
}

/** One line of "Why am I seeing this?" in the reader's language. */
export function whyReasonText(reason: WhyReason, tr: ReasonTranslator): string {
  const p = reason.params ?? {};
  if (reason.code === 'topics') {
    const topics = p.topics ?? [];
    return tr.tp(WHY_REASON_KEYS.topics, topics.length, { topics: formatList(topics, tr.locale) });
  }
  const key = WHY_REASON_KEYS[reason.code];
  return key ? tr.t(key, { name: p.name ?? '', community: p.community ?? '' }) : '';
}
