import type { MessageKey } from './i18n-core.ts';

/**
 * The legal and policy pages, in the order they are listed. The web app serves
 * each at /legal/<slug> (public, no sign-in); the phone app lists them in
 * Settings and opens them in the browser. Their bodies are English templates
 * that a lawyer must review before launch (docs/operations/app-store.md).
 */
export const LEGAL_DOCS = [
  { slug: 'terms', title: 'legal.terms', summary: 'legal.terms.summary' },
  { slug: 'privacy', title: 'legal.privacy', summary: 'legal.privacy.summary' },
  { slug: 'guidelines', title: 'legal.guidelines', summary: 'legal.guidelines.summary' },
  { slug: 'safety', title: 'legal.safety', summary: 'legal.safety.summary' },
  { slug: 'creators', title: 'legal.creators', summary: 'legal.creators.summary' },
  { slug: 'copyright', title: 'legal.copyright', summary: 'legal.copyright.summary' },
  { slug: 'cookies', title: 'legal.cookies', summary: 'legal.cookies.summary' },
] as const satisfies readonly { slug: string; title: MessageKey; summary: MessageKey }[];

export type LegalSlug = (typeof LEGAL_DOCS)[number]['slug'];

/** When the templates were last changed (shown as "Last updated" on every page). */
export const LEGAL_UPDATED = '2026-09-28';

/** The share of each sale, tip and subscription the platform keeps (PLATFORM_FEE_BPS = 500 in apps/api/src/modules/money.ts, economy.ts and commerce.ts). */
export const PLATFORM_FEE_PERCENT = 5;
