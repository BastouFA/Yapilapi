import { enCore } from './en-core';
import { enPeople } from './en-people';
import { enSafety } from './en-safety';
import { enMoney } from './en-money';
import { enInsights } from './en-insights';
import { enPlatform } from './en-platform';

/**
 * English is the source catalog: every key exists here. Other locales may omit keys (they fall back to English) but
 * must never add keys or change `{placeholders}` (see catalogs.test.ts).
 */
export const en = {
  ...enCore,
  ...enPeople,
  ...enSafety,
  ...enMoney,
  ...enInsights,
  ...enPlatform,
} as const;
