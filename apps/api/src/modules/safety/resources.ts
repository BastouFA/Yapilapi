/**
 * Support resources shown to people who may be at risk (self-harm signals, distressing reports).
 *
 * IMPORTANT: this is a small, static, hand-curated list of long-established official services. It is marked
 * `needs_regional_review`: before launching in a country, a regional trust-and-safety lead must verify every entry,
 * add local-language services, and confirm availability. We deliberately do NOT include numbers we cannot vouch for;
 * for every other country the response points to the international directory findahelpline.com.
 */

export interface SupportResource {
  name: string;
  kind: 'crisis_line' | 'text_line' | 'child_helpline' | 'directory' | 'emergency';
  phone?: string;
  sms?: string;
  url?: string;
  note?: string;
}

interface RegionEntry {
  emergency?: string;
  resources: SupportResource[];
}

const REGIONS: Record<string, RegionEntry> = {
  US: {
    emergency: '911',
    resources: [
      {
        name: '988 Suicide & Crisis Lifeline',
        kind: 'crisis_line',
        phone: '988',
        sms: '988',
        url: 'https://988lifeline.org',
        note: 'Call or text, 24/7.',
      },
      {
        name: 'Crisis Text Line',
        kind: 'text_line',
        sms: 'Text HOME to 741741',
        url: 'https://www.crisistextline.org',
      },
      {
        name: 'NCMEC CyberTipline (child sexual exploitation)',
        kind: 'child_helpline',
        url: 'https://report.cybertip.org',
        note: 'To report suspected child sexual exploitation.',
      },
    ],
  },
  CA: {
    emergency: '911',
    resources: [
      {
        name: '9-8-8 Suicide Crisis Helpline',
        kind: 'crisis_line',
        phone: '988',
        sms: '988',
        url: 'https://988.ca',
        note: 'Call or text, 24/7.',
      },
    ],
  },
  GB: {
    emergency: '999',
    resources: [
      {
        name: 'Samaritans',
        kind: 'crisis_line',
        phone: '116 123',
        url: 'https://www.samaritans.org',
        note: 'Free, 24/7.',
      },
      {
        name: 'Childline',
        kind: 'child_helpline',
        phone: '0800 1111',
        url: 'https://www.childline.org.uk',
        note: 'For under-19s.',
      },
    ],
  },
  IE: {
    emergency: '112',
    resources: [
      {
        name: 'Samaritans Ireland',
        kind: 'crisis_line',
        phone: '116 123',
        url: 'https://www.samaritans.org/ireland',
        note: 'Free, 24/7.',
      },
    ],
  },
  AU: {
    emergency: '000',
    resources: [
      {
        name: 'Lifeline Australia',
        kind: 'crisis_line',
        phone: '13 11 14',
        url: 'https://www.lifeline.org.au',
        note: '24/7.',
      },
    ],
  },
};

export const DIRECTORY: SupportResource = {
  name: 'Find a Helpline',
  kind: 'directory',
  url: 'https://findahelpline.com',
  note: 'Free directory of verified helplines in most countries, searchable by country and topic.',
};

export const INTERNATIONAL_DIRECTORIES: SupportResource[] = [
  DIRECTORY,
  {
    name: 'International Association for Suicide Prevention: crisis centres',
    kind: 'directory',
    url: 'https://www.iasp.info/crisis-centres-helplines/',
  },
  {
    name: 'INHOPE: hotlines for reporting child sexual abuse material',
    kind: 'directory',
    url: 'https://www.inhope.org',
  },
];

export interface ResourcesPayload {
  region: string | null;
  resolvedRegion: string | null;
  /** Always `needs_regional_review`: see the module comment. */
  reviewStatus: 'needs_regional_review';
  disclaimer: string;
  emergency: { number: string | null; note: string };
  resources: SupportResource[];
  directories: SupportResource[];
}

export function supportResources(region?: string | null): ResourcesPayload {
  const code = region?.trim().toUpperCase().slice(0, 2) || null;
  const entry = code ? REGIONS[code] : undefined;
  return {
    region: code,
    resolvedRegion: entry ? code : null,
    reviewStatus: 'needs_regional_review',
    disclaimer:
      'This list is curated and not exhaustive. If you or someone else is in immediate danger, contact your local emergency number. Use findahelpline.com to find services in your country.',
    emergency: {
      number: entry?.emergency ?? null,
      note: entry?.emergency
        ? 'Local emergency number for this region.'
        : 'Contact your local emergency services.',
    },
    resources: entry?.resources ?? [],
    directories: INTERNATIONAL_DIRECTORIES,
  };
}
