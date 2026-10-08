import { describe, expect, it } from 'vitest';
import {
  CATALOGS,
  gmtOffsetLabel,
  isRtl,
  pluralCategory,
  pluralFormKey,
  pluralIsOne,
  SUPPORTED_LOCALES,
  t,
  tp,
  zoneOffsetMinutes,
  type MessageKey,
} from './i18n.ts';
import { fr as frErrors } from './locales/errors/fr.ts';

const en = CATALOGS.en!;
const keys = Object.keys(en).sort();
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('message catalogs', () => {
  it('has the 24 supported languages', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(
      ['am', 'ar', 'bn', 'de', 'en', 'es', 'fr', 'ha', 'hi', 'id', 'ig', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'sw', 'tr', 'ur', 'vi', 'yo', 'zh', 'zu'].sort(),
    );
    // The phone and the API load every catalog up front: the same languages the web loads on demand.
    expect(Object.keys(CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  /** `m.poll.votes.few` → `m.poll.votes.other`: an extra plural form a language may add, or null. */
  const extraFormOf = (k: string) => {
    const base = /^(.+)\.(zero|two|few|many)$/.exec(k)?.[1];
    return base && `${base}.one` in en && `${base}.other` in en ? (`${base}.other` as MessageKey) : null;
  };

  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      const catalog = CATALOGS[locale]! as Record<string, string>;
      const own = Object.keys(catalog).sort();

      it('has exactly the same keys as English, and only plural forms besides', () => {
        expect(keys.filter((k) => !(k in catalog))).toEqual([]);
        // Arabic adds `.zero`, `.two`, `.few` and `.many` to some plurals; nothing else is extra.
        expect(own.filter((k) => !(k in en) && !extraFormOf(k))).toEqual([]);
      });

      it('has a non-empty string for every key', () => {
        const empty = own.filter((k) => typeof catalog[k] !== 'string' || !catalog[k].trim());
        expect(empty).toEqual([]);
      });

      it('keeps the same {placeholders} as English', () => {
        // A singular may say the number in words instead ("منشور واحد"), so `.one` can drop {count}.
        // The extra forms follow `.other`, and Arabic's dual says the number in its noun ("يومان",
        // "ساعتين"), so they can drop the number's placeholder; none of them adds one.
        const english = (k: string) => placeholders(en[(extraFormOf(k) ?? k) as MessageKey]);
        const same = (k: string, mine: string[], theirs: string[]) =>
          mine.join() === theirs.join() ||
          (k.endsWith('.one') && mine.join() === theirs.filter((p) => p !== 'count').join()) ||
          (!!extraFormOf(k) && mine.every((p) => theirs.includes(p)) && theirs.length - mine.length <= 1);
        const differ = own.filter((k) => !same(k, placeholders(catalog[k] ?? ''), english(k))).map((k) => `${k}: ${catalog[k]}`);
        expect(differ).toEqual([]);
      });

      it('has no exclamation marks or emoji', () => {
        const loud = own.filter((k) => /[!¡]|\p{Extended_Pictographic}/u.test(catalog[k] ?? '')).map((k) => `${k}: ${catalog[k]}`);
        expect(loud).toEqual([]);
      });
    });
  }

  it('gives the rows of listing details different names in every language', () => {
    const rows = ['condition', 'category', 'delivery', 'where', 'status'].map((k) => `m.market.details.${k}` as MessageKey);
    for (const locale of SUPPORTED_LOCALES) {
      const names = rows.map((k) => t(k, locale));
      expect(new Set(names).size, locale).toBe(names.length);
    }
  });

  it('speaks to the reader as "tu" in French', () => {
    // One register everywhere, the API's error messages included. "Rendez-vous" is a noun, not "vous".
    const formal = /(?<!\p{L})(vous|votre|vos)(?!\p{L})/iu;
    const found = (table: Record<string, string>) =>
      Object.entries(table)
        .filter(([, s]) => formal.test(s.replace(/rendez-vous/giu, '')))
        .map(([k, s]) => `${k}: ${s}`);
    expect(found(CATALOGS.fr!)).toEqual([]);
    expect(found(frErrors)).toEqual([]);
  });

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
    expect(t('nav.home', 'xx')).toBe('Pulse');
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
    expect(isRtl('ur')).toBe(true);
    expect(isRtl('ur-PK')).toBe(true);
    expect(isRtl('fr')).toBe(false);
    expect(SUPPORTED_LOCALES.filter(isRtl).sort()).toEqual(['ar', 'ur']);
  });
});

