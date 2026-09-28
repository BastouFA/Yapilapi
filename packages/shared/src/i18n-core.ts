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
import { en, type Catalog, type MessageKey } from './locales/en.ts';

export type { Catalog, MessageKey };

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

export function t(key: MessageKey, locale = 'en', vars?: Record<string, string | number>): string {
  const base = locale.split('-')[0] ?? 'en';
  let s: string = loaded.get(locale)?.[key] ?? loaded.get(base)?.[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

type PluralBase<K> = K extends `${infer B}.one` ? (`${B}.other` extends MessageKey ? B : never) : never;
/** Keys that come in `.one` / `.other` pairs, without the suffix. */
export type PluralKey = PluralBase<MessageKey>;

/**
 * Whether `count` takes the `.one` form, by the language's own rule. The runtime's Intl.PluralRules
 * when it has one; the phone's JavaScript engine doesn't, so the rules for the app's languages are
 * written out here (CLDR "one": French and Portuguese count 0 and 1 as one, Yoruba has no plural).
 */
export function pluralIsOne(locale: string, count: number): boolean {
  const PR = (Intl as unknown as { PluralRules?: typeof Intl.PluralRules }).PluralRules;
  if (PR) {
    try {
      return new PR(locale).select(count) === 'one';
    } catch {
      // An unknown locale tag: the rules below.
    }
  }
  const lang = locale.split('-')[0]?.toLowerCase() ?? 'en';
  const whole = Number.isInteger(count);
  if (lang === 'fr' || lang === 'pt') return Math.floor(Math.abs(count)) <= 1;
  if (lang === 'yo') return false;
  return whole && count === 1;
}

/** Plural-aware t(): picks `<key>.one` or `<key>.other` for `count`, which is also passed as {count}. */
export function tp(key: PluralKey, count: number, locale = 'en', vars?: Record<string, string | number>): string {
  return t(`${key}.${pluralIsOne(locale, count) ? 'one' : 'other'}` as MessageKey, locale, { ...vars, count });
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
