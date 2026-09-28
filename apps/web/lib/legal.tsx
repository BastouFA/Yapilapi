/**
 * Who runs the service and how to reach them, for the legal pages. Set these
 * on the web service before launch (docs/operations/app-store.md, "Before you
 * submit"); until then the pages show the bracketed placeholders, which is
 * obvious on purpose.
 */
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { LEGAL_DOCS, type LegalSlug } from '@yapilapi/shared';
import { siteOrigin } from './public';

export interface LegalContacts {
  /** The company or person that operates YAPILAPI, e.g. "YAPILAPI Ltd". */
  entity: string;
  /** Its registered postal address. */
  address: string;
  /** Whose law governs the terms, and where disputes go, e.g. "the laws of Nigeria". */
  jurisdiction: string;
  support: string;
  privacy: string;
  copyright: string;
  safety: string;
}

/** Read at request time, so the addresses can be set on the running service without a rebuild. */
export async function legalContacts(): Promise<LegalContacts> {
  await connection();
  const e = process.env;
  return {
    entity: e.LEGAL_ENTITY_NAME || '[Company legal name]',
    address: e.LEGAL_ADDRESS || '[Registered address]',
    jurisdiction: e.LEGAL_JURISDICTION || '[Governing law]',
    support: e.SUPPORT_EMAIL || '[support email address]',
    privacy: e.PRIVACY_EMAIL || '[privacy email address]',
    copyright: e.COPYRIGHT_EMAIL || '[copyright email address]',
    safety: e.SAFETY_EMAIL || '[safety email address]',
  };
}

/** An email address as a link, or the placeholder as plain text while it isn't set. */
export function Mail({ to }: { to: string }) {
  return to.includes('@') && !to.startsWith('[') ? <a href={`mailto:${to}`}>{to}</a> : <strong>{to}</strong>;
}

const DESCRIPTIONS: Record<LegalSlug, string> = {
  terms: 'The agreement between you and YAPILAPI when you use the app and the website.',
  privacy: 'What YAPILAPI collects, why, who helps run the service, and the choices you have.',
  guidelines: 'What is and isn’t allowed on YAPILAPI, and what happens when the rules are broken.',
  safety: 'The minimum age on YAPILAPI, how teens are protected, and family links.',
  creators: 'Selling, subscriptions, tips, payouts and the platform fee on YAPILAPI.',
  copyright: 'How to report content on YAPILAPI that uses your work, and how to respond.',
  cookies: 'The one cookie YAPILAPI sets, and what the website keeps in your browser.',
};

const TITLES: Record<LegalSlug, string> = {
  terms: 'Terms of service',
  privacy: 'Privacy policy',
  guidelines: 'Community guidelines',
  safety: 'Safety and minors',
  creators: 'Creator and seller terms',
  copyright: 'Copyright and takedowns',
  cookies: 'Cookie notice',
};

/** Title, description and canonical link of a legal page (the share card is the site's). */
export async function legalMetadata(slug: LegalSlug): Promise<Metadata> {
  if (!LEGAL_DOCS.some((d) => d.slug === slug)) return {};
  return {
    metadataBase: new URL(await siteOrigin()),
    title: TITLES[slug],
    description: DESCRIPTIONS[slug],
    alternates: { canonical: `/legal/${slug}` },
  };
}
