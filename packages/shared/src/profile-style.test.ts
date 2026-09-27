import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  ensureContrast,
  linkHost,
  mixHex,
  parseHex,
  PROFILE_ACCENTS,
  PROFILE_ACCENT_IDS,
  PROFILE_TABS,
  profileAccent,
  profileAccentColors,
  profileQrInk,
  profileTabs,
  THEME_SURFACES,
} from './profile-style.ts';
import { updateProfileSchema, profileLinkSchema } from './schemas.ts';

const AA = 4.5;

describe('contrast math', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Order doesn't matter.
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#777777'), 10);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('reads short and long hex, and refuses anything else', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#0E1020')).toEqual([14, 16, 32]);
    expect(parseHex('#0E10208C')).toEqual([14, 16, 32]);
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});

describe('ensureContrast', () => {
  it('leaves a colour that already passes alone', () => {
    expect(ensureContrast('#0E1020', ['#FFFFFF'])).toBe('#0E1020');
  });

  it('darkens on light backgrounds and lightens on dark ones until it passes', () => {
    const light = ensureContrast('#FFD43B', ['#FFFFFF', '#F4F5FA']);
    expect(contrastRatio(light, '#FFFFFF')).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(light, '#F4F5FA')).toBeGreaterThanOrEqual(AA);
    const dark = ensureContrast('#1C2A6B', ['#0B0C14', '#151726']);
    expect(contrastRatio(dark, '#0B0C14')).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(dark, '#151726')).toBeGreaterThanOrEqual(AA);
  });

  it('meets stricter targets too, falling back to black or white', () => {
    expect(contrastRatio(ensureContrast('#E09A12', ['#FFFFFF'], 7), '#FFFFFF')).toBeGreaterThanOrEqual(7);
    expect(ensureContrast('#808080', ['#FFFFFF'], 21)).toBe('#000000');
    expect(ensureContrast('#808080', ['#000000'], 21)).toBe('#FFFFFF');
    expect(ensureContrast('not a colour', ['#FFFFFF'])).toBe('#000000');
  });
});

describe('profile accents', () => {
  it('offers 8 to 10 distinct accents, the brand one first', () => {
    expect(PROFILE_ACCENTS.length).toBeGreaterThanOrEqual(8);
    expect(PROFILE_ACCENTS.length).toBeLessThanOrEqual(10);
    expect(PROFILE_ACCENTS[0]!.id).toBe('yapi');
    expect(PROFILE_ACCENTS.map((a) => a.id)).toEqual([...PROFILE_ACCENT_IDS]);
    expect(new Set(PROFILE_ACCENTS.map((a) => a.hex)).size).toBe(PROFILE_ACCENTS.length);
  });

  for (const theme of ['light', 'dark'] as const)
    for (const { id } of PROFILE_ACCENTS)
      it(`keeps every text pair at AA for ${id} in ${theme}`, () => {
        const c = profileAccentColors(id, theme);
        const s = THEME_SURFACES[theme];
        // Accent text (links, the selected tab) on the page and on cards.
        for (const bg of [s.ground, s.surface]) {
          expect(contrastRatio(c.accent, bg)).toBeGreaterThanOrEqual(AA);
          expect(contrastRatio(c.accentStrong, bg)).toBeGreaterThanOrEqual(AA);
        }
        // Button text on every stop of the primary button's gradient.
        for (const bg of [c.accent, c.accentStrong, c.gradEnd]) expect(contrastRatio(c.onAccent, bg)).toBeGreaterThanOrEqual(AA);
        // Chip text on the soft tint.
        expect(contrastRatio(c.accentStrong, c.soft)).toBeGreaterThanOrEqual(AA);
      });

  it('uses the brand accent for missing or retired values', () => {
    expect(profileAccent(null)).toBe('yapi');
    expect(profileAccent('neon')).toBe('yapi');
    expect(profileAccent('teal')).toBe('teal');
    expect(profileAccentColors('neon', 'light')).toEqual(profileAccentColors('yapi', 'light'));
  });

  it('keeps the brand accent close to the design tokens', () => {
    const tokens = JSON.parse(readFileSync(new URL('../../design-system/tokens.json', import.meta.url), 'utf8')) as {
      color: { tokens: { name: string; value: string | Record<string, string> }[] };
    };
    const token = (name: string, theme: 'light' | 'dark') => {
      const v = tokens.color.tokens.find((t) => t.name === name)!.value;
      return typeof v === 'string' ? v : v[theme]!;
    };
    for (const theme of ['light', 'dark'] as const) {
      expect(THEME_SURFACES[theme].ground).toBe(token('ground', theme));
      expect(THEME_SURFACES[theme].surface).toBe(token('surface', theme));
      expect(THEME_SURFACES[theme].ink).toBe(token('ink', theme));
    }
    expect(profileAccentColors('yapi', 'light').accent).toBe(token('yapi', 'light'));
    expect(profileAccentColors('yapi', 'dark').accent).toBe(token('yapi', 'dark'));
  });

  it('draws QR codes dark enough for any camera', () => {
    for (const { id } of PROFILE_ACCENTS) expect(contrastRatio(profileQrInk(id), '#FFFFFF')).toBeGreaterThanOrEqual(7);
  });
});

