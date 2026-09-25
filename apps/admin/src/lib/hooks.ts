'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '@yapilapi/api-client';

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Load something on mount and whenever `deps` change; the previous request is aborted. Keeps stale data while reloading. */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined }));
    loadRef.current(ctl.signal).then(
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
  return { ...state, reload };
}

export interface PagedList<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/** Keyset-paginated list: first page on mount / when `deps` change, `loadMore` appends the next page. */
export function usePagedList<T>(
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  deps: readonly unknown[],
): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const ctlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setLoading(true);
    setError(undefined);
    fetchRef.current(undefined, ctl.signal).then(
      (p) => {
        if (!ctl.signal.aborted) {
          setItems(p.items);
          setNext(p.nextCursor);
          setLoading(false);
        }
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) {
          setError(e);
          setItems([]);
          setNext(null);
          setLoading(false);
        }
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore) return;
    const ctl = ctlRef.current ?? new AbortController();
    setLoadingMore(true);
    fetchRef
      .current(next, ctl.signal)
      .then(
        (p) => {
          if (!ctl.signal.aborted) {
            setItems((prev) => [...prev, ...p.items]);
            setNext(p.nextCursor);
          }
        },
        (e: unknown) => {
          if (!ctl.signal.aborted) setError(e);
        },
      )
      .finally(() => setLoadingMore(false));
  }, [next, loadingMore]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { items, loading, loadingMore, error, hasMore: next !== null, loadMore, reload };
}

/** Debounce a fast-changing value (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Set the document title (App Router `metadata` cannot be dynamic inside client components). */
export function usePageTitle(title: string, suffix: string): void {
  useEffect(() => {
    document.title = `${title} · ${suffix}`;
  }, [title, suffix]);
}
