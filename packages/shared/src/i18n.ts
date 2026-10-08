/**
 * Every message catalog, loaded up front, with the translation helpers from `./i18n-core.ts`.
 * The API imports this: t() then answers in any language straight away. The web (`@yapilapi/shared`)
 * and the phone (`./i18n-core.ts` directly) only carry English and load the reader's language with
 * loadLocale(), so a phone evaluates one catalog besides English, not all of them. The catalogs
 * themselves are in `locales/`.
 */
import { registerLocale, type Catalog } from './i18n-core.ts';
import { am } from './locales/am.ts';
import { ar } from './locales/ar.ts';
import { bn } from './locales/bn.ts';
import { de } from './locales/de.ts';
import { en } from './locales/en.ts';
import { es } from './locales/es.ts';
import { fr } from './locales/fr.ts';
import { ha } from './locales/ha.ts';
import { hi } from './locales/hi.ts';
import { id } from './locales/id.ts';
import { ig } from './locales/ig.ts';
import { it } from './locales/it.ts';
import { ja } from './locales/ja.ts';
import { ko } from './locales/ko.ts';
import { pt } from './locales/pt.ts';
import { ru } from './locales/ru.ts';
import { sw } from './locales/sw.ts';
import { tr } from './locales/tr.ts';
import { ur } from './locales/ur.ts';
import { vi } from './locales/vi.ts';
import { yo } from './locales/yo.ts';
import { zh } from './locales/zh.ts';
import { zu } from './locales/zu.ts';
import { nl } from './locales/nl.ts';

export * from './i18n-core.ts';

export const CATALOGS: Record<string, Catalog> = { en, fr, ar, es, pt, sw, yo, ha, zh, hi, bn, ru, ja, de, id, tr, ko, it, vi, ur, am, ig, zu, nl };
for (const [code, catalog] of Object.entries(CATALOGS)) registerLocale(code, catalog);