describe('time zone offsets', () => {
  const summer = new Date('2026-09-28T17:10:00Z');
  const winter = new Date('2026-01-15T12:00:00Z');

  it('works out how far a zone is from UTC, summer time included', () => {
    expect(zoneOffsetMinutes(summer, 'Europe/Brussels')).toBe(120);
    expect(zoneOffsetMinutes(winter, 'Europe/Brussels')).toBe(60);
    expect(zoneOffsetMinutes(summer, 'America/New_York')).toBe(-240);
    expect(zoneOffsetMinutes(summer, 'UTC')).toBe(0);
  });

  it('names a zone by its offset when the phone has no name for it', () => {
    expect(gmtOffsetLabel(summer, 'Europe/Brussels')).toBe('GMT+2');
    expect(gmtOffsetLabel(summer, 'Asia/Kolkata')).toBe('GMT+5:30');
    expect(gmtOffsetLabel(summer, 'America/St_Johns')).toBe('GMT-2:30');
    expect(gmtOffsetLabel(winter, 'Europe/London')).toBe('GMT');
  });
});

/** Runs `fn` the way the phone does: with no Intl.PluralRules at all. */
function withoutPluralRules(fn: () => void) {
  const real = Intl.PluralRules;
  expect(Reflect.deleteProperty(Intl, 'PluralRules')).toBe(true);
  try {
    expect('PluralRules' in Intl).toBe(false);
    fn();
  } finally {
    (Intl as { PluralRules: typeof Intl.PluralRules }).PluralRules = real;
  }
}

const runtimes: [string, (fn: () => void) => void][] = [
  ['with Intl.PluralRules', (fn) => fn()],
  ['without Intl.PluralRules (the phone)', withoutPluralRules],
];

