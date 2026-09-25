// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  applyDocumentPreferences,
  connectionWantsLowBandwidth,
  directionFor,
  observeBandwidth,
  readBandwidth,
  resolveBandwidth,
  resolveTheme,
} from './preferences';
import { contrastRatio } from './contrast';

describe('preferences', () => {
  it('resolves theme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('detects RTL locales', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('ar-EG')).toBe('rtl');
    expect(directionFor('yo')).toBe('ltr');
    expect(directionFor('fr-CA')).toBe('ltr');
  });

  it('low-bandwidth: explicit choice wins, auto follows Save-Data and 2G', () => {
    expect(resolveBandwidth('low', null)).toBe('low');
    expect(resolveBandwidth('normal', { saveData: true })).toBe('normal');
    expect(resolveBandwidth('auto', { saveData: true })).toBe('low');
    expect(resolveBandwidth('auto', { effectiveType: '2g' })).toBe('low');
    expect(resolveBandwidth('auto', { effectiveType: '4g' })).toBe('normal');
    expect(connectionWantsLowBandwidth(undefined)).toBe(false);
  });

  it('applies and clears document attributes', () => {
    const root = document.createElement('html');
    applyDocumentPreferences(
      root,
      { theme: 'dark', motion: 'reduce', contrast: 'more', bandwidth: 'low', locale: 'ar' },
      null,
    );
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-motion')).toBe('reduce');
    expect(root.getAttribute('data-contrast')).toBe('more');
    expect(root.getAttribute('data-bandwidth')).toBe('low');
    expect(root.getAttribute('lang')).toBe('ar');
    expect(root.getAttribute('dir')).toBe('rtl');
    applyDocumentPreferences(
      root,
      { theme: 'system', motion: 'system', contrast: 'system', bandwidth: 'normal' },
      null,
    );
    for (const a of ['data-theme', 'data-motion', 'data-contrast', 'data-bandwidth'])
      expect(root.hasAttribute(a)).toBe(false);
  });

  it('notifies observers when the bandwidth mode changes', async () => {
    const root = document.createElement('html');
    const cb = vi.fn();
    const stop = observeBandwidth(root, cb);
    applyDocumentPreferences(root, { bandwidth: 'low' }, null);
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledWith('low');
    expect(readBandwidth(root)).toBe('low');
    stop();
  });
});

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(() => contrastRatio('red', '#fff')).toThrow();
  });
});
