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
import { ar } from './ar.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { ha } from './ha.ts';
import { pt } from './pt.ts';
import { sw } from './sw.ts';
import { yo } from './yo.ts';

export type ErrorMessages = Record<string, string>;

export const ERROR_MESSAGES: Record<string, ErrorMessages> = { fr, ar, es, pt, sw, yo, ha };