describe('plural categories', () => {
  for (const [name, run] of runtimes) {
    describe(name, () => {
      it('gives Arabic all six', () => {
        run(() => {
          const counts = [0, 1, 2, 3, 10, 11, 99, 100, 101, 102, 103, 111];
          expect(counts.map((n) => pluralCategory('ar', n)).join(' ')).toBe('zero one two few few many many other other other few many');
          expect(pluralCategory('ar-EG', 1011)).toBe('many');
          expect(pluralCategory('ar', 2.5)).toBe('other');
        });
      });

      it('follows each language’s own rule', () => {
        run(() => {
          expect([0, 1, 2].map((n) => pluralCategory('en', n))).toEqual(['other', 'one', 'other']);
          expect([0, 1, 2].map((n) => pluralCategory('fr', n))).toEqual(['one', 'one', 'other']);
          expect([0, 1, 2, 100].map((n) => pluralCategory('yo', n))).toEqual(['other', 'other', 'other', 'other']);
          expect([0, 1, 2].map((n) => pluralIsOne('en', n))).toEqual([false, true, false]);
          expect([0, 1, 2].map((n) => pluralIsOne('fr', n))).toEqual([true, true, false]);
          expect(pluralIsOne('pt-BR', 0)).toBe(true);
          expect(pluralIsOne('yo', 1)).toBe(false);
          expect(tp('m.poll.votes', 0, 'fr')).toBe(t('m.poll.votes.one', 'fr', { count: 0 }));
        });
      });

      it('shows the number where "one" is more than 1 and `.one` doesn’t say it', () => {
        run(() => {
          const ru = CATALOGS.ru! as Record<string, string>;
          const hi = CATALOGS.hi! as Record<string, string>;
          const bn = CATALOGS.bn! as Record<string, string>;
          const form = (c: Record<string, string>, k: string, n: number) => c[k]!.replaceAll('{count}', String(n));
          // "Used once": Russian counts 21, 31… as one, Hindi and Bengali 0.
          expect(ru['wrap.songUses.one']).not.toContain('{count}');
          expect(tp('wrap.songUses', 1, 'ru')).toBe(ru['wrap.songUses.one']);
          expect(tp('wrap.songUses', 21, 'ru')).toBe(form(ru, 'wrap.songUses.many', 21));
          expect(tp('wrap.songUses', 101, 'ru')).toBe(form(ru, 'wrap.songUses.many', 101));
          expect(tp('wrap.songUses', 22, 'ru')).toBe(form(ru, 'wrap.songUses.few', 22));
          expect(tp('wrap.songUses', 0, 'hi')).toBe(form(hi, 'wrap.songUses.other', 0));
          expect(tp('wrap.songUses', 1, 'hi')).toBe(hi['wrap.songUses.one']);
          expect(tp('wrap.songUses', 0, 'bn')).toBe(form(bn, 'wrap.songUses.other', 0));
          // French counts 0 as one too.
          expect(tp('wrap.songUses', 0, 'fr')).toBe(form(CATALOGS.fr!, 'wrap.songUses.other', 0));
          // A `.one` with the number in it is right for every count it covers.
          expect(tp('m.boost.days', 21, 'ru')).toBe(form(ru, 'm.boost.days.one', 21));
          expect(tp('m.poll.votes', 0, 'fr')).toBe(form(CATALOGS.fr!, 'm.poll.votes.one', 0));
          // Without the count, the category alone decides, as before.
          expect(pluralFormKey('wrap.songUses', 'one', 'ru')).toBe('wrap.songUses.one');
          expect(pluralFormKey('wrap.songUses', 'one', 'ru', 21)).toBe('wrap.songUses.many');
          expect(pluralFormKey('wrap.songUses', 'one', 'hi', 0)).toBe('wrap.songUses.other');
        });
      });

      it('picks Arabic’s forms, and `.other` where a plural has no such form', () => {
        run(() => {
          const ar = CATALOGS.ar! as Record<string, string>;
          const form = (k: string, n: number) => ar[k]!.replaceAll('{count}', String(n));
          expect(tp('m.boost.days', 1, 'ar')).toBe(form('m.boost.days.one', 1));
          expect(tp('m.boost.days', 2, 'ar')).toBe(ar['m.boost.days.two']);
          expect(tp('m.boost.days', 7, 'ar')).toBe(form('m.boost.days.few', 7));
          expect(tp('m.boost.days', 30, 'ar')).toBe(form('m.boost.days.many', 30));
          expect(tp('m.boost.days', 100, 'ar')).toBe(form('m.boost.days.other', 100));
          expect(tp('m.boost.days', 0, 'ar')).toBe(form('m.boost.days.other', 0));
          // A plural written as "Label: {count}" reads right for every number, so it has only the two.
          expect('m.poll.votes.few' in ar || 'm.poll.votes.many' in ar).toBe(false);
          for (const n of [0, 2, 5, 50]) expect(tp('m.poll.votes', n, 'ar')).toBe(form('m.poll.votes.other', n));
          // Some forms but not all: "11 stories" reads like "100 stories", so `.many` is left to `.other`.
          expect(['m.stories.reshares.few' in ar, 'm.stories.reshares.many' in ar]).toEqual([true, false]);
          expect(tp('m.stories.reshares', 4, 'ar')).toBe(form('m.stories.reshares.few', 4));
          expect(tp('m.stories.reshares', 11, 'ar')).toBe(form('m.stories.reshares.other', 11));
          // The other languages have only `.one` and `.other`, whatever Arabic has.
          expect(tp('m.boost.days', 2, 'en')).toBe('2 days');
        });
      });
    });
  }

  it('writes out the same rules as the runtime’s Intl.PluralRules', () => {
    const counts = [...Array.from({ length: 1201 }, (_, n) => n), 0.5, 1.5, 2.5, 10.5, 1_000_000, 2_000_000, 1_500_000];
    const locales = [...SUPPORTED_LOCALES, 'pt-BR', 'pt-PT', 'ar-EG', 'fr-CA'];
    const expected = locales.map((l) => counts.map((n) => new Intl.PluralRules(l).select(n)));
    withoutPluralRules(() => {
      expect(locales.map((l) => counts.map((n) => pluralCategory(l, n)))).toEqual(expected);
    });
  });
});
