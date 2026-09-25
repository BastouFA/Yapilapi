import { createTranslator, type Locale, type Translate } from './core';
import { en } from './messages/en';
import { fr } from './messages/fr';
import { ar } from './messages/ar';
import { yo } from './messages/yo';

export type Messages = typeof en;
export type T = Translate<Messages>;
export type MessageKey = keyof Messages & string;

const CATALOGS: Record<Locale, Partial<Record<MessageKey, unknown>>> = { en, fr, ar, yo } as never;

/** Build a translator for a locale (usable from server and client code). Missing keys fall back to English. */
export function makeT(locale: Locale): T {
  return createTranslator(en, CATALOGS[locale] as never, locale) as T;
}
