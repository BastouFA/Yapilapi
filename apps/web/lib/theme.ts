'use client';

import { useSyncExternalStore } from 'react';
import { THEME_KEY } from './theme-script';

/**
 * Appearance: Light, Dark or Match device (the default). The choice is kept in this browser and
 * applied as `data-theme` on <html>, which the design tokens follow; "Match device" removes it so
 * `prefers-color-scheme` decides. THEME_SCRIPT runs before the page paints, so a saved choice
 * never flashes the other theme first.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = THEME_KEY;
/** The browser bar colors, as in the root layout's viewport settings. */
const BAR = { light: '#EFEBE6', dark: '#0B0C14' } as const;

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  // The browser's own bar follows too: forced to the choice, or back to one color per scheme.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const scheme = m.media.includes('dark') ? 'dark' : 'light';
    m.content = BAR[choice === 'system' ? scheme : choice];
  });
}

let current: ThemeChoice | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab changed it: follow along.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    apply(current);
    listeners.forEach((l) => l());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

const snapshot = () => (current ??= read());

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private windows can refuse storage: the choice still applies to this visit.
  }
  current = choice;
  apply(choice);
  listeners.forEach((l) => l());
}

/** `const [theme, setTheme] = useTheme()`. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  return [useSyncExternalStore(subscribe, snapshot, () => 'system'), setTheme];
}
