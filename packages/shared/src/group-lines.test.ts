import { describe, expect, it } from 'vitest';
import { t } from './i18n.ts';
import { groupLineText } from './message-preview.ts';
import type { MessageKey } from './i18n-core.ts';

const tr = (locale: string, meId?: string) => ({ t: (key: MessageKey, vars?: Record<string, string | number>) => t(key, locale, vars), locale, meId });

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
