import { describe, expect, it } from 'vitest';
import { CATALOGS, isRtl, SUPPORTED_LOCALES, t, tp, type MessageKey } from './i18n.ts';

const en = CATALOGS.en!;
const keys = Object.keys(en).sort();
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('message catalogs', () => {
  it('has the 8 supported languages', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(['ar', 'en', 'es', 'fr', 'ha', 'pt', 'sw', 'yo']);
  });

  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      const catalog = CATALOGS[locale]!;

      it('has exactly the same keys as English', () => {
        const own = Object.keys(catalog).sort();
        expect(keys.filter((k) => !(k in catalog))).toEqual([]);
        expect(own.filter((k) => !(k in en))).toEqual([]);
      });

      it('has a non-empty string for every key', () => {
        const empty = keys.filter((k) => typeof catalog[k as MessageKey] !== 'string' || !catalog[k as MessageKey].trim());
        expect(empty).toEqual([]);
      });

      it('keeps the same {placeholders} as English', () => {
        // A singular may say the number in words instead ("منشور واحد"), so `.one` can drop {count}.
        const same = (k: string, own: string[], english: string[]) =>
          own.join() === english.join() || (k.endsWith('.one') && own.join() === english.filter((p) => p !== 'count').join());
        const differ = keys
          .filter((k) => !same(k, placeholders(catalog[k as MessageKey] ?? ''), placeholders(en[k as MessageKey])))
          .map((k) => `${k}: ${catalog[k as MessageKey]}`);
        expect(differ).toEqual([]);
      });

      it('has no exclamation marks or emoji', () => {
        const loud = keys.filter((k) => /[!¡]|\p{Extended_Pictographic}/u.test(catalog[k as MessageKey] ?? '')).map((k) => `${k}: ${catalog[k as MessageKey]}`);
        expect(loud).toEqual([]);
      });
    });
  }

  it('comes with both halves of every plural pair', () => {
    // `.other` alone can be an ordinary key (m.notif.other); a `.one` always needs its `.other`.
    const lonely = keys.filter((k) => k.endsWith('.one') && !(k.replace(/\.one$/, '.other') in en));
    expect(lonely).toEqual([]);
  });
});

describe('t and tp', () => {
  it('interpolates and falls back to English', () => {
    expect(t('post.locked.body', 'fr', { name: 'Ada' })).toContain('Ada');
    expect(t('nav.home', 'fr-CA')).toBe(CATALOGS.fr!['nav.home']);
    expect(t('nav.home', 'xx')).toBe('Home');
  });

  it('picks the plural form for the count', () => {
    expect(tp('m.poll.votes', 1)).toBe('1 vote');
    expect(tp('m.poll.votes', 3)).toBe('3 votes');
    // French treats 0 and 1 as singular.
    expect(tp('m.poll.votes', 0, 'fr')).toBe(t('m.poll.votes.one', 'fr', { count: 0 }));
  });

  it('knows the right-to-left languages', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('ar-EG')).toBe(true);
    expect(isRtl('fr')).toBe(false);
  });
});
