import { REGION_NAMES } from './region-names';

/**
 * A country's name in the app's language ("Allemagne" for DE in French). The phone's JavaScript
 * engine has no Intl.DisplayNames, so the names come from a table made from Node's Unicode data
 * (scripts/region-names.mjs); an unknown code is shown as it is.
 */
export function regionName(code: string, locale: string): string {
  const lang = locale.split('-')[0]?.toLowerCase() ?? 'en';
  const up = code.toUpperCase();
  return REGION_NAMES[lang]?.[up] ?? REGION_NAMES.en?.[up] ?? code;
}
