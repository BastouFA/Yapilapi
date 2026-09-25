'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLowBandwidth } from '@yapilapi/ui';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (v: T | undefined | ((prev: T | undefined) => T | undefined)) => void;
}

/** Load once (and again when `deps` change). Cancels stale requests. */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef.current(ctl.signal).then(
      (data) => {
        if (!ctl.signal.aborted) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (!ctl.signal.aborted) setState((s) => ({ data: s.data, error, loading: false }));
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setData = useCallback((v: T | undefined | ((prev: T | undefined) => T | undefined)) => {
    setState((s) => ({
      ...s,
      data: typeof v === 'function' ? (v as (p: T | undefined) => T | undefined)(s.data) : v,
    }));
  }, []);
  return { ...state, reload, setData };
}

export interface PageResult<I> {
  items: I[];
  nextCursor: string | null;
}

export interface InfiniteState<I> {
  items: I[];
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  moreError: unknown;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  setItems: (fn: (prev: I[]) => I[]) => void;
}

/**
 * Cursor pagination. Resets when `key` changes; ignores stale responses; never double-fetches the same cursor.
 */
export function useInfinite<I>(
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<PageResult<I>>,
  key: string,
  enabled = true,
): InfiniteState<I> {
  const [items, setItemsState] = useState<I[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined); // undefined = not started, null = exhausted
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const inflight = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    inflight.current?.abort();
    generation.current++;
    setItemsState([]);
    setCursor(undefined);
    setError(undefined);
    setMoreError(undefined);
    setLoadingMore(false);
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    inflight.current = ctl;
    const gen = generation.current;
    setLoading(true);
    fetchRef.current(undefined, ctl.signal).then(
      (page) => {
        if (gen !== generation.current) return;
        setItemsState(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (e: unknown) => {
        if (gen !== generation.current || ctl.signal.aborted) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [key, enabled, tick]);

  const loadMore = useCallback(() => {
    if (!cursor || loading || loadingMore) return;
    const ctl = new AbortController();
    inflight.current = ctl;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(undefined);
    fetchRef.current(cursor, ctl.signal).then(
      (page) => {
        if (gen !== generation.current) return;
        setItemsState((prev) => {
          const idOf = (x: I) => (x as { id?: string }).id;
          const seen = new Set(prev.map(idOf));
          return [
            ...prev,
            ...page.items.filter((x) => idOf(x) === undefined || !seen.has(idOf(x))),
          ];
        });
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (e: unknown) => {
        if (gen !== generation.current || ctl.signal.aborted) return;
        setMoreError(e);
        setLoadingMore(false);
      },
    );
  }, [cursor, loading, loadingMore]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setItems = useCallback((fn: (prev: I[]) => I[]) => setItemsState(fn), []);
  return {
    items,
    loading,
    loadingMore,
    error,
    moreError,
    hasMore: Boolean(cursor),
    loadMore,
    reload,
    setItems,
  };
}

/**
 * Sets document.title (localised by the caller). Client-side metadata refreshes (router.refresh) can momentarily
 * recreate the <title> element empty, so the title is re-applied whenever the head changes and the document has none.
 */
export function usePageTitle(title: string | undefined, suffix: string): void {
  useEffect(() => {
    if (!title) return;
    const full = `${title} · ${suffix}`;
    const apply = () => {
      if (document.title !== full) document.title = full;
    };
    apply();
    const obs = new MutationObserver(() => {
      if (!document.title) apply();
    });
    obs.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [title, suffix]);
}

/** Debounce a value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Prefetching and eager loading are skipped in low-bandwidth mode. Use for `router.prefetch`, `<Link prefetch>` and
 * infinite-scroll auto-loading.
 */
export function useSavesData(): boolean {
  return useLowBandwidth();
}
