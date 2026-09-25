import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import type { Message, Post } from '@yapilapi/api-client';
import { useAuth } from '../auth/AuthProvider';
import { usePrefs } from '../prefs';
import { qk } from '../data/keys';
import { upsertMessage } from '../data/cache';
import { Outbox, type OutboxItem, type PostDraft } from './outbox';
import { createOutboxRunner } from './handlers';

interface OutboxValue {
  items: readonly OutboxItem[];
  enqueuePost: (draft: PostDraft) => Promise<OutboxItem>;
  sendMessage: (conversationId: string, body: string, replyToId?: string) => Promise<OutboxItem>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  flush: () => Promise<void>;
  /** Fired whenever a queued post is delivered (e.g. to leave the composer). */
  onPostDelivered: (fn: (p: Post) => void) => () => void;
}
const OutboxContext = createContext<OutboxValue | null>(null);

export function OutboxProvider({ children }: { children: React.ReactNode }) {
  const { user, api, onSignOut, status } = useAuth();
  const { lowBandwidth } = usePrefs();
  const qc = useQueryClient();
  const userId = user?.id;
  const username = user?.profile.username;
  const outbox = useMemo(() => (userId ? new Outbox(userId) : null), [userId]);
  const lowRef = useRef(lowBandwidth);
  lowRef.current = lowBandwidth;
  const deliveredListeners = useRef(new Set<(p: Post) => void>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const items = useSyncExternalStore(
    useCallback((cb) => (outbox ? outbox.subscribe(cb) : () => undefined), [outbox]),
    () => outbox?.list() ?? EMPTY,
    () => EMPTY,
  );
  const [, force] = useState(0);

  const flush = useCallback(async () => {
    if (!outbox || !username) return;
    const runner = createOutboxRunner(api, { username, lowBandwidth: () => lowRef.current });
    const res = await outbox.flush(runner);
    for (const { item, result } of res.delivered) {
      if (item.kind === 'message') {
        upsertMessage(qc, item.conversationId, result as Message);
        void qc.invalidateQueries({ queryKey: qk.conversations() });
      } else {
        for (const l of deliveredListeners.current) l(result as Post);
        void qc.invalidateQueries({ queryKey: ['feed'] });
        void qc.invalidateQueries({ queryKey: qk.userPosts(username) });
        void qc.invalidateQueries({ queryKey: qk.profile(username) });
      }
    }
    // Schedule the next attempt for items in backoff.
    if (timer.current) clearTimeout(timer.current);
    const due = outbox.nextDueAt();
    if (due !== null && !res.offline)
      timer.current = setTimeout(
        () => {
          void flush();
          force((n) => n + 1);
        },
        Math.max(1000, due - Date.now()),
      );
  }, [outbox, api, username, qc]);

  useEffect(() => {
    if (!outbox || status !== 'signedIn') return;
    let live = true;
    void outbox.load().then(() => {
      if (live) void flush();
    });
    const net = NetInfo.addEventListener((s) => {
      if (s.isConnected && s.isInternetReachable !== false) void flush();
    });
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flush();
    });
    return () => {
      live = false;
      net();
      app.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [outbox, status, flush]);

  // Unsent drafts belong to the person who wrote them: drop them when that person signs out.
  useEffect(() => (outbox ? onSignOut(() => outbox.clear()) : undefined), [outbox, onSignOut]);

  const enqueuePost = useCallback(
    async (draft: PostDraft) => {
      if (!outbox) throw new Error('not signed in');
      const it = await outbox.enqueue({ kind: 'post', draft });
      void flush();
      return it;
    },
    [outbox, flush],
  );
  const sendMessage = useCallback(
    async (conversationId: string, body: string, replyToId?: string) => {
      if (!outbox) throw new Error('not signed in');
      const it = await outbox.enqueue({ kind: 'message', conversationId, body, replyToId });
      void flush();
      return it;
    },
    [outbox, flush],
  );
  const retry = useCallback(
    async (id: string) => {
      await outbox?.retry(id);
      await flush();
    },
    [outbox, flush],
  );
  const discard = useCallback(
    async (id: string) => {
      await outbox?.remove(id);
    },
    [outbox],
  );
  const onPostDelivered = useCallback((fn: (p: Post) => void) => {
    deliveredListeners.current.add(fn);
    return () => {
      deliveredListeners.current.delete(fn);
    };
  }, []);

  const value = useMemo<OutboxValue>(
    () => ({ items, enqueuePost, sendMessage, retry, discard, flush, onPostDelivered }),
    [items, enqueuePost, sendMessage, retry, discard, flush, onPostDelivered],
  );
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

const EMPTY: readonly OutboxItem[] = [];

export function useOutbox(): OutboxValue {
  const v = useContext(OutboxContext);
  if (!v) throw new Error('useOutbox must be used inside <OutboxProvider>');
  return v;
}
