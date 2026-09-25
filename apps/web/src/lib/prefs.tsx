'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  applyDocumentPreferences,
  directionFor,
  getNetworkInformation,
} from '@yapilapi/design-system';
import { PREF_COOKIES, type DisplayPrefs } from './prefs-shared';

export { PREF_COOKIES, parsePrefs, type DisplayPrefs } from './prefs-shared';

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
}

interface Ctx {
  prefs: DisplayPrefs;
  setPrefs: (patch: Partial<DisplayPrefs>) => void;
  dir: 'ltr' | 'rtl';
}
const PrefsContext = createContext<Ctx | null>(null);

export function PrefsProvider({
  initial,
  children,
}: {
  initial: DisplayPrefs;
  children: ReactNode;
}) {
  const [prefs, setState] = useState(initial);

  const apply = useCallback((p: DisplayPrefs) => {
    applyDocumentPreferences(
      document.documentElement,
      {
        theme: p.theme,
        motion: p.motion,
        contrast: p.contrast,
        bandwidth: p.bandwidth,
        locale: p.locale,
      },
      getNetworkInformation(),
    );
  }, []);

  // Resolve "auto" bandwidth (Save-Data / 2G) once the browser is available and whenever the connection changes.
  useEffect(() => {
    apply(prefs);
    const conn = getNetworkInformation() as {
      addEventListener?: (t: string, cb: () => void) => void;
      removeEventListener?: (t: string, cb: () => void) => void;
    } | null;
    if (!conn?.addEventListener) return;
    const cb = () => apply(prefs);
    conn.addEventListener('change', cb);
    return () => conn.removeEventListener?.('change', cb);
  }, [prefs, apply]);

  const setPrefs = useCallback((patch: Partial<DisplayPrefs>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      for (const k of Object.keys(PREF_COOKIES) as Array<keyof DisplayPrefs>)
        if (next[k] !== prev[k]) writeCookie(PREF_COOKIES[k], next[k]);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ prefs, setPrefs, dir: directionFor(prefs.locale) }),
    [prefs, setPrefs],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Ctx {
  const c = useContext(PrefsContext);
  if (!c) throw new Error('usePrefs() requires <PrefsProvider>');
  return c;
}
