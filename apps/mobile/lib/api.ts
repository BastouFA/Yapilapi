import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createClient } from '../../../packages/api-client/src/index';

const TOKEN_KEY = 'ypl_session';
const baseUrl = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';

/** Mobile uses a Bearer session token kept in the OS keychain (never AsyncStorage). */
export async function client() {
  const token = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? undefined;
  return createClient({ baseUrl, token });
}

export async function signIn(email: string, password: string) {
  const res = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-platform': 'mobile' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? 'Sign-in failed');
  await SecureStore.setItemAsync(TOKEN_KEY, json.token);
  return json.user;
}

export async function signOut() {
  (await client()).auth.logout().catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
