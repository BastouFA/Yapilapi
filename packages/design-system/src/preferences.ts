/**
 * Document-level presentation preferences: theme, motion, contrast, bandwidth and text direction.
 * Framework-neutral and DOM-light so React Native web wrappers, Next.js and tests can share it. The functions
 * take the root element explicitly, so nothing here touches globals unless you pass them in.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'reduce' | 'full';
export type ContrastPreference = 'system' | 'more' | 'normal';
/** "auto" follows the browser's Save-Data / slow-network hints; "low" is the user's explicit low-bandwidth mode. */
export type BandwidthPreference = 'auto' | 'low' | 'normal';

export interface PresentationPreferences {
  theme: ThemePreference;
  motion: MotionPreference;
  contrast: ContrastPreference;
  bandwidth: BandwidthPreference;
  locale?: string;
}

export const defaultPreferences: PresentationPreferences = {
  theme: 'system',
  motion: 'system',
  contrast: 'system',
  bandwidth: 'auto',
};

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
  addEventListener?: (type: 'change', cb: () => void) => void;
  removeEventListener?: (type: 'change', cb: () => void) => void;
}

const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

export function isRtl(locale: string): boolean {
  return RTL_LANGS.has(locale.toLowerCase().split(/[-_]/)[0] ?? '');
}
export const directionFor = (locale: string): 'ltr' | 'rtl' => (isRtl(locale) ? 'rtl' : 'ltr');

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): 'light' | 'dark' {
  return pref === 'system' ? (systemPrefersDark ? 'dark' : 'light') : pref;
}

/** True when the browser asks us to save data or the connection is 2G-class. */
export function connectionWantsLowBandwidth(
  conn: NetworkInformationLike | undefined | null,
): boolean {
  if (!conn) return false;
  return conn.saveData === true || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
}

export function resolveBandwidth(
  pref: BandwidthPreference,
  conn?: NetworkInformationLike | null,
): 'low' | 'normal' {
  if (pref === 'low') return 'low';
  if (pref === 'normal') return 'normal';
  return connectionWantsLowBandwidth(conn) ? 'low' : 'normal';
}

export function getNetworkInformation(
  nav: unknown = typeof navigator === 'undefined' ? undefined : navigator,
): NetworkInformationLike | null {
  const c = (nav as { connection?: NetworkInformationLike } | undefined)?.connection;
  return c ?? null;
}

/**
 * Apply preferences to <html>. "system" values remove the attribute so the CSS media queries decide.
 * Returns the resolved bandwidth mode so callers (data hooks, image components) can react to it.
 */
export function applyDocumentPreferences(
  root: HTMLElement,
  prefs: Partial<PresentationPreferences>,
  conn: NetworkInformationLike | null = getNetworkInformation(),
): { bandwidth: 'low' | 'normal' } {
  const p = { ...defaultPreferences, ...prefs };
  const setOrClear = (name: string, value: string | null) =>
    value === null ? root.removeAttribute(name) : root.setAttribute(name, value);
  setOrClear('data-theme', p.theme === 'system' ? null : p.theme);
  setOrClear('data-motion', p.motion === 'system' ? null : p.motion);
  setOrClear('data-contrast', p.contrast === 'system' ? null : p.contrast);
  const bandwidth = resolveBandwidth(p.bandwidth, conn);
  setOrClear('data-bandwidth', bandwidth === 'low' ? 'low' : null);
  if (p.locale) {
    root.setAttribute('lang', p.locale);
    root.setAttribute('dir', directionFor(p.locale));
  }
  return { bandwidth };
}

/** Bandwidth mode currently applied to the document. */
export function readBandwidth(root: HTMLElement): 'low' | 'normal' {
  return root.getAttribute('data-bandwidth') === 'low' ? 'low' : 'normal';
}

/** Subscribe to changes of the applied bandwidth mode (attribute mutations). Returns an unsubscribe function. */
export function observeBandwidth(
  root: HTMLElement,
  cb: (mode: 'low' | 'normal') => void,
): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const obs = new MutationObserver(() => cb(readBandwidth(root)));
  obs.observe(root, { attributes: true, attributeFilter: ['data-bandwidth'] });
  return () => obs.disconnect();
}
