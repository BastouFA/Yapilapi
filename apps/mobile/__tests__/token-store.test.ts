import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createMemoryTokenStore, createSecureTokenStore } from '../src/auth/token-store';

describe('token store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
    jest.clearAllMocks();
  });

  it('keeps the session token in expo-secure-store with the keychain accessibility class', async () => {
    const store = createSecureTokenStore();
    await store.set('secret-token');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('yl_session_token', 'secret-token', {
      keychainAccessible: 'AFTER_FIRST_UNLOCK',
    });
    expect(await store.get()).toBe('secret-token');
  });

  it('never writes the token to AsyncStorage', async () => {
    const store = createSecureTokenStore();
    await store.set('secret-token');
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('clear removes it, and a keystore failure reads as "signed out" instead of crashing', async () => {
    const store = createSecureTokenStore();
    await store.set('t');
    await store.clear();
    expect(await store.get()).toBeNull();
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keystore locked'));
    expect(await store.get()).toBeNull();
  });

  it('the in-memory store (web preview and tests) behaves the same way', async () => {
    const m = createMemoryTokenStore('a');
    expect(await m.get()).toBe('a');
    await m.set('b');
    expect(await m.get()).toBe('b');
    await m.clear();
    expect(await m.get()).toBeNull();
  });

  it('no source file outside lib/kv.ts and the query cache persister uses AsyncStorage for anything auth-related', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const users = walk(path.join(__dirname, '../src'))
      .filter((f) => /\.tsx?$/.test(f) && /async-storage/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(__dirname, '../src'), f));
    expect(users.sort()).toEqual(['lib/kv.ts', 'providers.tsx']);
    // and the auth files never import it
    for (const f of ['auth/token-store.ts', 'auth/AuthProvider.tsx'])
      expect(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).not.toMatch(
        /async-storage/,
      );
  });
});
