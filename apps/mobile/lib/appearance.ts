import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

/**
 * Appearance: Light, Dark or Match device (the default). The choice is kept on the phone and set
 * with Appearance.setColorScheme, so every screen's useColorScheme (and so useColors), the status
 * bar and native controls follow it at once, app-wide. "Match device" hands it back to the phone.
 */
export type AppearanceChoice = 'light' | 'dark' | 'system';

const KEY = 'ypl_appearance';
let current: AppearanceChoice = 'system';
const listeners = new Set<() => void>();

function apply(choice: AppearanceChoice) {
  try {
    Appearance.setColorScheme(choice === 'system' ? 'unspecified' : choice);
  } catch {
    // Older platforms without an app-level override: the phone's setting applies.
  }
}

/** Read the saved choice once at start-up and apply it before the first screens draw. */
export async function loadAppearance() {
  const saved = await SecureStore.getItemAsync(KEY).catch(() => null);
  if (saved === 'light' || saved === 'dark') {
    current = saved;
    apply(saved);
    listeners.forEach((l) => l());
  }
}

export async function setAppearance(choice: AppearanceChoice) {
  current = choice;
  apply(choice);
  listeners.forEach((l) => l());
  if (choice === 'system') await SecureStore.deleteItemAsync(KEY).catch(() => {});
  else await SecureStore.setItemAsync(KEY, choice).catch(() => {});
}

/** `const [appearance, setAppearance] = useAppearance()`. */
export function useAppearance(): [AppearanceChoice, (c: AppearanceChoice) => Promise<void>] {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => current,
  );
  return [value, setAppearance];
}
