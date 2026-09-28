import { describe, expect, it } from 'vitest';
import { CATALOGS, SUPPORTED_LOCALES, t, tp, type MessageKey } from './i18n.ts';
import {
  AD_WHY_KEYS,
  AGENT_ACTION_KEYS,
  NOTICE_KEYS,
  SUGGESTION_REASON_KEYS,
  adWhyText,
  agentActionLabel,
  agentSubtitle,
  noticeText,
  suggestionReasonText,
} from './server-text.ts';
import type { ReasonTranslator } from './feed-reasons.ts';
import type { AdWhyCode, NoticeCode, SuggestionReasonCode } from './types.ts';

const tr = (locale: string): ReasonTranslator => ({ t: (k, v) => t(k, locale, v), tp: (k, n, v) => tp(k, n, locale, v), locale });

describe('sentences the API sends as codes', () => {
  // Every code in the unions: adding one without a sentence is a type error here.
  const notices: Record<NoticeCode, true> = {
    post_limited: true,
    post_held: true,
    answer_held: true,
    question_held: true,
    listing_held: true,
    message_held: true,
  };
  const adWhy: Record<AdWhyCode, true> = { opted_in: true, topics: true, language: true, country: true };
  const suggestions: Record<SuggestionReasonCode, true> = { mutual: true, shared_interests: true, topical: true, reels: true, popular: true };

  it('has a sentence in every language for every code', () => {
    const counted = new Set<string>([SUGGESTION_REASON_KEYS.mutual, SUGGESTION_REASON_KEYS.shared_interests]);
    const keys: string[] = [
      ...Object.keys(notices).map((c) => NOTICE_KEYS[c as NoticeCode]),
      ...Object.keys(adWhy).map((c) => AD_WHY_KEYS[c as AdWhyCode]),
      ...Object.keys(suggestions).flatMap((c) => {
        const key: string = SUGGESTION_REASON_KEYS[c as SuggestionReasonCode];
        return counted.has(key) ? [`${key}.one`, `${key}.other`] : [key];
      }),
      ...Object.values(AGENT_ACTION_KEYS),
      'ads.sponsored',
      'report.thanks',
    ];
    for (const locale of SUPPORTED_LOCALES) {
      const missing = keys.filter((k) => !CATALOGS[locale]![k as MessageKey]?.trim());
      expect(missing, locale).toEqual([]);
    }
  });

  it('writes the notes in the reader’s language, or shows what an older API sent', () => {
    expect(noticeText({ code: 'post_held', message: 'x' }, tr('en').t)).toBe('Your post is published to you only until it has been reviewed.');
    expect(noticeText({ code: 'listing_held', message: 'x' }, tr('fr').t)).toBe(t('notice.listingHeld', 'fr'));
    expect(noticeText({ message: 'Held, in English' }, tr('fr').t)).toBe('Held, in English');
    expect(noticeText(undefined, tr('fr').t)).toBeUndefined();
    expect(noticeText({ code: undefined, message: undefined }, tr('fr').t)).toBeUndefined();
  });

  it('names the ad’s topics joined for the language', () => {
    expect(adWhyText({ code: 'topics', params: { topics: ['jazz', 'film'] } }, tr('en'))).toBe("It's about jazz and film, which you follow.");
    expect(adWhyText({ code: 'opted_in' }, tr('en'))).toBe('You turned on advertising in your privacy settings.');
  });

  it('counts people and interests with a plural', () => {
    expect(suggestionReasonText({ reasonCode: 'mutual', reasonParams: { count: 1 } }, tr('en'))).toBe('Followed by 1 person you follow');
    expect(suggestionReasonText({ reasonCode: 'mutual', reasonParams: { count: 3 } }, tr('en'))).toBe('Followed by 3 people you follow');
    expect(suggestionReasonText({ reasonCode: 'shared_interests', reasonParams: { count: 2 } }, tr('en'))).toBe('2 shared interests');
    expect(suggestionReasonText({ reasonCode: 'popular' }, tr('en'))).toBe('Popular on YAPILAPI');
    expect(suggestionReasonText({ reason: 'Old English reason' }, tr('fr'))).toBe('Old English reason');
  });

  it('labels the assistant’s actions and member counts', () => {
    const join = { kind: 'join', label: 'Join: Film Club', target: { title: 'Film Club' } };
    expect(agentActionLabel(join, tr('en').t)).toBe('Join: Film Club');
    expect(agentActionLabel(join, tr('fr').t)).toBe('Rejoindre : Film Club');
    expect(agentActionLabel({ ...join, kind: 'teleport', label: 'Teleport: Film Club' }, tr('fr').t)).toBe('Teleport: Film Club');
    expect(agentSubtitle({ type: 'community', subtitle: '1 members', memberCount: 1 }, tr('en'))).toBe('1 member');
    expect(agentSubtitle({ type: 'place', subtitle: 'Café · Lagos' }, tr('en'))).toBe('Café · Lagos');
  });
});
