import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo, I18nManager, Platform } from 'react-native';
import * as Localization from 'expo-localization';
import NetInfo from '@react-native-community/netinfo';
import {
  resolveBandwidth,
  directionFor,
  type BandwidthPreference,
  type MotionPreference,
  type ThemePreference,
} from '@yapilapi/design-system';
import { kv } from '../lib/kv';
import { DEFAULT_LOCALE, isLocale, negotiateLocale, type Locale } from '../i18n/core';

export interface Prefs {
  theme: ThemePreference;
  motion: MotionPreference;
  bandwidth: BandwidthPreference;
  locale: Locale;
}
const KEY = 'yl.prefs.v1';

function deviceLocale(): Locale {
  try {
    return negotiateLocale(Localization.getLocales().map((l) => l.languageTag));
  } catch {
    return DEFAULT_LOCALE;
  }
}
export const defaultPrefs = (): Prefs => ({
  theme: 'system',
  motion: 'system',
  bandwidth: 'auto',
  locale: deviceLocale(),
});

interface PrefsContextValue {
  prefs: Prefs;
  ready: boolean;
  setPrefs: (patch: Partial<Prefs>) => void;
  /** Resolved values components should use. */
  reducedMotion: boolean;
  lowBandwidth: boolean;
  rtl: boolean;
  /** True after the RTL direction changed and a restart is needed for layout to flip (React Native limitation). */
  needsRestart: boolean;
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: { theme: 'system', motion: 'system', bandwidth: 'auto', locale: DEFAULT_LOCALE },
  ready: false,
  setPrefs: () => undefined,
  reducedMotion: false,
  lowBandwidth: false,
  rtl: false,
  needsRestart: false,
});

/** Applies the layout direction. React Native only re-lays-out after a restart, so we report `needsRestart`. */
export function applyDirection(locale: Locale): boolean {
  const wantRtl = directionFor(locale) === 'rtl';
  try {
    I18nManager.allowRTL(wantRtl);
    if (Platform.OS !== 'web' && I18nManager.isRTL !== wantRtl) {
      I18nManager.forceRTL(wantRtl);
      return true;
    }
  } catch {
    /* unsupported platform */
  }
  return false;
}

export function PrefsProvider({
  children,
  initial,
}: {
  children: React.ReactNode;
  initial?: Partial<Prefs>;
}) {
  const [prefs, setState] = useState<Prefs>(() => ({ ...defaultPrefs(), ...initial }));
  const [ready, setReady] = useState(false);
  const [systemReduce, setSystemReduce] = useState(false);
  const [conn, setConn] = useState<{ saveData?: boolean; effectiveType?: string } | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const touched = useRef(false);

  useEffect(() => {
    let live = true;
    void kv.get<Partial<Prefs>>(KEY).then((stored) => {
      if (!live) return;
      if (stored && !touched.current) {
        const next = { ...defaultPrefs(), ...stored, ...initial };
        if (!isLocale(next.locale)) next.locale = DEFAULT_LOCALE;
        setState(next);
        if (applyDirection(next.locale)) setNeedsRestart(true);
      }
      setReady(true);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => live && setSystemReduce(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduce);
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => {
      const d = s.details as { cellularGeneration?: string | null } | null;
      // Same rule as the web: only 2G-class links switch "auto" bandwidth to low.
      setConn(
        s.type === 'cellular' && d?.cellularGeneration === '2g' ? { effectiveType: '2g' } : null,
      );
    });
    return () => unsub();
  }, []);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    touched.current = true;
    setState((prev) => {
      const next = { ...prev, ...patch };
      void kv.set(KEY, next);
      if (patch.locale && patch.locale !== prev.locale && applyDirection(next.locale))
        setNeedsRestart(true);
      return next;
    });
  }, []);

  const value = useMemo<PrefsContextValue>(
    () => ({
      prefs,
      ready,
      setPrefs,
      needsRestart,
      reducedMotion: prefs.motion === 'reduce' || (prefs.motion === 'system' && systemReduce),
      lowBandwidth: resolveBandwidth(prefs.bandwidth, conn) === 'low',
      rtl: directionFor(prefs.locale) === 'rtl',
    }),
    [prefs, ready, setPrefs, needsRestart, systemReduce, conn],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export const usePrefs = () => useContext(PrefsContext);
