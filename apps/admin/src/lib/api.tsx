'use client';

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createApiClient, type ApiClient } from '@yapilapi/api-client';

const ApiContext = createContext<ApiClient | null>(null);

/** Browser API client: session cookie + CSRF header. A 401 anywhere sends staff to sign in (server-verified session). */
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
          if (here.startsWith('/login')) return;
          router.replace(
            `/login?reason=expired&next=${encodeURIComponent(here + window.location.search)}`,
          );
        },
      }),
    [baseUrl, router],
  );
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

/** Test seam: render a subtree against a fake client without touching the network or Next's router. */
export function ApiTestProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi() requires <ApiProvider>');
  return c;
}

/** Shorthand for the staff console namespace. */
export const useAdminApi = () => useApi().admin;
