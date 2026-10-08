import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Only the core, as the web loads it: English is here, the other languages load on demand.
import { loadLocale, localeReady, preferredLocale, SUPPORTED_LOCALES, t, tp } from './i18n-core.ts';
import { en } from './locales/en.ts';

describe('languages loaded on demand', () => {
  it('has a loader for every catalog in locales/', () => {
    // The files, not locales/errors/ (the API's error messages, which only the API loads).
    const files = readdirSync(new URL('./locales/', import.meta.url))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
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

describe('the phone', () => {
  it('evaluates only English up front: its code imports i18n-core, never i18n (every catalog)', () => {
    // apps/mobile, and apps/yap through the same files; Metro runs a catalog the first time loadLocale() imports it.
    const offenders: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(url);
        else if (/\.(tsx?|jsx?)$/.test(entry.name) && /shared\/src\/i18n(\.ts)?['"]/.test(readFileSync(url, 'utf8'))) offenders.push(url.pathname);
      }
    };
    for (const app of ['mobile', 'yap']) {
      const dir = new URL(`../../../apps/${app}/`, import.meta.url);
      if (existsSync(dir)) walk(dir);
    }
    expect(offenders).toEqual([]);
  });
});

describe("a visitor's language", () => {
  it('takes the first preferred language the app has, by base language', () => {
    expect(preferredLocale(['fr-CA', 'en-US'])).toBe('fr');
    expect(preferredLocale(['nl-NL', 'nl', 'ar-EG'])).toBe('ar');
    expect(preferredLocale(['de-DE', 'ar-EG'])).toBe('de');
    expect(preferredLocale(['zh-Hans-CN'])).toBe('zh');
    expect(preferredLocale(['pt_BR'])).toBe('pt');
    expect(preferredLocale(['SW-ke'])).toBe('sw');
  });

  it('is English when none of them is available', () => {
    expect(preferredLocale(['nl', 'th'])).toBe('en');
    expect(preferredLocale([])).toBe('en');
    expect(preferredLocale(['', null, undefined])).toBe('en');
  });
});
