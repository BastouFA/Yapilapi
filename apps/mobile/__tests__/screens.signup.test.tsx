import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import Signup from '../src/app/(auth)/signup';
import { makeFetch, meResponse, renderApp } from './support/harness';

const thisYear = new Date().getFullYear();

async function birth(y: number, m = '06', d = '15') {
  fireEvent.changeText(screen.getByLabelText('Day'), d);
  fireEvent.changeText(screen.getByLabelText('Month'), m);
  fireEvent.changeText(screen.getByLabelText('Year'), String(y));
  fireEvent.press(screen.getByRole('button', { name: 'Next' }));
}

async function account(
  email = 'ada@example.com',
  password = 'correct horse battery',
  terms = true,
) {
  fireEvent.changeText(await screen.findByLabelText('Email'), email);
  fireEvent.changeText(screen.getByLabelText('Password'), password);
  if (terms) fireEvent.press(screen.getByRole('checkbox'));
  fireEvent.press(screen.getByRole('button', { name: 'Next' }));
}

describe('Signup screen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('blocks under-13s, never calls the API, and remembers the block', async () => {
    const fetch = makeFetch({});
    const { unmount } = await renderApp(<Signup />, { fetch, signedIn: false });
    await birth(thisYear - 9);
    expect(await screen.findByText('We cannot create an account for you right now.')).toBeTruthy();
    expect(screen.getByText(/at least 13/)).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(fetch.calls).toHaveLength(0);
    unmount();
    // Coming back (or trying again with another date) stays blocked.
    await renderApp(<Signup />, { fetch, signedIn: false });
    expect(await screen.findByText('We cannot create an account for you right now.')).toBeTruthy();
  });

  it('rejects impossible and future dates with a message', async () => {
    await renderApp(<Signup />, { fetch: makeFetch({}), signedIn: false });
    await birth(2000, '02', '31');
    expect(await screen.findByText('Enter a real date, for example 14 / 03 / 2004.')).toBeTruthy();
    await birth(thisYear + 1);
    expect(await screen.findByText('That date is in the future.')).toBeTruthy();
  });

  it('shows the teen protections notice for 13 to 17, but not for adults', async () => {
    await renderApp(<Signup />, { fetch: makeFetch({}), signedIn: false });
    await birth(thisYear - 15);
    expect(await screen.findByText('Extra protections for you')).toBeTruthy();
    screen.unmount();
    await renderApp(<Signup />, { fetch: makeFetch({}), signedIn: false });
    await birth(thisYear - 30);
    await screen.findByLabelText('Email');
    expect(screen.queryByText('Extra protections for you')).toBeNull();
  });

  it('validates the account step: bad email, short password, terms', async () => {
    await renderApp(<Signup />, { fetch: makeFetch({}), signedIn: false });
    await birth(thisYear - 30);
    await account('not-an-email', 'short', false);
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Use at least 10 characters.')).toBeTruthy();
    expect(screen.getByText('You need to accept the terms to continue.')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it('checks the username live and registers an adult in bearer mode with the birth date', async () => {
    const fetch = makeFetch({
      'GET /v1/usernames/*/available': ({ path }) =>
        path.includes('taken_one')
          ? { json: { available: false, reason: 'taken' } }
          : { json: { available: true } },
      'POST /v1/auth/register': {
        json: { user: meResponse().user, token: 'tok_new', expiresAt: '2030-01-01T00:00:00Z' },
      },
      'GET /v1/auth/me': { json: meResponse() },
    });
    await renderApp(<Signup />, { fetch, signedIn: false });
    await birth(1990, '03', '14');
    await account();
    fireEvent.changeText(await screen.findByLabelText('Display name'), 'Ada Obi');
    fireEvent.changeText(screen.getByLabelText('Username'), 'taken_one');
    expect(await screen.findByText('That username is taken.', {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Username'), 'ada_obi');
    expect(await screen.findByText('@ada_obi is available.', {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.path === '/v1/auth/register')).toBe(true));
    const reg = fetch.calls.find((c) => c.path === '/v1/auth/register')!;
    expect(reg.body).toMatchObject({
      email: 'ada@example.com',
      username: 'ada_obi',
      displayName: 'Ada Obi',
      birthDate: '1990-03-14',
      acceptTerms: true,
      deliver: 'token',
    });
    expect(reg.headers['authorization']).toBeUndefined();
  });

  it('turns a server age refusal (unprocessable) into the blocked screen', async () => {
    const fetch = makeFetch({
      'GET /v1/usernames/*/available': { json: { available: true } },
      'POST /v1/auth/register': {
        status: 422,
        json: { error: { code: 'unprocessable', message: 'too young' } },
      },
    });
    await renderApp(<Signup />, { fetch, signedIn: false });
    await birth(thisYear - 15);
    await account();
    fireEvent.changeText(await screen.findByLabelText('Display name'), 'Kid');
    fireEvent.changeText(screen.getByLabelText('Username'), 'kid_one');
    await screen.findByText('@kid_one is available.', {}, { timeout: 3000 });
    fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('We cannot create an account for you right now.')).toBeTruthy();
  });
});
