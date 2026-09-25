import React, { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PrefsProvider, type Prefs } from './prefs';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './theme';
import { AuthProvider, useAuth, type AuthProviderProps } from './auth/AuthProvider';
import { OutboxProvider } from './offline/OutboxProvider';
import { RealtimeProvider } from './realtime/RealtimeProvider';
import type { SocketFactory } from './realtime/client';
import { createQueryClient, wireOnlineManager } from './data/client';
import { PERSISTED_DOMAINS } from './data/keys';
import { kv } from './lib/kv';
import { disablePush } from './push';

export interface AppProvidersProps extends Omit<AuthProviderProps, 'children'> {
  children: React.ReactNode;
  /** Tests: skip the on-disk query cache. */
  persist?: boolean;
  queryClient?: QueryClient;
  initialPrefs?: Partial<Prefs>;
  socketFactory?: SocketFactory;
}

const PERSIST_KEY = 'yl.rq.v1';
const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: PERSIST_KEY,
  throttleTime: 2000,
});

/** Wipes everything cached for the signed-in person when they sign out (or the session dies). */
function SignOutCleanup() {
  const { onSignOut, api } = useAuth();
  const qc = useQueryClient();
  useEffect(
    () =>
      onSignOut(async () => {
        await disablePush(api);
        qc.clear();
        await persister.removeClient();
        await kv.removeByPrefix('yl.outbox');
      }),
    [onSignOut, qc, api],
  );
  return null;
}

/** Restores and saves the offline cache for the signed-in person only (the buster is their user id). */
function Persistence({ client }: { client: QueryClient }) {
  const { user } = useAuth();
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const [unsubscribe] = persistQueryClient({
      queryClient: client,
      persister,
      maxAge: 24 * 60 * 60 * 1000,
      // A different account on the same device must never see the previous person's cache.
      buster: userId,
      dehydrateOptions: {
        shouldDehydrateQuery: (q) =>
          q.state.status === 'success' && PERSISTED_DOMAINS.has(String(q.queryKey[0])),
      },
    });
    return unsubscribe;
  }, [client, userId]);
  return null;
}

function DataProviders({
  children,
  persist,
  queryClient,
  socketFactory,
}: Pick<AppProvidersProps, 'children' | 'persist' | 'queryClient' | 'socketFactory'>) {
  const client = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  useEffect(() => wireOnlineManager(), []);
  return (
    <QueryClientProvider client={client}>
      {persist === false ? null : <Persistence client={client} />}
      <SignOutCleanup />
      <OutboxProvider>
        <RealtimeProvider {...(socketFactory ? { socketFactory } : {})}>
          {children}
        </RealtimeProvider>
      </OutboxProvider>
    </QueryClientProvider>
  );
}

export function AppProviders({
  children,
  persist,
  queryClient,
  initialPrefs,
  socketFactory,
  ...auth
}: AppProvidersProps) {
  return (
    <SafeAreaProvider>
      <PrefsProvider {...(initialPrefs ? { initial: initialPrefs } : {})}>
        <I18nProvider>
          <ThemeProvider>
            <AuthProvider {...auth}>
              <DataProviders
                {...(persist !== undefined ? { persist } : {})}
                {...(queryClient ? { queryClient } : {})}
                {...(socketFactory ? { socketFactory } : {})}
              >
                {children}
              </DataProviders>
            </AuthProvider>
          </ThemeProvider>
        </I18nProvider>
      </PrefsProvider>
    </SafeAreaProvider>
  );
}
