import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Only the core, as the web loads it: English is here, the other languages load on demand.
import { loadLocale, localeReady, SUPPORTED_LOCALES, t, tp } from './i18n-core.ts';
import { en } from './locales/en.ts';

describe('languages loaded on demand', () => {
  it('has a loader for every catalog in locales/', () => {
    const files = readdirSync(new URL('./locales/', import.meta.url)).map((f) => f.replace(/\.ts$/, ''));
    expect([...SUPPORTED_LOCALES].sort()).toEqual(files.sort());
  });

  it('reads English until a language is loaded', async () => {
    expect(localeReady('en')).toBe(true);
    expect(localeReady('yo')).toBe(false);
    expect(localeReady('yo-NG')).toBe(false);
    expect(t('nav.home', 'yo')).toBe(en['nav.home']);

    const { yo } = await import('./locales/yo.ts');
    expect(await loadLocale('yo-NG')).toBe(true);
    expect(localeReady('yo')).toBe(true);
    expect(t('nav.home', 'yo')).toBe(yo['nav.home']);
    expect(t('nav.home', 'yo-NG')).toBe(yo['nav.home']);
    expect(tp('m.poll.votes', 3, 'yo')).toBe(yo['m.poll.votes.other'].replaceAll('{count}', '3'));
  });

  it('needs nothing for a language without a catalog', async () => {
    expect(localeReady('xx')).toBe(true);
    expect(localeReady('toString')).toBe(true);
    expect(await loadLocale('xx')).toBe(false);
    expect(t('nav.home', 'xx')).toBe(en['nav.home']);
  });

  it('loads every supported language, each once', async () => {
    for (const code of SUPPORTED_LOCALES) {
      const waiting = !localeReady(code);
      const first = loadLocale(code);
      // Asked again while it downloads: the same request.
      if (waiting) expect(loadLocale(code)).toBe(first);
      expect(await first).toBe(true);
      expect(localeReady(code)).toBe(true);
      const catalog = (await import(`./locales/${code}.ts`))[code] as Record<string, string>;
      expect(t('app.tagline', code)).toBe(catalog['app.tagline']);
    }
  });
});
