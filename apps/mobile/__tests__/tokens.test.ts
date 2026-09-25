import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tokens, buildTheme } from '../src/theme';
import { resolveTheme } from '@yapilapi/design-system';

describe('design tokens', () => {
  it('src/theme/tokens.generated.ts is in sync with packages/design-system/src/tokens.css', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/sync-tokens.mts', '--check'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('light and dark palettes define the same roles and differ', () => {
    expect(Object.keys(tokens.colors.dark).sort()).toEqual(Object.keys(tokens.colors.light).sort());
    expect(tokens.colors.dark.bg).not.toBe(tokens.colors.light.bg);
    expect(buildTheme('dark').colors.text).toBe(tokens.colors.dark.text);
    expect(buildTheme('light').colors.primary).toBe(tokens.colors.light.primary);
  });

  it('touch targets are at least 44px', () => {
    expect(tokens.targetMin).toBeGreaterThanOrEqual(44);
  });

  it('text/background pairs used by the UI meet WCAG AA (4.5:1) in both schemes', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const scheme of ['light', 'dark'] as const) {
      const c = tokens.colors[scheme];
      for (const [fg, bg] of [
        ['text', 'bg'],
        ['text', 'surface'],
        ['textMuted', 'surface'],
        ['onPrimary', 'primary'],
        ['primaryText', 'surface'],
        ['danger', 'surface'],
        ['onPrimarySoft', 'primarySoft'],
      ] as const) {
        expect({ scheme, fg, bg, ok: ratio(c[fg], c[bg]) >= 4.5 }).toEqual({
          scheme,
          fg,
          bg,
          ok: true,
        });
      }
    }
  });

  it('the theme preference resolves through the shared design-system rule', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
