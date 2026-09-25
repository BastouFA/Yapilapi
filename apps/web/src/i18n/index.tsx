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
import type { Locale } from './core';
import { makeT, type T } from './make';
import { usePrefs } from '@/lib/prefs';

export { makeT, type T, type Messages, type MessageKey } from './make';

export interface Formatters {
  number: (n: number, o?: Intl.NumberFormatOptions) => string;
  compact: (n: number) => string;
  currency: (n: number, currency: string) => string;
  date: (d: Date | string | number, o?: Intl.DateTimeFormatOptions, tz?: string) => string;
  dateTime: (d: Date | string | number, tz?: string) => string;
  relative: (d: Date | string | number) => string;
}

export function makeFormatters(locale: Locale): Formatters {
  return {
    number: (n, o) => formatNumber(n, locale, o),
    compact: (n) => formatCompact(n, locale),
    currency: (n, c) => formatCurrency(n, c, locale),
    date: (d, o, tz) => formatDate(d, locale, o, tz),
    dateTime: (d, tz) => formatDateTime(d, locale, tz),
    relative: (d) => formatRelativeTime(d, locale),
  };
}

interface Ctx {
  t: T;
  locale: Locale;
  dir: 'ltr' | 'rtl';
  fmt: Formatters;
}
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { prefs, dir } = usePrefs();
  const value = useMemo<Ctx>(
    () => ({
      t: makeT(prefs.locale),
      locale: prefs.locale,
      dir,
      fmt: makeFormatters(prefs.locale),
    }),
    [prefs.locale, dir],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useI18n() requires <I18nProvider>');
  return c;
}
export const useT = (): T => useI18n().t;
