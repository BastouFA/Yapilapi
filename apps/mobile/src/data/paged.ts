import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { flatten } from './cache';

export interface PageShape<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset-paginated list (`{items, nextCursor}`) as an infinite query. */
export function usePaged<T extends { id: string }, P extends PageShape<T> = PageShape<T>>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>,
  opts: { enabled?: boolean; staleTime?: number } = {},
) {
  const q = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
  });
  return { ...q, items: flatten<T>(q.data as never), firstPage: q.data?.pages[0] };
}
