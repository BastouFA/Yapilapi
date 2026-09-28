import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { ApiError, createClient } from '../../../packages/api-client/src/index';
import type { Me } from '../../../packages/shared/src/types';
import { MAX_DEVICE_ACCOUNTS, parseDeviceAccounts, upsertDeviceAccount, withoutDeviceAccount, type DeviceAccount } from '../../../packages/shared/src/accounts';
import { dataSaverHeaders } from './data-saver-state';
import { tr } from './locale';
import { setProbeUrl, trackedFetch } from './network';

const TOKEN_KEY = 'ypl_session';
export const baseUrl = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';
/** The web app, for links people share (a reel opens at `${webUrl}/reels?start=<id>`). */
export const webUrl = ((Constants.expoConfig?.extra?.webUrl as string | undefined) ?? 'http://localhost:3000').replace(/\/+$/, '');

export const getToken = async () => (await SecureStore.getItemAsync(TOKEN_KEY)) ?? undefined;

// The offline banner checks this light endpoint to notice the connection is back.
setProbeUrl(`${baseUrl}/health/live`);

/**
 * Every request says which phone it comes from (`ios` or `android`): the API lists the session as a
 * phone under "Where you're signed in", and applies the app store rules for digital goods
 * (docs/operations/in-app-purchases.md).
 */
const platformHeaders = (): Record<string, string> => ({
  ...dataSaverHeaders(),
  'x-client-platform': Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'mobile',
});

/** Mobile uses a Bearer session token kept in the OS keychain (never AsyncStorage). */
export async function client() {
  // On Data saver every request says Save-Data: on, so responses leave out large photo sizes.
  // Requests go through trackedFetch, so a connection that drops shows the offline banner.
  return createClient({ baseUrl, token: await getToken(), headers: platformHeaders, fetch: trackedFetch });
}

/** For signing up and logging in: no token yet. */
const authClient = () => createClient({ baseUrl, headers: platformHeaders, fetch: trackedFetch });

/** The realtime socket URL (same endpoint as the web app). The token goes in a header, not the URL. */
export const realtimeUrl = () => `${baseUrl.replace(/^http/, 'ws')}/v1/realtime`;

