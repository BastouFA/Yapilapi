import { QueryClient, onlineManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { ApiError } from '@yapilapi/api-client';

/** Retry only what can succeed later: connectivity problems, 429 and 5xx; never a 4xx business error. */
export const shouldRetry = (count: number, e: unknown): boolean =>
  count < 2 && e instanceof ApiError && e.retryable;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 30_000,
        // Kept long so a cached feed can be read offline; the persister decides what reaches the disk.
        gcTime: 24 * 60 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

/** Tell TanStack Query about connectivity: while offline, queries pause and keep showing cached data. */
export function wireOnlineManager(): () => void {
  onlineManager.setEventListener((setOnline) => {
    const unsub = NetInfo.addEventListener((s) =>
      setOnline(Boolean(s.isConnected) && s.isInternetReachable !== false),
    );
    return () => unsub();
  });
  return () => onlineManager.setEventListener(() => () => undefined);
}
