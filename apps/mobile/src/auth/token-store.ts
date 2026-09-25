import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'yl_session_token';

/**
 * The session token lives in the platform keystore (iOS Keychain / Android Keystore) through expo-secure-store.
 * It is NEVER written to AsyncStorage or any other plain store. On web (only used for `expo export --platform web`
 * smoke builds and previews) there is no keystore, so the token is kept in memory and the user signs in again after a reload.
 */
export function createSecureTokenStore(): TokenStore {
  if (Platform.OS === 'web') return createMemoryTokenStore();
  return {
    async get() {
      try {
        return await SecureStore.getItemAsync(KEY);
      } catch {
        return null;
      }
    },
    async set(token) {
      await SecureStore.setItemAsync(KEY, token, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    },
    async clear() {
      try {
        await SecureStore.deleteItemAsync(KEY);
      } catch {
        /* already gone */
      }
    },
  };
}

export function createMemoryTokenStore(initial: string | null = null): TokenStore {
  let t = initial;
  return {
    get: async () => t,
    set: async (v) => {
      t = v;
    },
    clear: async () => {
      t = null;
    },
  };
}
