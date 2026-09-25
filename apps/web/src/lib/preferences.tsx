'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { Preferences, PreferencesUpdate } from '@yapilapi/api-client';
import { useApi } from './api';
import { useAsync } from './hooks';
import { usePrefs } from './prefs';
import { isLocale } from '@/i18n/core';

interface Ctx {
  /** The account's saved preferences (undefined while loading). */
  saved: Preferences | undefined;
  loading: boolean;
  error: unknown;
  /** Persist changes to the API and mirror display-related ones locally. */
  update: (patch: PreferencesUpdate) => Promise<void>;
  reload: () => void;
}
const PreferencesContext = createContext<Ctx | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { setPrefs } = usePrefs();
  const state = useAsync((signal) => api.settings.getPreferences({ signal }), [api]);
  const synced = useRef(false);

  // Once per page load, adopt the account's saved display choices (language, theme, motion, data saving).
  useEffect(() => {
    const p = state.data;
    if (!p || synced.current) return;
    synced.current = true;
    setPrefs({
      ...(isLocale(p.locale) ? { locale: p.locale } : {}),
      theme: p.theme,
      motion: p.reducedMotion ? 'reduce' : 'system',
      bandwidth: p.lowBandwidth ? 'low' : 'auto',
    });
  }, [state.data, setPrefs]);

  const { setData } = state;
  const prefsRef = useRef(state.data);
  prefsRef.current = state.data;
  const display = usePrefs().prefs;
  const displayRef = useRef(display);
  displayRef.current = display;

  /** Optimistic: the interface reflects the choice at once and rolls back if the API refuses it. */
  const update = useCallback(
    async (patch: PreferencesUpdate) => {
      const before = prefsRef.current;
      const beforeDisplay = displayRef.current;
      const localPatch = () => ({
        ...(patch.locale && isLocale(patch.locale) ? { locale: patch.locale } : {}),
        ...(patch.theme ? { theme: patch.theme } : {}),
        ...(patch.reducedMotion !== undefined
          ? { motion: patch.reducedMotion ? ('reduce' as const) : ('system' as const) }
          : {}),
        ...(patch.lowBandwidth !== undefined
          ? { bandwidth: patch.lowBandwidth ? ('low' as const) : ('auto' as const) }
          : {}),
      });
      setData((prev) => (prev ? { ...prev, ...patch } : prev));
      setPrefs(localPatch());
      try {
        await api.settings.updatePreferences(patch);
      } catch (e) {
        setData(before);
        setPrefs({
          locale: beforeDisplay.locale,
          theme: beforeDisplay.theme,
          motion: beforeDisplay.motion,
          bandwidth: beforeDisplay.bandwidth,
        });
        throw e;
      }
    },
    [api, setData, setPrefs],
  );

  const value = useMemo<Ctx>(
    () => ({
      saved: state.data,
      loading: state.loading,
      error: state.error,
      update,
      reload: state.reload,
    }),
    [state.data, state.loading, state.error, update, state.reload],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Ctx {
  const c = useContext(PreferencesContext);
  if (!c) throw new Error('usePreferences() requires the app shell');
  return c;
}