describe('profile tabs', () => {
  it('keeps known tabs once each, in order, and never none', () => {
    expect(profileTabs(['shop', 'posts', 'shop', 'nope'])).toEqual(['shop', 'posts']);
    expect(profileTabs(null)).toEqual([...PROFILE_TABS]);
    expect(profileTabs([])).toEqual([...PROFILE_TABS]);
  });
});

describe('profile fields', () => {
  const parse = (b: unknown) => updateProfileSchema.safeParse(b);

  it('accepts web links only, with a real host and no credentials', () => {
    const ok = (url: string) => profileLinkSchema.safeParse({ label: 'Site', url }).success;
    expect(ok('https://example.com')).toBe(true);
    expect(ok('http://shop.example.co.uk/path?q=1')).toBe(true);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('data:text/html,hi')).toBe(false);
    expect(ok('ftp://example.com')).toBe(false);
    expect(ok('https://user:pass@example.com')).toBe(false);
    expect(ok('https://localhost/')).toBe(false);
    expect(ok('https://intranet/')).toBe(false);
    expect(ok(`https://example.com/${'a'.repeat(500)}`)).toBe(false);
    expect(profileLinkSchema.safeParse({ label: '', url: 'https://example.com' }).success).toBe(false);
    expect(profileLinkSchema.safeParse({ label: 'x'.repeat(41), url: 'https://example.com' }).success).toBe(false);
  });

  it('takes up to 5 links', () => {
    const link = { label: 'Site', url: 'https://example.com' };
    expect(parse({ links: Array(5).fill(link) }).success).toBe(true);
    expect(parse({ links: Array(6).fill(link) }).success).toBe(false);
  });

  it('keeps pronouns and city to one short line of text', () => {
    expect(parse({ pronouns: 'she/her' }).success).toBe(true);
    expect(parse({ pronouns: 'x'.repeat(30) }).success).toBe(true);
    expect(parse({ pronouns: 'x'.repeat(31) }).success).toBe(false);
    expect(parse({ pronouns: 'she\nher' }).success).toBe(false);
    expect(parse({ city: 'Lagos' }).success).toBe(true);
    expect(parse({ city: 'x'.repeat(61) }).success).toBe(false);
    expect(parse({ city: 'https://maps.example.com/abc' }).success).toBe(false);
    // Blank clears it.
    expect(parse({ pronouns: '  ' }).data).toEqual({ pronouns: null });
  });

  it('checks accents, header styles, tabs and featured posts', () => {
    const id = '7f0c7a8e-8a4b-4d3e-9f7a-0a1b2c3d4e5f';
    const id2 = '8f0c7a8e-8a4b-4d3e-9f7a-0a1b2c3d4e5f';
    expect(parse({ accent: 'teal', headerStyle: 'clean' }).success).toBe(true);
    expect(parse({ accent: '#ff0000' }).success).toBe(false);
    expect(parse({ headerStyle: 'video' }).success).toBe(false);
    expect(parse({ tabs: ['reels', 'posts'] }).success).toBe(true);
    expect(parse({ tabs: [] }).success).toBe(false);
    expect(parse({ tabs: ['posts', 'posts'] }).success).toBe(false);
    expect(parse({ tabs: ['stories'] }).success).toBe(false);
    expect(parse({ featuredPostIds: [id, id2] }).success).toBe(true);
    expect(parse({ featuredPostIds: [id, id] }).success).toBe(false);
    expect(parse({ featuredPostIds: [id, id2, id2.replace('8f', '9f'), id2.replace('8f', 'af')] }).success).toBe(false);
  });

  it('names a link by its host', () => {
    expect(linkHost('https://www.Example.com/a')).toBe('example.com');
    expect(linkHost('mailto:a@b.c')).toBeNull();
    expect(linkHost('nope')).toBeNull();
  });
});
