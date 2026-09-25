import { describe, expect, it } from 'vitest';
import { parsePrefs } from './prefs-shared';
import { roundCoord } from './geo';

describe('parsePrefs', () => {
  it('reads valid cookies and falls back on junk', () => {
    const jar: Record<string, string> = {
      yl_locale: 'ar',
      yl_theme: 'dark',
      yl_motion: 'reduce',
      yl_bw: 'low',
      yl_contrast: 'more',
    };
    expect(parsePrefs((n) => jar[n], 'en')).toEqual({
      locale: 'ar',
      theme: 'dark',
      motion: 'reduce',
      bandwidth: 'low',
      contrast: 'more',
    });
    const junk: Record<string, string> = {
      yl_locale: 'klingon',
      yl_theme: 'neon',
      yl_motion: '1',
      yl_bw: 'x',
      yl_contrast: '',
    };
    expect(parsePrefs((n) => junk[n], 'fr')).toEqual({
      locale: 'fr',
      theme: 'system',
      motion: 'system',
      bandwidth: 'auto',
      contrast: 'system',
    });
  });
});

describe('roundCoord', () => {
  it('rounds to about one kilometre', () => {
    expect(roundCoord(6.524379)).toBe(6.52);
    expect(roundCoord(3.379206)).toBe(3.38);
    expect(roundCoord(-33.8688)).toBe(-33.87);
  });
});
