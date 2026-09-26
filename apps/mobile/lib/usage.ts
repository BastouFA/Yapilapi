import * as SecureStore from 'expo-secure-store';
import { useEffect } from 'react';
import { Alert, AppState } from 'react-native';
import { client } from './api';
import { tr } from './locale';

const SHOWN_KEY = 'ypl_break_day';
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Records active minutes with POST /v1/me/usage/heartbeat once a minute, only while the
 * app is in the foreground (same as the web app, which only counts a visible tab). For a
 * supervised teen past the daily reminder their family set, shows a break prompt once a day.
 */
export function useUsageHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const beat = async () => {
      if (AppState.currentState !== 'active') return;
      try {
        const r = await (await client()).family.heartbeat();
        if (!r.overLimit) return;
        const shown = await SecureStore.getItemAsync(SHOWN_KEY).catch(() => null);
        if (shown === today()) return;
        await SecureStore.setItemAsync(SHOWN_KEY, today()).catch(() => {});
        Alert.alert(tr('m.break.title'), tr('m.break.body', { minutes: r.minutesToday }), [{ text: tr('m.common.close') }]);
      } catch {
        // Offline or signed out: nothing to record.
      }
    };
    const run = () => {
      clearInterval(timer);
      void beat();
      timer = setInterval(beat, 60_000);
    };
    if (AppState.currentState === 'active') run();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') run();
      else clearInterval(timer);
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [enabled]);
}
