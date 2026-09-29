import { describe, expect, it } from 'vitest';
import { t, tp } from './i18n.ts';
import { callLineText, groupLineText } from './message-preview.ts';
import type { MessageKey, PluralKey } from './i18n-core.ts';

const tr = (locale: string, meId?: string) => ({ t: (key: MessageKey, vars?: Record<string, string | number>) => t(key, locale, vars), locale, meId });

describe('call lines', () => {
  const withTp = (locale: string, meId?: string) => ({ ...tr(locale, meId), tp: (key: PluralKey, count: number) => tp(key, count, locale) });
  it('say how a call went, from each side', () => {
    expect(callLineText({ kind: 'video', outcome: 'missed', seconds: null }, 'ada', withTp('en', 'bo'))).toBe('Missed video call');
    expect(callLineText({ kind: 'video', outcome: 'missed', seconds: null }, 'ada', withTp('en', 'ada'))).toBe('Video call, no answer');
    expect(callLineText({ kind: 'audio', outcome: 'declined', seconds: null }, 'ada', withTp('en', 'bo'))).toBe('Audio call declined');
    expect(callLineText({ kind: 'audio', outcome: 'ended', seconds: 20 }, 'ada', withTp('en'))).toBe('Audio call, 1 minute');
    expect(callLineText({ kind: 'audio', outcome: 'ended', seconds: 185 }, 'ada', withTp('en'))).toBe('Audio call, 3 minutes');
    expect(callLineText({ kind: 'video', outcome: 'ended', seconds: 185 }, 'ada', withTp('fr'))).toBe('Appel vidéo, 3 minutes');
  });
});

describe('group lines', () => {
  it('say who changed the group, in the reader’s language', () => {
    const people = [
      { id: 'b', displayName: 'Bo' },
      { id: 'c', displayName: 'Cy' },
    ];
    expect(groupLineText({ action: 'added', people }, 'Ada', tr('en'))).toBe('Ada added Bo and Cy.');
    expect(groupLineText({ action: 'renamed', title: 'Weekend' }, 'Ada', tr('en'))).toBe('Ada renamed the group to Weekend.');
    expect(groupLineText({ action: 'left' }, 'Bo', tr('en'))).toBe('Bo left the group.');
    expect(groupLineText({ action: 'promoted', people: [people[0]!] }, 'Ada', tr('en'))).toBe('Bo is now an admin.');
    expect(groupLineText({ action: 'added', people }, 'Ada', tr('fr'))).toBe('Ada a ajouté Bo et Cy.');
  });

  it('name the reader as “you”', () => {
    expect(groupLineText({ action: 'removed', people: [{ id: 'me', displayName: 'Me' }] }, 'Ada', tr('en', 'me'))).toBe('Ada removed you.');
    expect(groupLineText({ action: 'admin', people: [{ id: 'me', displayName: 'Me' }] }, 'Ada', tr('en', 'me'))).toBe('Ada made you an admin.');
    expect(groupLineText({ action: 'promoted', people: [{ id: 'me', displayName: 'Me' }] }, 'Ada', tr('en', 'me'))).toBe('You’re now an admin.');
  });
});
