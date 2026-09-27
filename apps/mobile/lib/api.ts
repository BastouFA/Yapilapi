import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { ApiError, createClient } from '../../../packages/api-client/src/index';
import type { Me } from '../../../packages/shared/src/types';
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

/** Mobile uses a Bearer session token kept in the OS keychain (never AsyncStorage). */
export async function client() {
  // On Data saver every request says Save-Data: on, so responses leave out large photo sizes.
  // Requests go through trackedFetch, so a connection that drops shows the offline banner.
  return createClient({ baseUrl, token: await getToken(), headers: dataSaverHeaders, fetch: trackedFetch });
}

/**
 * For signing up and logging in: no token yet, and the API is told the session is for the phone
 * app (it lists it as a phone under "Where you're signed in").
 */
const authClient = () => createClient({ baseUrl, headers: () => ({ ...dataSaverHeaders(), 'x-client-platform': 'mobile' }), fetch: trackedFetch });

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

export async function signOut() {
  (await client()).auth.logout().catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
