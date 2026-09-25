import fs from 'node:fs';
import path from 'node:path';
import { directionFor } from '@yapilapi/design-system';
import {
  LOCALES,
  createTranslator,
  negotiateLocale,
  placeholdersOf,
  resolveMessage,
  type Message,
} from '../src/i18n/core';
import { en } from '../src/i18n/messages/en';
import { fr } from '../src/i18n/messages/fr';
import { ar } from '../src/i18n/messages/ar';
import { yo } from '../src/i18n/messages/yo';
import { makeT } from '../src/i18n';

const drafts: Record<string, Record<string, Message | undefined>> = { fr, ar, yo };
const enMap = en as unknown as Record<string, Message>;
const forms = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m));

describe('catalogs', () => {
  it('English defines a non-empty message for every key and plural objects always have "other"', () => {
    for (const [k, m] of Object.entries(enMap)) {
      expect(forms(m).every((s) => s.trim().length > 0)).toBe(true);
      if (typeof m !== 'string') expect(m.other).toBeTruthy();
      expect(k).toMatch(/^[a-z0-9_]+(\.[A-Za-z0-9_]+)+$/);
    }
  });

  it.each(['fr', 'ar', 'yo'])(
    '%s only uses keys that exist in English, keeps the same placeholders, and has no empty strings',
    (l) => {
      for (const [k, m] of Object.entries(drafts[l]!)) {
        expect(enMap[k]).toBeDefined();
        expect(forms(m!).every((s) => s.trim().length > 0)).toBe(true);
        expect({ key: k, placeholders: placeholdersOf(m!) }).toEqual({
          key: k,
          placeholders: placeholdersOf(enMap[k]!),
        });
      }
    },
  );

  it.each(['fr', 'ar', 'yo'])(
    '%s covers every English key (drafts are complete, a missing key would fall back to English)',
    (l) => {
      const missing = Object.keys(enMap).filter(
        (k) =>
          k !== 'app.name' /* the brand name is never translated */ && drafts[l]![k] === undefined,
      );
      expect(missing).toEqual([]);
    },
  );

  it.each(['fr', 'ar', 'yo'])(
    '%s plural forms are categories Intl.PluralRules can produce for that language',
    (l) => {
      const valid = new Set(
        new Intl.PluralRules(l).resolvedOptions().pluralCategories as string[],
      ).add('zero');
      for (const [k, m] of Object.entries(drafts[l]!)) {
        if (typeof m === 'string' || !m) continue;
        for (const cat of Object.keys(m))
          expect({ k, cat, ok: valid.has(cat) }).toEqual({ k, cat, ok: true });
      }
    },
  );

  it('every t("literal") used in the source exists in the English catalog (no missing keys, no key shown to users)', () => {
    const root = path.join(__dirname, '../src');
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(root).filter((f) => /\.tsx?$/.test(f) && !f.includes('/i18n/messages/'));
    const missing: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g))
        if (!(m[1]! in enMap)) missing.push(`${path.relative(root, f)}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('no screen or component hardcodes user-facing text: JSX text nodes and label props come from t()', () => {
    const root = path.join(__dirname, '../src');
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const offenders: string[] = [];
    for (const f of walk(root).filter((x) => x.endsWith('.tsx'))) {
      const src = fs.readFileSync(f, 'utf8');
      // JSX text: >Some words< (at least one letter, not an expression)
      for (const m of src.matchAll(/>\s*([A-Za-z][A-Za-z ,.'!?-]{2,})\s*<\//g))
        offenders.push(`${path.relative(root, f)}: text "${m[1]}"`);
      // string literals on user-facing props
      for (const m of src.matchAll(
        /\b(label|title|placeholder|accessibilityLabel|accessibilityHint|message)=(?:"([^"{]*[A-Za-z]{3,}[^"{]*)")/g,
      ))
        offenders.push(`${path.relative(root, f)}: ${m[1]}="${m[2]}"`);
    }
    // brand tokens that are legitimately not translated are allowed
    expect(offenders.filter((o) => !/YAPILAPI|DD|MM|YYYY/.test(o))).toEqual([]);
  });
});

describe('translator', () => {
  it('interpolates params, formats numbers with the locale, and falls back to English for missing keys', () => {
    const t = createTranslator(
      { hi: 'Hello {name}', n: '{count} left' } as const,
      { hi: 'Bonjour {name}' },
      'fr',
    );
    expect(t('hi', { name: 'Ada' })).toBe('Bonjour Ada');
    expect(t('n', { count: 1234 })).toBe(`${new Intl.NumberFormat('fr').format(1234)} left`);
    const t2 = createTranslator({ hi: 'Hello {name}' } as const, {}, 'yo');
    expect(t2('hi', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('resolves plural forms with Intl.PluralRules (English one/other, Arabic six forms, exact zero)', () => {
    const t = makeT('en');
    expect(t('common.members', { count: 1 })).toBe('1 member');
    expect(t('common.members', { count: 5 })).toBe('5 members');
    expect(t('post.likeCount', { count: 0 })).toBe('No likes yet');
    const ar = makeT('ar');
    expect(ar('common.members', { count: 1 })).toBe('عضو واحد');
    expect(ar('common.members', { count: 2 })).toBe('عضوان');
    expect(ar('common.members', { count: 5 })).toContain('أعضاء');
    expect(ar('common.members', { count: 25 })).toContain('عضوًا');
    expect(resolveMessage({ one: 'a', other: 'b' }, { count: 1 }, 'yo')).toBe('b'); // Yoruba has no plural distinction
  });

  it('falls back to English for an untranslated key at runtime and returns the key for an unknown one', () => {
    const t = createTranslator({ a: 'A', b: 'B' } as const, { a: 'AA' }, 'fr');
    expect(t('b')).toBe('B');
    expect((createTranslator({} as never, {}, 'en') as (k: string) => string)('nope')).toBe('nope');
  });

  it('every locale translates the brand tagline and never the brand name', () => {
    for (const l of LOCALES) {
      const t = makeT(l);
      expect(t('app.name')).toBe('YAPILAPI');
      expect(t('welcome.title')).toContain('YAPILAPI');
    }
    expect(makeT('fr')('app.tagline')).not.toBe(en['app.tagline']);
  });
});

describe('locale negotiation and direction', () => {
  it('picks the best supported device locale', () => {
    expect(negotiateLocale(['fr-CA', 'en'])).toBe('fr');
    expect(negotiateLocale(['ar_EG'])).toBe('ar');
    expect(negotiateLocale(['yo-NG'])).toBe('yo');
    expect(negotiateLocale(['de-DE', 'es'])).toBe('en');
    expect(negotiateLocale([null, undefined])).toBe('en');
  });
  it('Arabic is right-to-left, the rest left-to-right', () => {
    expect(LOCALES.map((l) => [l, directionFor(l)])).toEqual([
      ['en', 'ltr'],
      ['fr', 'ltr'],
      ['ar', 'rtl'],
      ['yo', 'ltr'],
    ]);
  });
});
