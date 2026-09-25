import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES, placeholdersOf, type Message } from './core';
import { en } from './messages/en';
import { fr } from './messages/fr';
import { ar } from './messages/ar';
import { yo } from './messages/yo';
import { makeT } from './make';

const catalogs = { fr, ar, yo } as Record<'fr' | 'ar' | 'yo', Record<string, Message>>;
const base = en as unknown as Record<string, Message>;

describe('English source catalog', () => {
  it('has no empty messages', () => {
    for (const [k, v] of Object.entries(base)) {
      const forms = typeof v === 'string' ? [v] : Object.values(v);
      for (const f of forms) expect(f.trim(), k).not.toBe('');
    }
  });

  it('plural messages always define `other` and take a numeric {count}', () => {
    for (const [k, v] of Object.entries(base)) {
      if (typeof v === 'string') continue;
      expect(typeof v.other, k).toBe('string');
      expect(placeholdersOf(v), k).toContain('count');
    }
  });

  it('every static t("key") used in the source exists', () => {
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'messages') walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
      }
    };
    walk(root);
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g))
        if (!(m[1]! in base)) missing.push(`${path.relative(root, f)}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe.each(['fr', 'ar', 'yo'] as const)(
  '%s catalog (machine-drafted, needs native review)',
  (loc) => {
    const cat = catalogs[loc];

    it('only uses keys that exist in English', () => {
      expect(Object.keys(cat).filter((k) => !(k in base))).toEqual([]);
    });

    it('keeps exactly the same {placeholders} as English', () => {
      for (const [k, v] of Object.entries(cat))
        expect(placeholdersOf(v), `${loc}:${k}`).toEqual(placeholdersOf(base[k]!));
    });

    it('plural objects only use categories the locale has', () => {
      const cats = new Set(
        new Intl.PluralRules(loc).resolvedOptions().pluralCategories as string[],
      );
      cats.add('zero'); // explicit zero is allowed everywhere by the runtime
      for (const [k, v] of Object.entries(cat)) {
        if (typeof v === 'string') {
          expect(typeof base[k], `${loc}:${k} must stay a plain string`).toBe('string');
          continue;
        }
        expect(typeof base[k], `${loc}:${k} must stay plural`).toBe('object');
        for (const form of Object.keys(v)) expect(cats.has(form), `${loc}:${k}:${form}`).toBe(true);
      }
    });

    it('covers the core navigation, form and error strings', () => {
      for (const k of [
        'nav.home',
        'nav.settings',
        'common.cancel',
        'login.title',
        'field.email',
        'field.password',
        'error.generic',
        'signup.create',
        'post.like',
        'home.tab.for_you',
      ]) {
        expect(k in cat, `${loc} is missing core key ${k}`).toBe(true);
      }
    });
  },
);

describe('translators', () => {
  it('fall back to English for keys a locale has not translated', () => {
    const t = makeT('yo');
    expect(t('nav.home')).toBe('Ilé');
    expect(t('composer.errLink')).toBe(en['composer.errLink']);
  });

  it('interpolate params and choose plural forms per locale', () => {
    expect(makeT('en')('post.likesCount', { count: 1 })).toBe('1 like');
    expect(makeT('en')('post.likesCount', { count: 5 })).toBe('5 likes');
    const arT = makeT('ar');
    expect(arT('post.commentsCount', { count: 0 })).toBe('لا تعليقات');
    expect(arT('post.commentsCount', { count: 2 })).toBe('تعليقان');
    expect(arT('post.commentsCount', { count: 3 })).toMatch(/تعليقات/);
    expect(makeT('fr')('post.commentsCount', { count: 0 })).toBe('0 commentaire');
    expect(makeT('fr')('signup.stepOf', { current: 2, total: 5 })).toBe('Étape 2 sur 5');
  });

  it('every locale is registered', () => {
    expect([...LOCALES]).toEqual(['en', 'fr', 'ar', 'yo']);
  });
});
