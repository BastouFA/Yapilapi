import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  directionOf,
  humanize,
  interpolate,
  negotiateLocale,
  placeholdersOf,
  resolveMessage,
} from './core';

describe('interpolate and plurals', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(interpolate('Hi {name}, {n} left', { name: 'Ada', n: 3 }, 'en')).toBe('Hi Ada, 3 left');
    expect(interpolate('Hi {name}', {}, 'en')).toBe('Hi {name}');
  });

  it('formats numbers for the locale', () => {
    expect(interpolate('{n}', { n: 12345.5 }, 'en')).toBe('12,345.5');
    expect(interpolate('{n}', { n: 1234 }, 'fr')).toMatch(/1\s234/);
  });

  it('chooses plural forms per locale', () => {
    const m = { one: '{count} day', other: '{count} days' };
    expect(resolveMessage(m, { count: 1 }, 'en')).toBe('1 day');
    expect(resolveMessage(m, { count: 7 }, 'en')).toBe('7 days');
    const ar = {
      zero: 'صفر',
      one: 'يوم',
      two: 'يومان',
      few: '{count} أيام',
      many: '{count} يومًا',
      other: '{count} يوم',
    };
    expect(resolveMessage(ar, { count: 2 }, 'ar')).toBe('يومان');
    expect(resolveMessage(ar, { count: 0 }, 'ar')).toBe('صفر');
  });

  it('lists every placeholder of every plural form', () => {
    expect(
      placeholdersOf({ one: '{count} of {total}', other: '{count} of {total} ({x})' }),
    ).toEqual(['count', 'total', 'x']);
  });
});

describe('translator', () => {
  const base = { a: 'Hello {name}', b: 'Only English' } as const;
  it('uses the override, then falls back to English, then to the key', () => {
    const t = createTranslator(base, { a: 'Bonjour {name}' }, 'fr') as (
      k: string,
      p?: Record<string, string>,
    ) => string;
    expect(t('a', { name: 'Ada' })).toBe('Bonjour Ada');
    expect(t('b')).toBe('Only English');
    expect(t('nope')).toBe('nope');
  });
});

describe('locale helpers', () => {
  it('humanizes unknown enum values from the API', () => {
    expect(humanize('in_review')).toBe('In review');
    expect(humanize('pending.kyc-check')).toBe('Pending kyc check');
    expect(humanize('')).toBe('');
  });

  it('negotiates a supported language from Accept-Language', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(negotiateLocale('de,ar;q=0.5')).toBe('ar');
    expect(negotiateLocale('yo')).toBe('yo');
    expect(negotiateLocale('de,ja')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
  });

  it('flags Arabic as right-to-left only', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(['en', 'fr', 'yo'].map((l) => directionOf(l as 'en'))).toEqual(['ltr', 'ltr', 'ltr']);
  });
});
