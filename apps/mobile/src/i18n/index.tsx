import React, { createContext, useContext, useMemo } from 'react';
import { directionFor } from '@yapilapi/design-system';
import { createTranslator, DEFAULT_LOCALE, type Locale, type Translate } from './core';
import { en } from './messages/en';
import { fr } from './messages/fr';
import { ar } from './messages/ar';
import { yo } from './messages/yo';
import { usePrefs } from '../prefs';

export type Messages = typeof en;
export type T = Translate<Messages>;
export type MessageKey = keyof Messages & string;

const CATALOGS: Record<Locale, Partial<Record<MessageKey, unknown>>> = { en, fr, ar, yo } as never;

/** Build a translator for a locale. Keys a locale has not translated fall back to English. */
export function makeT(locale: Locale): T {
  return createTranslator(en, CATALOGS[locale] as never, locale) as T;
}

interface I18nValue {
  t: T;
  locale: Locale;
  dir: 'ltr' | 'rtl';
}
const I18nContext = createContext<I18nValue>({
  t: makeT(DEFAULT_LOCALE),
  locale: DEFAULT_LOCALE,
  dir: 'ltr',
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { prefs } = usePrefs();
  const value = useMemo<I18nValue>(
    () => ({ t: makeT(prefs.locale), locale: prefs.locale, dir: directionFor(prefs.locale) }),
    [prefs.locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
export const useT = () => useContext(I18nContext).t;
