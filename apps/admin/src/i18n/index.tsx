'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
} from '@yapilapi/ui';
import { directionOf, humanize, type Locale } from './core';
import { en } from './messages/en';
import { makeT, type T } from './make';

export { makeT, type Messages, type MessageKey, type T } from './make';
export { type Locale } from './core';

/** Localised label for an enum-like value from the API (`group.value` in the catalog), humanised when unknown. */
export function makeLabel(t: T): (group: string, value: string | null | undefined) => string {
  return (group, value) => {
    if (value === null || value === undefined || value === '') return t('common.none');
    const key = `${group}.${value}`;
    return key in en ? t(key as never) : humanize(value);
  };
}

export interface Formatters {
  number: (n: number, o?: Intl.NumberFormatOptions) => string;
  compact: (n: number) => string;
  percent: (ratio: number) => string;
  /** Money from minor units (cents). */
  money: (cents: number | string, currency: string) => string;
  date: (d: Date | string | number) => string;
  dateTime: (d: Date | string | number) => string;
  relative: (d: Date | string | number) => string;
}

export function makeFormatters(locale: string = 'en'): Formatters {
  return {
    number: (n, o) => formatNumber(n, locale, o),
    compact: (n) => formatCompact(n, locale),
    percent: (r) => formatNumber(r, locale, { style: 'percent', maximumFractionDigits: 1 }),
    money: (cents, currency) => formatCurrency(Number(cents) / 100, currency, locale),
    date: (d) => formatDate(d, locale, { dateStyle: 'medium' }, 'UTC'),
    dateTime: (d) => formatDateTime(d, locale, 'UTC'),
    relative: (d) => formatRelativeTime(d, locale),
  };
}

/** Translate a key built at runtime (e.g. `businesses.${action}Title`). Keys are checked by the catalog test; unknown keys render as the key. */
export type TX = (key: string, params?: Record<string, string | number>) => string;

interface Ctx {
  t: T;
  tx: TX;
  label: ReturnType<typeof makeLabel>;
  fmt: Formatters;
  locale: Locale;
  dir: 'ltr' | 'rtl';
}
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<Ctx>(() => {
    const t = makeT(locale);
    return {
      t,
      tx: t as unknown as TX,
      label: makeLabel(t),
      fmt: makeFormatters(locale),
      locale,
      dir: directionOf(locale),
    };
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useI18n() requires <I18nProvider>');
  return c;
}
export const useT = (): T => useI18n().t;
