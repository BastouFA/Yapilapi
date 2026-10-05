/**
 * Translation with English built in. Every user-facing string in the apps goes through t().
 *
 * Each language's catalog is its own module in `locales/`. This file only carries English; the
 * others are loaded on demand with loadLocale(), so a web page downloads the reader's language and
 * not all eight. The phone and the API import `./i18n.ts` instead, which loads every catalog up front.
 *
 * Add a locale by adding `locales/<code>.ts` with the same keys as English (the Catalog type makes a
 * missing key a type error), then list it in LOADERS below and in CATALOGS in `./i18n.ts`.
 */
import { en, type Catalog, type ExtraPluralForm, type MessageKey, type PluralKey } from './locales/en.ts';

export type { Catalog, ExtraPluralForm, MessageKey, PluralKey };

/** The other languages, each fetched the first time it is needed. */
const LOADERS: Record<string, () => Promise<Catalog>> = {
  fr: () => import('./locales/fr.ts').then((m) => m.fr),
  ar: () => import('./locales/ar.ts').then((m) => m.ar),
  es: () => import('./locales/es.ts').then((m) => m.es),
  pt: () => import('./locales/pt.ts').then((m) => m.pt),
  sw: () => import('./locales/sw.ts').then((m) => m.sw),
  yo: () => import('./locales/yo.ts').then((m) => m.yo),
  ha: () => import('./locales/ha.ts').then((m) => m.ha),
};

export const SUPPORTED_LOCALES: string[] = ['en', ...Object.keys(LOADERS)];
export const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

/** The catalogs t() can use right now. English is always here. */
const loaded = new Map<string, Catalog>([['en', en]]);
const loading = new Map<string, Promise<boolean>>();

/** The catalog a locale tag uses: its own if there is one, otherwise its base language's (fr-CA → fr). */
function catalogCode(locale: string): string | null {
  if (SUPPORTED_LOCALES.includes(locale)) return locale;
  const base = locale.split('-')[0] ?? '';
  return SUPPORTED_LOCALES.includes(base) ? base : null;
}

/**
 * The first of a visitor's preferred languages (the browser's `navigator.languages`, most wanted
 * first) that the app has, by base language (fr-CA → fr), or English.
 */
export function preferredLocale(tags: readonly (string | null | undefined)[]): string {
  for (const tag of tags) {
    const base = (tag ?? '').replace(/_/g, '-').split('-')[0]!.toLowerCase();
    if (base && SUPPORTED_LOCALES.includes(base)) return base;
  }
  return 'en';
}

/** Make a catalog available to t() (`./i18n.ts` registers them all). */
export function registerLocale(code: string, catalog: Catalog): void {
  loaded.set(code, catalog);
}

/** Whether t() already has what it needs for a locale. A language without a catalog needs nothing: it reads English. */
export function localeReady(locale: string): boolean {
  const code = catalogCode(locale);
  return !code || loaded.has(code);
}

/**
 * Fetch a locale's catalog so t() can use it. Resolves true once it is there, false if there is no
 * catalog for it or it could not be fetched (t() reads English then, and a later call tries again).
 * Never rejects.
 */
export function loadLocale(locale: string): Promise<boolean> {
  const code = catalogCode(locale);
  if (!code) return Promise.resolve(false);
  if (loaded.has(code)) return Promise.resolve(true);
  let pending = loading.get(code);
  if (!pending) {
    pending = LOADERS[code]!().then(
      (catalog) => {
        loaded.set(code, catalog);
        return true;
      },
      () => false,
    );
    pending.finally(() => loading.delete(code));
    loading.set(code, pending);
  }
  return pending;
}

