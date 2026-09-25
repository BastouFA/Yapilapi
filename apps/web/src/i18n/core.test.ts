import { describe, expect, it } from 'vitest';
import { interpolate, isLocale, negotiateLocale, placeholdersOf, resolveMessage } from './core';

describe('negotiateLocale', () => {
  it('picks the best supported language by q-value', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(negotiateLocale('de;q=0.9, ar;q=0.8, en;q=0.1')).toBe('ar');
    expect(negotiateLocale('yo-NG')).toBe('yo');
  });
  it('falls back to English', () => {
    expect(negotiateLocale(null)).toBe('en');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale('zh-CN,ja;q=0.8')).toBe('en');
  });
  it('isLocale guards unknown values', () => {
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('xx')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('message formatting', () => {
  it('formats numeric params with the locale and leaves unknown placeholders visible', () => {
    expect(interpolate('{n} items', { n: 12345 }, 'en')).toBe('12,345 items');
    expect(interpolate('Hi {name} {missing}', { name: 'Ada' }, 'en')).toBe('Hi Ada {missing}');
    expect(interpolate('plain', undefined, 'en')).toBe('plain');
  });
  it('uses the zero form when provided', () => {
    const m = { zero: 'none', one: '{count} thing', other: '{count} things' };
    expect(resolveMessage(m, { count: 0 }, 'en')).toBe('none');
    expect(resolveMessage(m, { count: 1 }, 'en')).toBe('1 thing');
    expect(resolveMessage(m, { count: 7 }, 'en')).toBe('7 things');
  });
  it('lists the distinct placeholders of every plural form', () => {
    expect(placeholdersOf({ one: '{count} a {x}', other: '{count} b' })).toEqual(['count', 'x']);
  });
});
