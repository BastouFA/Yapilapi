/**
 * Every message catalog, loaded up front, with the translation helpers from `./i18n-core.ts`.
 * The phone (apps/mobile) and the API import this: t() then answers in any language straight away.
 * The web imports `@yapilapi/shared`, which only carries English and loads the reader's language
 * with loadLocale(). The catalogs themselves are in `locales/`.
 */
import { registerLocale, type Catalog } from './i18n-core.ts';
import { ar } from './locales/ar.ts';
import { en } from './locales/en.ts';
import { es } from './locales/es.ts';
import { fr } from './locales/fr.ts';
import { ha } from './locales/ha.ts';
import { pt } from './locales/pt.ts';
import { sw } from './locales/sw.ts';
import { yo } from './locales/yo.ts';

export * from './i18n-core.ts';

export const CATALOGS: Record<string, Catalog> = { en, fr, ar, es, pt, sw, yo, ha };
for (const [code, catalog] of Object.entries(CATALOGS)) registerLocale(code, catalog);
