import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { ToastProvider, UIProvider } from '@yapilapi/ui';
import type { ApiClient, MeResponse } from '@yapilapi/api-client';
import { PrefsProvider } from '@/lib/prefs';
import { parsePrefs } from '@/lib/prefs-shared';
import { I18nProvider, useT } from '@/i18n';
import { ApiTestProvider } from '@/lib/api';
import { SessionProvider } from '@/lib/session';

/** A fake `ApiClient`: only the namespaces/methods a test supplies exist; anything else throws loudly. */
export function fakeClient(parts: Record<string, Record<string, unknown>>): ApiClient {
  const strict = (name: string, obj: Record<string, unknown> = {}) =>
    new Proxy(obj, {
      get: (t, k) =>
        k in t
          ? t[k as string]
          : typeof k === 'string' && k !== 'then'
            ? () => {
                throw new Error(`unexpected API call: ${name}.${String(k)}`);
              }
            : undefined,
    });
  return new Proxy(
    {},
    {
      get: (_t, k) => strict(String(k), typeof k === 'string' ? parts[k] : undefined),
    },
  ) as unknown as ApiClient;
}

export function fakeMe(overrides: Partial<MeResponse['user']> = {}): MeResponse {
  return {
    user: {
      id: 'u1',
      email: 'ada@example.com',
      emailVerified: true,
      status: 'active',
      platformRole: 'user',
      ageBand: 'adult',
      locale: 'en',
      timezone: 'UTC',
      mfaEnabled: false,
      deletionScheduledFor: null,
      profile: {
        username: 'ada',
        displayName: 'Ada',
        avatarUrl: null,
        mode: 'personal',
        onboardingCompleted: true,
      },
      ...overrides,
    },
    flags: { COMMERCE: true },
  };
}

function Chrome({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <UIProvider Link={({ href, ...rest }) => <a href={href as string} {...rest} />} locale="en">
      <ToastProvider regionLabel={t('toast.region')} dismissLabel={t('toast.dismiss')}>
        {children}
      </ToastProvider>
    </UIProvider>
  );
}

/** Render a creator-studio view against a fake `ApiClient` and session, with the same provider stack the real app mounts. */
export function renderWithProviders(
  ui: ReactElement,
  { client, me = fakeMe() }: { client: ApiClient; me?: MeResponse },
) {
  const initial = parsePrefs(() => undefined, 'en');
  return render(
    <PrefsProvider initial={initial}>
      <I18nProvider>
        <ApiTestProvider client={client}>
          <SessionProvider initial={me}>
            <Chrome>{ui}</Chrome>
          </SessionProvider>
        </ApiTestProvider>
      </I18nProvider>
    </PrefsProvider>,
  );
}
