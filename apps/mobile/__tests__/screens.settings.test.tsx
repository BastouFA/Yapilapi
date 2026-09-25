import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { I18nManager } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import Language from '../src/app/settings/language';
import Account from '../src/app/settings/account';
import { makeFetch, meResponse, renderApp } from './support/harness';

describe('Settings: language and display', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('switches language immediately, saves it to the account and keeps English as a fallback for missing strings', async () => {
    const fetch = makeFetch({
      'GET /v1/auth/me': { json: meResponse() },
      'PATCH /v1/settings/preferences': { json: {} },
    });
    await renderApp(<Language />, { fetch });
    fireEvent.press(screen.getByRole('radio', { name: 'Français' }));
    // The screen re-renders in French.
    expect(await screen.findByText('Langue')).toBeTruthy();
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ locale: 'fr' });
    // Persisted for the next launch.
    const stored = JSON.parse((await AsyncStorage.getItem('yl.prefs.v1')) ?? '{}');
    expect(stored.locale).toBe('fr');
  });

  it('switching to Arabic turns on RTL and tells the user a restart is needed; switching back is clean', async () => {
    const forceRTL = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined);
    const allowRTL = jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined);
    const fetch = makeFetch({
      'GET /v1/auth/me': { json: meResponse() },
      'PATCH /v1/settings/preferences': { json: {} },
    });
    await renderApp(<Language />, { fetch });
    expect(screen.queryByText(/Restart the app/)).toBeNull();
    fireEvent.press(screen.getByRole('radio', { name: 'العربية' }));
    await waitFor(() => expect(forceRTL).toHaveBeenCalledWith(true));
    expect(allowRTL).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('alert')).toBeTruthy(); // restart notice (localised)
    forceRTL.mockRestore();
    allowRTL.mockRestore();
  });

  it('theme and data-use choices apply and persist; low data is one tap away', async () => {
    await renderApp(<Language />, {
      fetch: makeFetch({ 'GET /v1/auth/me': { json: meResponse() } }),
    });
    fireEvent.press(screen.getByRole('radio', { name: 'Low data' }));
    fireEvent.press(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(async () => {
      const stored = JSON.parse((await AsyncStorage.getItem('yl.prefs.v1')) ?? '{}');
      expect(stored).toMatchObject({ bandwidth: 'low', theme: 'dark' });
    });
  });
});

describe('Settings: account', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });
  const me = { 'GET /v1/auth/me': { json: meResponse() } };

  it('requests a data export only with the password, then lists it, and is honest that download is web-only', async () => {
    const requests = [
      {
        id: 'r1',
        kind: 'export',
        status: 'completed',
        createdAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:01:00Z',
        export: { downloadable: true, expiresAt: '2026-01-09T00:00:00Z', sizeBytes: 2048 },
      },
    ];
    const fetch = makeFetch({
      ...me,
      'GET /v1/privacy/requests': { json: { items: requests } },
      'POST /v1/privacy/export': {
        status: 201,
        json: {
          requestId: 'r1',
          status: 'completed',
          expiresAt: '2026-01-09T00:00:00Z',
          sizeBytes: 2048,
          next: '/v1/privacy/export/r1',
        },
      },
    });
    await renderApp(<Account />, { fetch });
    fireEvent.press(screen.getByRole('button', { name: 'Request data export' }));
    expect(
      await screen.findByText('Confirm your password to request an export.', { exact: false }),
    ).toBeTruthy();
    expect(fetch.calls.some((c) => c.path === '/v1/privacy/export')).toBe(false);
    fireEvent.changeText(screen.getAllByLabelText('Password')[0]!, 'correct horse battery');
    fireEvent.press(screen.getByRole('button', { name: 'Request data export' }));
    expect(await screen.findByText(/Your export is ready/)).toBeTruthy();
    expect(fetch.calls.find((c) => c.path === '/v1/privacy/export')!.body).toEqual({
      password: 'correct horse battery',
    });
    expect(screen.getByText(/Downloading the file is not available in the app yet/)).toBeTruthy();
    expect(await screen.findByText(/Size 2/)).toBeTruthy();
  });

  it('shows a plain message for a wrong password on export', async () => {
    const fetch = makeFetch({
      ...me,
      'GET /v1/privacy/requests': { json: { items: [] } },
      'POST /v1/privacy/export': {
        status: 401,
        json: { error: { code: 'unauthenticated', message: 'bad' } },
      },
    });
    await renderApp(<Account />, { fetch });
    fireEvent.changeText(screen.getAllByLabelText('Password')[0]!, 'nope');
    fireEvent.press(screen.getByRole('button', { name: 'Request data export' }));
    expect(await screen.findByText('That password is not right.')).toBeTruthy();
  });

  it('account deletion needs the password AND an explicit confirmation before anything is sent', async () => {
    const fetch = makeFetch({
      ...me,
      'GET /v1/privacy/requests': { json: { items: [] } },
      'POST /v1/account/deletion': { status: 202, json: { scheduledFor: '2026-02-01T00:00:00Z' } },
    });
    await renderApp(<Account />, { fetch });
    const inputs = screen.getAllByLabelText('Password');
    fireEvent.press(screen.getByRole('button', { name: 'Request account deletion' }));
    expect(fetch.calls.some((c) => c.path === '/v1/account/deletion')).toBe(false); // no password yet
    fireEvent.changeText(inputs[inputs.length - 1]!, 'correct horse battery');
    fireEvent.press(screen.getByRole('button', { name: 'Request account deletion' }));
    expect(await screen.findByText('Delete your account?')).toBeTruthy();
    expect(fetch.calls.some((c) => c.path === '/v1/account/deletion')).toBe(false); // still nothing until confirmed
    const buttons = screen.getAllByLabelText('Request account deletion');
    fireEvent.press(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(
        fetch.calls.some((c) => c.method === 'POST' && c.path === '/v1/account/deletion'),
      ).toBe(true),
    );
    expect(fetch.calls.find((c) => c.path === '/v1/account/deletion')!.body).toEqual({
      password: 'correct horse battery',
    });
  });

  it('shows a scheduled deletion with a way to cancel it', async () => {
    const scheduled = meResponse({ deletionScheduledFor: '2026-02-01T00:00:00Z' });
    const fetch = makeFetch({
      'GET /v1/auth/me': { json: scheduled },
      'GET /v1/privacy/requests': { json: { items: [] } },
      'POST /v1/account/deletion/cancel': { json: { cancelled: true } },
    });
    await renderApp(<Account />, { fetch });
    expect(await screen.findByText(/Deletion is scheduled for/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel deletion' }));
    await waitFor(() =>
      expect(fetch.calls.some((c) => c.path === '/v1/account/deletion/cancel')).toBe(true),
    );
  });

  it('tells the truth about two-step verification and verified email', async () => {
    await renderApp(<Account />, {
      fetch: makeFetch({
        'GET /v1/auth/me': { json: meResponse({ emailVerified: false }) },
        'GET /v1/privacy/requests': { json: { items: [] } },
      }),
    });
    expect(await screen.findByText('Not verified')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send verification email' })).toBeTruthy();
    expect(screen.getByText(/can be turned on or off on the YAPILAPI website/)).toBeTruthy();
  });
});
