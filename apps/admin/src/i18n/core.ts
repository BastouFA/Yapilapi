/**
 * Typed message catalog. `en` is the source of truth and defines every key (and, through template-literal types,
 * every `{param}`). A message is a string or a plural object keyed by Intl.PluralRules categories.
 */
export type PluralForms = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};
export type Message = string | PluralForms;
export type CatalogShape = Record<string, Message>;

export const LOCALES = ['en', 'fr', 'ar', 'yo'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  ar: 'العربية',
  yo: 'Yorùbá',
};
export const RTL_LOCALES: readonly Locale[] = ['ar'];
export const LOCALE_COOKIE = 'yl_admin_locale';
export const isLocale = (v: string | undefined | null): v is Locale =>
  !!v && (LOCALES as readonly string[]).includes(v);
export const directionOf = (l: Locale): 'ltr' | 'rtl' => (RTL_LOCALES.includes(l) ? 'rtl' : 'ltr');

/** Pick the best supported locale from an Accept-Language header. */
export function negotiateLocale(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const wanted = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q) : 1 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

type StrOf<M> = M extends string ? M : M extends { other: infer O extends string } ? O : never;
type Extract1<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Extract1<Rest>
  : never;
/** Params required by a message: every `{name}` placeholder. `count` must be a number for plural messages. */
export type ParamsOf<M> = {
  [K in Extract1<StrOf<M>>]: K extends 'count' ? number : string | number;
};

export type Translate<C extends CatalogShape> = <K extends keyof C & string>(
  key: K,
  ...args: keyof ParamsOf<C[K]> extends never ? [] : [params: ParamsOf<C[K]>]
) => string;

export function interpolate(
  template: string,
  params: Record<string, string | number> | undefined,
  locale: string,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) return `{${name}}`;
    return typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : v;
  });
}

export function resolveMessage(
  msg: Message,
  params: Record<string, string | number> | undefined,
  locale: string,
): string {
  if (typeof msg === 'string') return interpolate(msg, params, locale);
  const count = typeof params?.['count'] === 'number' ? params['count'] : 0;
  const category = new Intl.PluralRules(locale).select(count) as keyof PluralForms;
  const exact = count === 0 && msg.zero !== undefined ? msg.zero : undefined;
  return interpolate(exact ?? msg[category] ?? msg.other, params, locale);
}

/** `base` (English) defines every key; `overrides` is a partial translation. A missing key falls back to English. */
export function createTranslator<C extends CatalogShape>(
  base: C,
  overrides: Partial<Record<keyof C, Message>>,
  locale: string,
): Translate<C> {
  return ((key: string, params?: Record<string, string | number>) => {
    const msg =
      (overrides as Record<string, Message | undefined>)[key] ??
      (base as Record<string, Message>)[key];
    if (msg === undefined) return key;
    return resolveMessage(msg, params, locale);
  }) as Translate<C>;
}

/** "in_review" -> "In review": the fallback when a value has no catalog entry (new enum members from the API). */
export function humanize(value: string): string {
  const s = value.replace(/[._-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : value;
}

/** All `{placeholders}` used by a message (any plural form). */
export function placeholdersOf(msg: Message): string[] {
  const forms = typeof msg === 'string' ? [msg] : Object.values(msg);
  return [...new Set(forms.flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
}