export function t(key: MessageKey | PluralFormKey, locale = 'en', vars?: Record<string, string | number>): string {
  const base = locale.split('-')[0] ?? 'en';
  let s: string = loaded.get(locale)?.[key] ?? loaded.get(base)?.[key] ?? (en as Catalog)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** The CLDR plural categories. A language uses some of them; every one has "other". */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * The plural category `count` falls in, by the language's own rule. The runtime's Intl.PluralRules
 * when it has one; the phone's JavaScript engine doesn't, so the CLDR rules for the app's languages
 * are written out here: French and Brazilian Portuguese count 0 and 1 as one, Yoruba has no plural,
 * and Arabic has all six (0, 1, 2, 3–10, 11–99 and 100–102 each read differently).
 */
export function pluralCategory(locale: string, count: number): PluralCategory {
  const PR = (Intl as unknown as { PluralRules?: typeof Intl.PluralRules }).PluralRules;
  if (PR) {
    try {
      return new PR(locale).select(count) as PluralCategory;
    } catch {
      // An unknown locale tag: the rules below.
    }
  }
  const [lang = 'en', region] = locale.toLowerCase().replace(/_/g, '-').split('-');
  const n = Math.abs(count);
  const whole = Number.isInteger(n);
  // French, Spanish and Portuguese say "de" before a round million: "1 million de vues".
  const million = whole && n !== 0 && n % 1_000_000 === 0;
  switch (lang) {
    case 'ar': {
      if (!whole) return 'other';
      if (n <= 2) return (['zero', 'one', 'two'] as const)[n]!;
      const last2 = n % 100;
      if (last2 >= 3 && last2 <= 10) return 'few';
      if (last2 >= 11) return 'many';
      return 'other';
    }
    case 'fr':
      return Math.floor(n) <= 1 ? 'one' : million ? 'many' : 'other';
    case 'pt':
      // European Portuguese counts like English; Brazilian, the catalog's, like French.
      if (region === 'pt') return n === 1 ? 'one' : million ? 'many' : 'other';
      return Math.floor(n) <= 1 ? 'one' : million ? 'many' : 'other';
    case 'es':
      return n === 1 ? 'one' : million ? 'many' : 'other';
    case 'yo':
      return 'other';
    default:
      // English, Swahili, Hausa, and any language without a catalog.
      return n === 1 ? 'one' : 'other';
  }
}

/** Whether `count` takes the `.one` form, by the language's own rule (see pluralCategory). */
export function pluralIsOne(locale: string, count: number): boolean {
  return pluralCategory(locale, count) === 'one';
}

/** A plural key with one of the extra forms a catalog may add (`<key>.few`). */
export type PluralFormKey = `${PluralKey}.${ExtraPluralForm}`;

/**
 * The catalog key for a plural category: `<key>.one` and `<key>.other` are always there; `.zero`,
 * `.two`, `.few` and `.many` only where the language has them (Arabic), and `.other` stands in when
 * it doesn't.
 */
export function pluralFormKey(key: PluralKey, category: PluralCategory, locale = 'en'): MessageKey | PluralFormKey {
  if (category === 'one') return `${key}.one`;
  if (category !== 'other') {
    const form: PluralFormKey = `${key}.${category}`;
    const base = locale.split('-')[0] ?? 'en';
    if (loaded.get(locale)?.[form] ?? loaded.get(base)?.[form]) return form;
  }
  return `${key}.other`;
}

/** Plural-aware t(): picks the form of `key` for `count` (`.one`, `.other`, or Arabic's `.two`, `.few`…), and passes {count}. */
export function tp(key: PluralKey, count: number, locale = 'en', vars?: Record<string, string | number>): string {
  return t(pluralFormKey(key, pluralCategory(locale, count), locale), locale, { ...vars, count });
}

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.has(locale.split('-')[0] ?? '');
}

export function formatRelativeTime(date: Date | string, locale = 'en', now = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = (d.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

export function formatMoney(cents: number, currency: string, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** A time zone the runtime accepts, or UTC. Event data can carry any string. */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** "Sunday, 28 September 2026 at 10:00 WEST": full date and time in the event's own time zone, with its short name. */
export function formatEventWhen(date: Date | string, locale: string, timeZone: string): string {
  const tz = safeTimeZone(timeZone);
  const d = new Date(date);
  // dateStyle/timeStyle can't be combined with timeZoneName, so the zone name is formatted separately.
  const main = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(d);
  let zone = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
  // The phone's JavaScript engine calls every zone without a short English name "GMT"; say its offset instead.
  if (zone && /^(GMT|UTC)$/.test(zone) && zoneOffsetMinutes(d, tz) !== 0) zone = gmtOffsetLabel(d, tz);
  return zone ? `${main} ${zone}` : main;
}

/** How far a time zone is from UTC at a moment, in minutes (Brussels in summer: 120). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** "GMT", "GMT+2", "GMT-3:30": a zone's offset at a moment, for when the runtime has no name for it. */
export function gmtOffsetLabel(date: Date, timeZone: string): string {
  const off = zoneOffsetMinutes(date, timeZone);
  if (off === 0) return 'GMT';
  const abs = Math.abs(off);
  const mins = abs % 60;
  return `GMT${off > 0 ? '+' : '-'}${Math.floor(abs / 60)}${mins ? `:${String(mins).padStart(2, '0')}` : ''}`;
}
