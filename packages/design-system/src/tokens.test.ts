import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRAST_PAIRS, colorRoles, type ColorRole } from './tokens';
import { WCAG_AA_TEXT, WCAG_AA_UI, WCAG_AAA_TEXT, contrastRatio } from './contrast';

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** Extract `--yl-…: value;` declarations of the block that starts at `selector {`. */
function block(selector: string, from = 0): Record<string, string> {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--yl-[\w-]+):\s*([^;]+);/g))
    out[m[1]!] = m[2]!.trim().replace(/\s*\/\*.*$/, '');
  return out;
}

const light = block(':root');
const darkExplicit = block(":root[data-theme='dark']");
const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkSystem = block(":root:not([data-theme='light'])", mediaStart);
const lightHc = block(":root[data-contrast='more']");
const darkHc = block(":root[data-theme='dark'][data-contrast='more']");

type Theme = Record<string, string>;
const themes: Record<string, Theme> = {
  light,
  dark: { ...light, ...darkExplicit },
  'light-high-contrast': { ...light, ...lightHc },
  'dark-high-contrast': { ...light, ...darkExplicit, ...darkHc },
};
const val = (t: Theme, role: ColorRole) => t[`--yl-color-${role}`]!;

describe('design tokens', () => {
  it('defines every declared color role in the light theme', () => {
    for (const role of colorRoles) expect(light[`--yl-color-${role}`], role).toBeTruthy();
  });

  it('keeps the explicit dark theme and the system-dark media query identical', () => {
    expect(darkSystem).toEqual(darkExplicit);
    expect(Object.keys(darkExplicit).length).toBeGreaterThan(30);
  });

  it('overrides the same roles in dark as exist in light (no role left light-only)', () => {
    for (const role of colorRoles) {
      if (role === 'primary-active' || role === 'text-inverse') continue;
      expect(darkExplicit[`--yl-color-${role}`] ?? null, `dark ${role}`).not.toBeNull();
    }
  });

  for (const [name, theme] of Object.entries(themes)) {
    describe(`WCAG contrast: ${name}`, () => {
      for (const [fg, bg, level] of CONTRAST_PAIRS) {
        // The overlay/gradient-only roles are hex-free; every pair here is solid hex.
        const fgv = val(theme, fg);
        const bgv = val(theme, bg);
        if (!/^#/.test(fgv) || !/^#/.test(bgv)) continue;
        // High-contrast themes must reach AAA for body text roles.
        const hc = name.includes('high-contrast');
        const strictText =
          hc &&
          ['text', 'text-muted', 'text-subtle'].includes(fg) &&
          ['bg', 'surface'].includes(bg);
        const min = strictText ? WCAG_AAA_TEXT : level === 'ui' ? WCAG_AA_UI : WCAG_AA_TEXT;
        it(`${fg} on ${bg} >= ${min}`, () => {
          expect(contrastRatio(fgv, bgv)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it('turns motion off for reduce-motion and low-bandwidth', () => {
    expect(block(":root[data-motion='reduce']")['--yl-dur-3']).toBe('0.01ms');
    expect(block(":root[data-bandwidth='low']")['--yl-dur-3']).toBe('0.01ms');
    expect(block(":root[data-bandwidth='low']")['--yl-shadow-2']).toBe('none');
  });

  it('honours prefers-reduced-motion and prefers-contrast media queries', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (prefers-contrast: more)');
  });

  it('exposes a spacing, radius, type, motion and elevation scale', () => {
    for (const k of [
      '--yl-space-4',
      '--yl-radius-lg',
      '--yl-text-md',
      '--yl-dur-2',
      '--yl-ease-standard',
      '--yl-shadow-3',
      '--yl-font-sans',
    ]) {
      expect(light[k], k).toBeTruthy();
    }
  });
});
