import { describe, expect, it } from 'vitest';
import { glyphBounds, glyphPath, NAV_GLYPHS, type NavGlyphName } from './nav-glyphs.ts';

describe('navigation glyphs', () => {
  for (const name of Object.keys(NAV_GLYPHS) as NavGlyphName[]) {
    it(`${name} stays inside the 24px grid with at least 1.5px of air`, () => {
      for (const shape of NAV_GLYPHS[name]) {
        const [l, t, r, b] = glyphBounds(shape);
        expect(Math.min(l, t)).toBeGreaterThanOrEqual(1.5);
        expect(Math.max(r, b)).toBeLessThanOrEqual(22.5);
      }
    });
  }

  it('draws closed paths with per-corner radii', () => {
    expect(glyphPath({ kind: 'box', x: 2, y: 2, w: 10, h: 10, r: [4, 4, 4, 1], fill: 'outline' })).toBe(
      'M6 2H8A4 4 0 0 1 12 6V8A4 4 0 0 1 8 12H3A1 1 0 0 1 2 11V6A4 4 0 0 1 6 2Z',
    );
    expect(glyphPath({ kind: 'drop', cx: 12, cy: 10, r: 4, fill: 'solid' })).toMatch(/^M12 15\.657L.*Z$/);
  });

  it('draws a star from its four points with curved-in sides', () => {
    expect(glyphPath({ kind: 'star', cx: 12, cy: 12, r: 8, c: 8 })).toBe('M12 4A8 8 0 0 0 20 12A8 8 0 0 0 12 20A8 8 0 0 0 4 12A8 8 0 0 0 12 4Z');
  });
});
