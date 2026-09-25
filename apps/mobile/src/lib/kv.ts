import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Non-sensitive local persistence (preferences, cached feed, outbox). NEVER put tokens here: they live in
 * expo-secure-store (see auth/token-store.ts). Every call is wrapped: a broken/blocked store must not crash the app.
 */
export const kv = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const v = await AsyncStorage.getItem(key);
      return v === null ? null : (JSON.parse(v) as T);
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable */
    }
  },
  async remove(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  async removeByPrefix(prefix: string): Promise<void> {
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
      if (keys.length) await AsyncStorage.multiRemove(keys);
    } catch {
      /* ignore */
    }
  },
};
