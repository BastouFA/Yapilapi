import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createClient } from '../../../packages/api-client/src/index';
import { tr } from './locale';

const TOKEN_KEY = 'ypl_session';
export const baseUrl = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';
/** The web app, for links people share (a reel opens at `${webUrl}/reels?start=<id>`). */
export const webUrl = ((Constants.expoConfig?.extra?.webUrl as string | undefined) ?? 'http://localhost:3000').replace(/\/+$/, '');

export const getToken = async () => (await SecureStore.getItemAsync(TOKEN_KEY)) ?? undefined;

/** Mobile uses a Bearer session token kept in the OS keychain (never AsyncStorage). */
export async function client() {
  return createClient({ baseUrl, token: await getToken() });
}

/** The realtime socket URL (same endpoint as the web app). The token goes in a header, not the URL. */
export const realtimeUrl = () => `${baseUrl.replace(/^http/, 'ws')}/v1/realtime`;

/** Media URLs from the API may be relative to the API origin. */
export const mediaUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`);

/** Messages from the API are shown as they come (in English today); ours are translated. */
export const errorMessage = (e: unknown) => (e instanceof Error && e.message ? e.message : tr('error.generic'));

export async function signIn(email: string, password: string) {
  const res = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-platform': 'mobile' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? tr('m.auth.failed'));
  if (!json.token) throw new Error(tr('m.auth.twoStep'));
  await SecureStore.setItemAsync(TOKEN_KEY, json.token);
  return json.user;
}

export async function signOut() {
  (await client()).auth.logout().catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
