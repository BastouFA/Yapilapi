import type {
  BandwidthPreference,
  ContrastPreference,
  MotionPreference,
  ThemePreference,
} from '@yapilapi/design-system';
import { isLocale, type Locale } from '@/i18n/core';

/**
 * Presentation preferences live in plain (non-httpOnly) cookies so the server can render the right language,
 * direction and theme on first paint. They are not credentials. Signed-in users' choices are also saved to the API.
 */
export interface DisplayPrefs {
  locale: Locale;
  theme: ThemePreference;
  motion: MotionPreference;
  bandwidth: BandwidthPreference;
  contrast: ContrastPreference;
}

export const PREF_COOKIES = {
  locale: 'yl_locale',
  theme: 'yl_theme',
  motion: 'yl_motion',
  bandwidth: 'yl_bw',
  contrast: 'yl_contrast',
} as const;

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function parsePrefs(
  get: (name: string) => string | undefined,
  fallbackLocale: Locale,
): DisplayPrefs {
  const loc = get(PREF_COOKIES.locale);
  return {
    locale: isLocale(loc) ? loc : fallbackLocale,
    theme: oneOf(get(PREF_COOKIES.theme), ['system', 'light', 'dark'] as const, 'system'),
    motion: oneOf(get(PREF_COOKIES.motion), ['system', 'reduce', 'full'] as const, 'system'),
    bandwidth: oneOf(get(PREF_COOKIES.bandwidth), ['auto', 'low', 'normal'] as const, 'auto'),
    contrast: oneOf(get(PREF_COOKIES.contrast), ['system', 'more', 'normal'] as const, 'system'),
  };
}
