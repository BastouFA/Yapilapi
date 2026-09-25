'use client';

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createApiClient, type ApiClient } from '@yapilapi/api-client';

const ApiContext = createContext<ApiClient | null>(null);
const ApiUrlContext = createContext<string>('');

const PUBLIC_PREFIXES = [
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
];

/** Browser API client: session cookie + CSRF header. A 401 anywhere sends the user to sign in (server-verified session). */
export function ApiProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const client = useMemo(
    () =>
      createApiClient({
        baseUrl,
        mode: 'cookie',
        onUnauthorized: () => {
          const here = pathRef.current;
          if (PUBLIC_PREFIXES.some((p) => here.startsWith(p))) return;
          router.replace(`/login?next=${encodeURIComponent(here + window.location.search)}`);
        },
      }),
    [baseUrl, router],
  );
  return (
    <ApiUrlContext.Provider value={baseUrl}>
      <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
    </ApiUrlContext.Provider>
  );
}

export function useApi(): ApiClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi() requires <ApiProvider>');
  return c;
}

/** Public API origin (used to derive the WebSocket URL). */
export function useApiBaseUrl(): string {
  return useContext(ApiUrlContext);
}

/** Test-only: render children against a caller-supplied fake `ApiClient` instead of a real one. */
export function ApiTestProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}