/** Media URLs from the API may be relative to the API origin. */
export const mediaUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`);

/**
 * Messages from the API are shown as they come (in English today); ours are translated. Not
 * reaching the API at all gets the translated "check your connection" message.
 */
export const errorMessage = (e: unknown) =>
  e instanceof ApiError && e.code === 'network' ? tr('error.network') : e instanceof Error && e.message ? e.message : tr('error.generic');

export type SignInResult = { user: Me } | { challengeToken: string };

/** Log in with email and password. Accounts with two-step verification get a challenge to answer with verifyTwoStep. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const r = await authClient().auth.login({ email, password });
  if (r.mfaRequired && r.challengeToken) return { challengeToken: r.challengeToken };
  if (!r.token || !r.user) throw new Error(tr('m.auth.failed'));
  await SecureStore.setItemAsync(TOKEN_KEY, r.token);
  return { user: r.user };
}

/** The second step: a code from an authenticator app, or a recovery code. */
export async function verifyTwoStep(challengeToken: string, code: string): Promise<Me> {
  const r = await authClient().mfa.verify(challengeToken, code.replace(/\s+/g, ''));
  await SecureStore.setItemAsync(TOKEN_KEY, r.token);
  return r.user;
}

export type RegisterInput = Parameters<ReturnType<typeof createClient>['auth']['register']>[0];

/** Create an account; the new session is kept like a login's. */
export async function register(input: RegisterInput): Promise<Me> {
  const r = await authClient().auth.register(input);
  await SecureStore.setItemAsync(TOKEN_KEY, r.token);
  return r.user;
}

/** Ask for a password reset email. The answer is the same whether or not the email has an account. */
export async function forgotPassword(email: string) {
  await authClient().auth.forgot(email);
}

/** Whether a username is free, or null when that can't be checked right now. */
export async function usernameAvailable(username: string): Promise<boolean | null> {
  try {
    return (await authClient().auth.checkUsername(username)).available;
  } catch {
    return null;
  }
}

/**
 * For changing your username: whether this one can be yours, and why not (taken, reserved, not
 * following the rules, already yours). Null when that can't be checked right now.
 */
export async function checkNewUsername(username: string) {
  try {
    return await (await client()).auth.checkUsername(username, 'change');
  } catch {
    return null;
  }
}

/** Ends this session on the API (when reachable) and forgets its token on the phone. */
export async function signOut() {
  await (
    await client()
  ).auth
    .logout()
    .then(() => {})
    .catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ── Accounts on this phone ──────────────────────────────────────────────
// Up to MAX_ACCOUNTS signed-in accounts. Each keeps its own session token in the keychain
// (`ypl_session_<id>`); the one in use is also under TOKEN_KEY, which every request reads. The
// list itself (names and photos, no tokens) is in `ypl_accounts`.

// The list's rules (what's kept, who leaves past the limit, who takes over) are in
// packages/shared/src/accounts.ts, where they are unit tested.
export const MAX_ACCOUNTS = MAX_DEVICE_ACCOUNTS;
const ACCOUNTS_KEY = 'ypl_accounts';
const tokenKey = (id: string) => `ypl_session_${id}`;

export type StoredAccount = DeviceAccount;

export async function storedAccounts(): Promise<StoredAccount[]> {
  try {
    return parseDeviceAccounts(await SecureStore.getItemAsync(ACCOUNTS_KEY), MAX_ACCOUNTS);
  } catch {
    return [];
  }
}

async function saveAccounts(list: StoredAccount[]) {
  await SecureStore.setItemAsync(ACCOUNTS_KEY, JSON.stringify(list.slice(0, MAX_ACCOUNTS)));
}

/** The account in use joins the list (or its name and photo are updated), with its own copy of the token. */
export async function rememberAccount(me: Me): Promise<StoredAccount[]> {
  const token = await getToken();
  const list = await storedAccounts();
  if (!token) return list;
  await SecureStore.setItemAsync(tokenKey(me.id), token);
  const entry: StoredAccount = { id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl ?? null };
  // A new account past the limit (made from the add-account screens): the oldest other one leaves this phone.
  const { list: next, evicted } = upsertDeviceAccount(list, entry, MAX_ACCOUNTS);
  for (const id of evicted) await SecureStore.deleteItemAsync(tokenKey(id)).catch(() => {});
  await saveAccounts(next);
  return next;
}

/** Makes a saved account the one in use (its token under TOKEN_KEY). False when its token is gone. */
export async function activateAccount(id: string): Promise<boolean> {
  const token = await SecureStore.getItemAsync(tokenKey(id));
  if (!token) return false;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return true;
}

/** Removes an account from this phone: its token and its place in the list. */
export async function forgetAccount(id: string): Promise<StoredAccount[]> {
  await SecureStore.deleteItemAsync(tokenKey(id)).catch(() => {});
  const next = withoutDeviceAccount(await storedAccounts(), id);
  await saveAccounts(next);
  return next;
}

/** The saved account whose token this is (when the session in use has ended, to forget the right one). */
export async function accountWithToken(token: string): Promise<string | null> {
  for (const a of await storedAccounts()) if ((await SecureStore.getItemAsync(tokenKey(a.id))) === token) return a.id;
  return null;
}

/** Logs out an account that isn't the one in use (its session ends on the API too). */
export async function signOutStoredAccount(id: string) {
  const token = await SecureStore.getItemAsync(tokenKey(id));
  if (token)
    await createClient({ baseUrl, token, fetch: trackedFetch })
      .auth.logout()
      .then(() => {})
      .catch(() => {});
  return forgetAccount(id);
}

/** The token in use, to put back if switching to another account fails. */
export const restoreToken = async (token: string | undefined) => (token ? SecureStore.setItemAsync(TOKEN_KEY, token) : SecureStore.deleteItemAsync(TOKEN_KEY));
