/**
 * The API's error messages in each language, keyed by the English the API writes. A message made
 * from values is a template: `{name}` slots stand for the values, which the API fills in from the
 * English message it matched (apps/api/src/lib/error-language.ts).
 *
 * Only the API imports these (through `@yapilapi/shared/error-messages`): the web and the phone get
 * errors already in the reader's language, so none of this is in their bundles. English is the
 * source and has no table. apps/api/test/error-translations.test.ts checks every message the API
 * can send has an entry in every table.
 */
import { am } from './am.ts';
import { ar } from './ar.ts';
import { bn } from './bn.ts';
import { de } from './de.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { ha } from './ha.ts';
import { hi } from './hi.ts';
import { id } from './id.ts';
import { ig } from './ig.ts';
import { it } from './it.ts';
import { ja } from './ja.ts';
import { ko } from './ko.ts';
import { pt } from './pt.ts';
import { ru } from './ru.ts';
import { sw } from './sw.ts';
import { tr } from './tr.ts';
import { ur } from './ur.ts';
import { vi } from './vi.ts';
import { yo } from './yo.ts';
import { zh } from './zh.ts';
import { zu } from './zu.ts';

export type ErrorMessages = Record<string, string>;

export const ERROR_MESSAGES: Record<string, ErrorMessages> = { fr, ar, es, pt, sw, yo, ha, zh, hi, bn, ru, ja, de, id, tr, ko, it, vi, ur, am, ig, zu };
