// The app's language, outside React. lib/i18n.tsx keeps it in sync with the signed-in user's
// locale and the device languages; code that runs outside a component (alerts from callbacks,
// errors thrown in lib/api.ts, notification buttons) reads it through `tr`.
import { CATALOGS, isRtl, t as translate, type MessageKey } from '../../../packages/shared/src/i18n';

export type Vars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

type PluralBase<K> = K extends `${infer B}.one` ? (`${B}.other` extends MessageKey ? B : never) : never;
/** Keys that come in `.one` / `.other` pairs, without the suffix. */
export type PluralKey = PluralBase<MessageKey>;

export interface LocaleInfo {
  /** BCP 47 tag used for Intl formatting (for example `pt-BR`). */
  locale: string;
  /** Catalog the strings come from (for example `pt`). */
  lang: string;
  rtl: boolean;
}

const ENGLISH: LocaleInfo = { locale: 'en', lang: 'en', rtl: false };

/**
 * The first candidate with a catalog wins, so a person whose phone is set to Hebrew and then
 * French gets French. With no match the app is in English. The direction follows the catalog
 * actually shown: an RTL language without a catalog yet (he, fa, ur) shows English, left to
 * right, until its catalog is added; `isRtl` then turns it RTL with no other change.
 */
export function resolveLocale(candidates: readonly (string | null | undefined)[]): LocaleInfo {
  for (const raw of candidates) {
    if (!raw) continue;
    const tag = raw.replace(/_/g, '-');
    const lang = tag.split('-')[0]!.toLowerCase();
    if (!CATALOGS[lang]) continue;
    let locale = lang;
    try {
      locale = Intl.getCanonicalLocales(tag)[0] ?? lang;
    } catch {
      // Not a valid tag (some devices report odd ones): the language alone is enough.
    }
    return { locale, lang, rtl: isRtl(lang) };
  }
  return ENGLISH;
}

// First strong isolate / pop directional isolate: an interpolated name or title keeps its own
// direction, so "Replying to <Arabic name>" and an English name inside Arabic text read correctly.
const FSI = '⁨';
const PDI = '⁩';

export interface Translator {
  locale: string;
  lang: string;
  rtl: boolean;
  t: Translate;
  /** Plural-aware: picks `<key>.one` or `<key>.other` for `count`, which is also passed as {count}. */
  tp: (key: PluralKey, count: number, vars?: Vars) => string;
  number: (n: number, opts?: Intl.NumberFormatOptions) => string;
  date: (d: Date | string | number, opts?: Intl.DateTimeFormatOptions) => string;
  /** Short date and time, for events and search results. */
  dateTime: (d: Date | string | number) => string;
  /** Compact "5m", "3 h", "2 j" style age for feeds and lists; a date after a week. */
  timeAgo: (iso: string) => string;
}

function safe<T>(make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch {
    return fallback();
  }
}

const cache = new Map<string, Translator>();

export function translator(info: LocaleInfo): Translator {
  const id = `${info.lang}|${info.locale}`;
  const hit = cache.get(id);
  if (hit) return hit;

  // Hermes ships Intl.NumberFormat and DateTimeFormat; PluralRules may be missing on some builds.
  const nf = safe(
    () => new Intl.NumberFormat(info.locale),
    () => new Intl.NumberFormat('en'),
  );
  const pr =
    typeof Intl.PluralRules === 'function'
      ? safe<Intl.PluralRules | null>(
          () => new Intl.PluralRules(info.locale),
          () => null,
        )
      : null;
  const number = (n: number, opts?: Intl.NumberFormatOptions) =>
    opts
      ? safe(
          () => new Intl.NumberFormat(info.locale, opts).format(n),
          () => String(n),
        )
      : nf.format(n);
  const date = (d: Date | string | number, opts?: Intl.DateTimeFormatOptions) => {
    const v = new Date(d);
    return safe(
      () => new Intl.DateTimeFormat(info.locale, opts).format(v),
      () => v.toLocaleString(),
    );
  };

  const t: Translate = (key, vars) => {
    if (!vars) return translate(key, info.lang);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) out[k] = typeof v === 'number' ? nf.format(v) : `${FSI}${v}${PDI}`;
    return translate(key, info.lang, out);
  };
  const tp: Translator['tp'] = (key, count, vars) => {
    const one = pr ? pr.select(count) === 'one' : count === 1;
    return t(`${key}.${one ? 'one' : 'other'}` as MessageKey, { ...vars, count });
  };

  const tr: Translator = {
    ...info,
    t,
    tp,
    number,
    date,
    dateTime: (d) => date(d, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    timeAgo: (iso) => {
      const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
      if (s < 60) return t('m.unit.seconds', { count: s });
      if (s < 3600) return t('m.unit.minutes', { count: Math.floor(s / 60) });
      if (s < 86400) return t('m.unit.hours', { count: Math.floor(s / 3600) });
      if (s < 604800) return t('m.unit.days', { count: Math.floor(s / 86400) });
      const then = new Date(iso);
      return date(then, then.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { dateStyle: 'medium' });
    },
  };
  cache.set(id, tr);
  return tr;
}

let current: Translator = translator(ENGLISH);

/** Called by the LocaleProvider whenever the resolved locale changes. */
export function setCurrentLocale(info: LocaleInfo): Translator {
  current = translator(info);
  return current;
}

/** The current translator, for code outside components. Components use `useT()` so they re-render. */
export const currentTranslator = () => current;
export const tr: Translate = (key, vars) => current.t(key, vars);
