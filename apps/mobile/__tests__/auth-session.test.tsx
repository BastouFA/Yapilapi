import React from 'react';
import { Text } from 'react-native';
import { act, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useAuth } from '../src/auth/AuthProvider';
import { createSecureTokenStore } from '../src/auth/token-store';
import { makeFetch, meResponse, renderApp } from './support/harness';

let latest: ReturnType<typeof useAuth>;
const Probe = () => {
  latest = useAuth();
  return <Text>{`status:${latest.status}:${latest.offline ? 'offline' : 'online'}`}</Text>;
};
const secure = () => (SecureStore as unknown as { __store: Map<string, string> }).__store;

describe('session handling', () => {
  beforeEach(async () => {
    secure().clear();
    await AsyncStorage.clear();
  });

  it('restores a stored token, confirms it with /auth/me and reads the profile', async () => {
    secure().set('yl_session_token', 'stored-token');
    const fetch = makeFetch({ 'GET /v1/auth/me': { json: meResponse() } });
    await renderApp(<Probe />, { fetch, tokenStore: createSecureTokenStore() });
    await screen.findByText('status:signedIn:online');
    expect(fetch.calls[0]!.headers['authorization']).toBe('Bearer stored-token');
    expect(latest.user?.profile.username).toBe('ada');
  });

  it('login stores the token in SecureStore only; logout revokes the session, wipes the token and cached profile', async () => {
    const fetch = makeFetch({
      'POST /v1/auth/login': {
        json: {
          mfaRequired: false,
          user: meResponse().user,
          token: 'fresh-token',
          expiresAt: '2030-01-01T00:00:00Z',
        },
      },
      'GET /v1/auth/me': { json: meResponse() },
      'POST /v1/auth/logout': { status: 204 },
      'DELETE /v1/notifications/push-tokens': { status: 204 },
    });
    await renderApp(<Probe />, { fetch, tokenStore: createSecureTokenStore(), signedIn: false });
    await screen.findByText('status:signedOut:online');
    await act(async () => {
      await latest.login('ada@example.com', 'pw-pw-pw-pw-pw');
    });
    await screen.findByText('status:signedIn:online');
    expect(secure().get('yl_session_token')).toBe('fresh-token');
    const stored = JSON.stringify(
      await Promise.all((await AsyncStorage.getAllKeys()).map((k) => AsyncStorage.getItem(k))),
    );
    expect(stored).not.toContain('fresh-token');
    await act(async () => {
      await latest.logout();
    });
    await screen.findByText('status:signedOut:online');
    expect(secure().has('yl_session_token')).toBe(false);
    expect(
      fetch.calls.some(
        (c) => c.path === '/v1/auth/logout' && c.headers['authorization'] === 'Bearer fresh-token',
      ),
    ).toBe(true);
    expect(await AsyncStorage.getItem('yl.me.v1')).toBeNull();
  });

  it('a 401 from any call drops the session locally', async () => {
    secure().set('yl_session_token', 'stale');
    const fetch = makeFetch({
      'GET /v1/auth/me': {
        status: 401,
        json: { error: { code: 'unauthenticated', message: 'nope' } },
      },
    });
    await renderApp(<Probe />, { fetch, tokenStore: createSecureTokenStore() });
    await screen.findByText('status:signedOut:online');
    expect(secure().has('yl_session_token')).toBe(false);
  });

  it('when the server is unreachable at launch the cached profile is used and the app says it is offline', async () => {
    secure().set('yl_session_token', 'tok');
    await AsyncStorage.setItem('yl.me.v1', JSON.stringify(meResponse()));
    const fetch = makeFetch({
      'GET /v1/auth/me': () => {
        throw new TypeError('offline');
      },
    });
    await renderApp(<Probe />, { fetch, tokenStore: createSecureTokenStore() });
    await screen.findByText('status:signedIn:offline');
    expect(secure().get('yl_session_token')).toBe('tok'); // an offline launch must not sign the person out
  });

  it('without a cache and without a server, boot reports an error instead of signing out', async () => {
    secure().set('yl_session_token', 'tok');
    const fetch = makeFetch({
      'GET /v1/auth/me': () => {
        throw new TypeError('offline');
      },
    });
    await renderApp(<Probe />, { fetch, tokenStore: createSecureTokenStore() });
    await waitFor(() => expect(latest.status).toBe('error'));
    expect(secure().get('yl_session_token')).toBe('tok');
  });

  it('registers in bearer mode with acceptTerms, locale and timezone', async () => {
    const fetch = makeFetch({
      'POST /v1/auth/register': {
        status: 201,
        json: { user: meResponse().user, token: 'new-token', expiresAt: '2030-01-01T00:00:00Z' },
      },
      'GET /v1/auth/me': { json: meResponse() },
    });
    await renderApp(<Probe />, {
      fetch,
      tokenStore: createSecureTokenStore(),
      signedIn: false,
      prefs: { locale: 'fr' },
    });
    await screen.findByText('status:signedOut:online');
    await act(async () => {
      await latest.register({
        email: 'a@b.co',
        password: 'longenough-pw',
        username: 'ada',
        displayName: 'Ada',
        birthDate: '2000-05-05',
      });
    });
    const call = fetch.calls.find((c) => c.path === '/v1/auth/register')!;
    expect(call.body).toMatchObject({
      deliver: 'token',
      acceptTerms: true,
      locale: 'fr',
      birthDate: '2000-05-05',
    });
    expect(secure().get('yl_session_token')).toBe('new-token');
  });
});
