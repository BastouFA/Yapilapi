import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import Login from '../src/app/(auth)/login';
import { makeFetch, meResponse, renderApp, router } from './support/harness';

const creds = { email: 'ada@example.com', password: 'correct horse battery' };

async function fill() {
  fireEvent.changeText(screen.getByLabelText('Email'), creds.email);
  fireEvent.changeText(screen.getByLabelText('Password'), creds.password);
}

describe('Login screen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('validates empty fields with accessible messages and does not call the API', async () => {
    const fetch = makeFetch({});
    await renderApp(<Login />, { fetch, signedIn: false });
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(fetch.calls.some((c) => c.path === '/v1/auth/login')).toBe(false);
  });

  it('signs in in bearer mode (deliver:token) and stores the token securely', async () => {
    const fetch = makeFetch({
      'POST /v1/auth/login': {
        json: {
          mfaRequired: false,
          user: meResponse().user,
          token: 'tok_123',
          expiresAt: '2030-01-01T00:00:00Z',
        },
      },
      'GET /v1/auth/me': { json: meResponse() },
    });
    await renderApp(<Login />, { fetch, signedIn: false });
    await fill();
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(
        fetch.calls.some(
          (c) => c.path === '/v1/auth/me' && c.headers['authorization'] === 'Bearer tok_123',
        ),
      ).toBe(true),
    );
    const login = fetch.calls.find((c) => c.path === '/v1/auth/login')!;
    expect(login.body).toMatchObject({ email: creds.email, deliver: 'token' });
    expect(login.headers['authorization']).toBeUndefined();
  });

  it('moves to the MFA screen when the API asks for a second factor', async () => {
    const fetch = makeFetch({
      'POST /v1/auth/login': { json: { mfaRequired: true, challengeToken: 'challenge-token-xyz' } },
    });
    await renderApp(<Login />, { fetch, signedIn: false });
    await fill();
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router().push).toHaveBeenCalledWith('/mfa'));
  });

  it('shows a plain message for wrong credentials', async () => {
    const fetch = makeFetch({
      'POST /v1/auth/login': {
        status: 401,
        json: { error: { code: 'unauthenticated', message: 'Invalid credentials' } },
      },
    });
    await renderApp(<Login />, { fetch, signedIn: false });
    await fill();
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The email or password is not right.')).toBeTruthy();
  });

  it('shows the offline message when the server cannot be reached', async () => {
    const fetch = makeFetch({
      'POST /v1/auth/login': () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderApp(<Login />, { fetch, signedIn: false });
    await fill();
    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Could not reach the server. Check your connection.'),
    ).toBeTruthy();
  });
});
