import { describe, expect, it } from 'vitest';
import { accentContrast, CHAT_ACCENTS, CHAT_WALLPAPERS, chatTheme, DEFAULT_CHAT_THEME, WALLPAPERS } from './chat-theme.ts';
import { contrastRatio } from './profile-style.ts';

// tokens.json: ink-muted, the colour of times, day labels and system lines that sit on the wallpaper.
const INK_MUTED = { light: '#555B75', dark: '#9AA0BC' };

describe('chat themes', () => {
  it('measures contrast the WCAG way', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    // Order doesn't matter.
    expect(contrastRatio('#D21D4A', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#D21D4A'), 5);
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`keeps the text on your bubbles at AA in ${mode} mode`, () => {
      const weak = CHAT_ACCENTS.filter((a) => accentContrast(a, mode) < 4.5).map((a) => `${a}: ${accentContrast(a, mode).toFixed(2)}`);
      expect(weak).toEqual([]);
    });

    it(`keeps muted text readable on every wallpaper in ${mode} mode`, () => {
      const weak: string[] = [];
      for (const w of CHAT_WALLPAPERS) {
        const c = WALLPAPERS[w][mode];
        for (const bg of [c.from, c.to, ...(c.mark ? [c.mark] : [])]) {
          const ratio = contrastRatio(INK_MUTED[mode], bg);
          if (ratio < 4.5) weak.push(`${w} ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(weak).toEqual([]);
    });

    it(`keeps pattern marks faint in ${mode} mode`, () => {
      for (const w of CHAT_WALLPAPERS) {
        const c = WALLPAPERS[w][mode];
        if (c.mark) expect(contrastRatio(c.mark, c.from), w).toBeLessThan(1.6);
      }
    });
  }

  it('falls back to the default for names it does not know', () => {
    expect(chatTheme(null)).toEqual(DEFAULT_CHAT_THEME);
    expect(chatTheme({ wallpaper: 'nebula', accent: 'ocean' })).toEqual({ wallpaper: 'plain', accent: 'ocean' });
    expect(chatTheme({ wallpaper: 'dots', accent: 42 })).toEqual({ wallpaper: 'dots', accent: 'yapi' });
  });

  it('gives every wallpaper both appearances and patterns their marks', () => {
    for (const w of CHAT_WALLPAPERS) {
      const spec = WALLPAPERS[w];
      expect(!!spec.pattern, w).toBe(spec.kind === 'pattern');
      if (spec.kind === 'pattern') expect(spec.light.mark && spec.dark.mark, w).toBeTruthy();
    }
  });
});
