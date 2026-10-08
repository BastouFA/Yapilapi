import { describe, expect, it } from 'vitest';
import { CATALOGS, SUPPORTED_LOCALES, t, tp, type MessageKey } from './i18n.ts';
import { formatList, POST_REASON_KEYS, WHY_REASON_KEYS, postReasonText, whyReasonText, type ReasonTranslator } from './feed-reasons.ts';
import type { PostReasonCode, WhyReason, WhyReasonCode } from './types.ts';

const tr = (locale: string): ReasonTranslator => ({ t: (k, v) => t(k, locale, v), tp: (k, n, v) => tp(k, n, locale, v), locale });

describe('feed reasons', () => {
  // Every code in the unions: adding one without a sentence is a type error here.
  const postCodes: Record<PostReasonCode, true> = {
    own: true,
    friend: true,
    follow: true,
    reposted: true,
    community_member: true,
    interest: true,
    community_popular: true,
    popular: true,
    liked_creator: true,
    liked_topic: true,
    watched_topic: true,
    similar_people: true,
    trending: true,
    new_creator: true,
    ask_city: true,
  };
  const whyCodes: Record<WhyReasonCode, true> = {
    personalization_off: true,
    friend: true,
    follow: true,
    community: true,
    topics: true,
    engagement: true,
    fallback: true,
    learned_creator: true,
    learned_topics: true,
    similar_people: true,
    trending: true,
    new_creator: true,
  };

  it('has a sentence in every language for every code', () => {
    const keys: string[] = [
      ...Object.keys(postCodes).map((c) => POST_REASON_KEYS[c as PostReasonCode]),
      ...Object.keys(whyCodes).flatMap((c) => {
        const key: string = WHY_REASON_KEYS[c as WhyReasonCode];
        return c === 'topics' || c === 'learned_topics' ? [`${key}.one`, `${key}.other`] : [key];
      }),
    ];
    for (const locale of SUPPORTED_LOCALES) {
      const missing = keys.filter((k) => !CATALOGS[locale]![k as MessageKey]?.trim());
      expect(missing, locale).toEqual([]);
    }
  });

  it('writes the same English the feed used to send', () => {
    const en = tr('en');
    expect(postReasonText({ reasonCode: 'own' }, en)).toBe('Your post');
    expect(postReasonText({ reasonCode: 'friend', reasonParams: { name: 'Ada' } }, en)).toBe("You're friends with Ada");
    expect(postReasonText({ reasonCode: 'reposted', reasonParams: { name: 'Ben' } }, en)).toBe('Ben reposted');
    expect(postReasonText({ reasonCode: 'community_member', reasonParams: { community: 'Film Club' } }, en)).toBe("From Film Club, a community you're in");
    expect(postReasonText({ reasonCode: 'interest', reasonParams: { topic: 'jazz' } }, en)).toBe("You're interested in jazz");
    expect(postReasonText({ reasonCode: 'popular' }, en)).toBe('Popular with people on YAPILAPI right now');
  });

  it('puts the names into the reader’s language', () => {
    expect(postReasonText({ reasonCode: 'follow', reasonParams: { name: 'Ada' } }, tr('fr'))).toBe('Tu suis Ada');
    expect(postReasonText({ reasonCode: 'community_popular', reasonParams: { community: 'Kano' } }, tr('es'))).toBe('Popular en Kano');
  });

  it('shows the English an older API sent, and nothing when there is no reason', () => {
    expect(postReasonText({ reason: 'Ben reposted' }, tr('fr'))).toBe('Ben reposted');
    expect(postReasonText({}, tr('fr'))).toBeNull();
  });

  it('says "topic" or "topics" by how many, joined for the language', () => {
    const one: WhyReason = { code: 'topics', params: { topics: ['jazz'] } };
    const two: WhyReason = { code: 'topics', params: { topics: ['jazz', 'film'] } };
    expect(whyReasonText(one, tr('en'))).toBe('You follow the topic jazz.');
    expect(whyReasonText(two, tr('en'))).toBe('You follow the topics jazz and film.');
    // Where the device can't format lists (the phone), the catalog's own words join them.
    expect(whyReasonText(two, { ...tr('en'), locale: undefined })).toBe('You follow the topics jazz and film.');
    expect(formatList(['a', 'b', 'c'], undefined, (k) => t(k, 'fr'))).toBe('a, b et c');
    expect(formatList(['a', 'b'], undefined)).toBe('a, b');
    expect(whyReasonText(two, tr('fr'))).toBe('Tu suis les sujets jazz et film.');
    expect(whyReasonText({ code: 'friend', params: { name: 'Femi' } }, tr('en'))).toBe("You're friends with Femi.");
    expect(whyReasonText({ code: 'fallback' }, tr('pt'))).toBe(t('feed.why.fallback', 'pt'));
  });
});
