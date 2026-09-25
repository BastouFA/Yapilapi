'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, ReactionKind } from '@yapilapi/api-client';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useRealtime, useRealtimeEvents } from '@/lib/realtime';
import {
  type ChatItem,
  discardPending,
  failPending,
  makePending,
  markDeleted,
  newClientId,
  prependOlder,
  pruneTyping,
  replaceMessage,
  resolvePending,
  retryPending,
  upsertMessage,
  withReaction,
} from '@/lib/chat-state';

const PAGE = 30;

export interface UseChat {
  items: ChatItem[];
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  loadOlder: () => void;
  reload: () => void;
  send: (body: string, replyTo: { id: string } | null) => void;
  retry: (id: string) => void;
  discard: (id: string) => void;
  react: (message: { id: string }, kind: ReactionKind | null) => Promise<void>;
  remove: (message: { id: string }) => Promise<void>;
  /** Other people currently typing (user ids). */
  typing: string[];
  /** When each other member last read the conversation. */
  reads: Record<string, string>;
  setReads: (r: Record<string, string>) => void;
  startTyping: (typing: boolean) => void;
}

/**
 * Messages of one conversation: initial page, older pages, live updates over the socket, optimistic sends with
 * idempotent retry (`clientMessageId`), optimistic reactions, and catching up after a reconnect.
 */
export function useChat(
  conversationId: string,
  onError: (kind: 'send' | 'react' | 'delete', e: unknown) => void,
): UseChat {
  const api = useApi();
  const { user } = useSession();
  const rt = useRealtime();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [tick, setTick] = useState(0);
  const [typingAt, setTypingAt] = useState<Record<string, number>>({});
  const [reads, setReads] = useState<Record<string, string>>({});
  const errRef = useRef(onError);
  errRef.current = onError;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sender = {
    id: user.id,
    username: user.profile.username,
    displayName: user.profile.displayName,
    avatarUrl: user.profile.avatarUrl,
  };

  const markRead = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (readTimer.current) return;
    readTimer.current = setTimeout(() => {
      readTimer.current = null;
      api.conversations.markRead(conversationId).then(
        () => rt.refreshUnread(),
        () => undefined,
      );
    }, 400);
  }, [api, conversationId, rt]);

  // initial load
  useEffect(() => {
    const ctl = new AbortController();
    setItems([]);
    setCursor(null);
    setLoading(true);
    setError(undefined);
    setTypingAt({});
    api.conversations.messages(conversationId, { limit: PAGE, signal: ctl.signal }).then(
      (page) => {
        if (ctl.signal.aborted) return;
        // Merge rather than replace: the person may already have sent something while the first page was loading.
        setItems((prev) =>
          page.items
            .slice()
            .reverse()
            .reduce((acc, m) => upsertMessage(acc, m, { authoritative: true }), prev),
        );
        setCursor(page.nextCursor);
        setLoading(false);
        markRead();
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) {
          setError(e);
          setLoading(false);
        }
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conversationId, tick]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') markRead();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = null;
    };
  }, [markRead]);

  // typing indicators expire on their own
  useEffect(() => {
    if (Object.keys(typingAt).length === 0) return;
    const id = setInterval(
      () =>
        setTypingAt((t) => {
          const n = pruneTyping(t, Date.now());
          return Object.keys(n).length === Object.keys(t).length ? t : n;
        }),
      2000,
    );
    return () => clearInterval(id);
  }, [typingAt]);

  const catchUp = useCallback(() => {
    api.conversations.messages(conversationId, { limit: PAGE }).then(
      (page) => {
        setItems((prev) =>
          page.items
            .slice()
            .reverse()
            .reduce((acc, m) => upsertMessage(acc, m, { authoritative: true }), prev),
        );
        markRead();
      },
      () => undefined,
    );
  }, [api, conversationId, markRead]);

  useRealtimeEvents((e) => {
    if (e.type === 'rt.reconnected') return catchUp();
    // The server confirmed a (new) subscription: fetch anything sent in the gap between loading and subscribing.
    if (
      e.type === 'subscribed' &&
      (e as { conversationId?: string }).conversationId === conversationId
    )
      return catchUp();
    if ((e as { conversationId?: string }).conversationId !== conversationId) return;
    switch (e.type) {
      case 'message.new': {
        const m = (e as { message: Message }).message;
        setItems((prev) => upsertMessage(prev, m));
        if (m.senderId !== user.id) {
          setTypingAt((t) => {
            if (!m.senderId || !(m.senderId in t)) return t;
            const { [m.senderId]: _drop, ...rest } = t;
            void _drop;
            return rest;
          });
          markRead();
        }
        break;
      }
      case 'message.updated':
        setItems((prev) => upsertMessage(prev, (e as { message: Message }).message));
        break;
      case 'message.deleted':
        setItems((prev) => markDeleted(prev, (e as { messageId: string }).messageId));
        break;
      case 'typing': {
        const { userId, state } = e as { userId: string; state: 'start' | 'stop' };
        setTypingAt((t) => {
          if (state === 'stop') {
            const { [userId]: _d, ...rest } = t;
            void _d;
            return rest;
          }
          return { ...t, [userId]: Date.now() };
        });
        break;
      }
      case 'conversation.read': {
        const { userId, lastReadAt } = e as { userId: string; lastReadAt: string };
        setReads((r) => ({ ...r, [userId]: lastReadAt }));
        break;
      }
    }
  });

  const loadOlder = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api.conversations.messages(conversationId, { cursor, limit: PAGE }).then(
      (page) => {
        setItems((prev) => prependOlder(prev, page.items));
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (e: unknown) => {
        setLoadingMore(false);
        errRef.current('send', e);
      },
    );
  }, [api, conversationId, cursor, loadingMore]);

  const transmit = useCallback(
    async (clientId: string, body: string, replyToId: string | undefined) => {
      try {
        const m = await api.conversations.send(conversationId, {
          body,
          clientMessageId: clientId,
          ...(replyToId ? { replyToId } : {}),
        });
        setItems((prev) => resolvePending(prev, clientId, m));
      } catch (e) {
        setItems((prev) => failPending(prev, clientId));
        errRef.current('send', e);
      }
    },
    [api, conversationId],
  );

  const send = useCallback(
    (body: string, replyTo: { id: string } | null) => {
      const clientId = newClientId();
      const replyMsg = replyTo
        ? (itemsRef.current.find((i) => i.message.id === replyTo.id)?.message ?? null)
        : null;
      setItems((prev) => [
        ...prev,
        makePending({ clientId, body, replyTo: replyMsg, sender, conversationId }),
      ]);
      void transmit(clientId, body, replyTo?.id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transmit, conversationId, user.id],
  );

  const retry = useCallback(
    (id: string) => {
      const it = itemsRef.current.find((i) => i.message.id === id);
      if (!it) return;
      setItems((prev) => retryPending(prev, id));
      void transmit(id, it.message.body, it.message.replyTo?.id);
    },
    [transmit],
  );

  const discard = useCallback((id: string) => setItems((prev) => discardPending(prev, id)), []);

  const react = useCallback(
    async (message: { id: string }, kind: ReactionKind | null) => {
      const before = itemsRef.current.find((i) => i.message.id === message.id)?.message;
      if (!before) return;
      setItems((prev) => replaceMessage(prev, message.id, (m) => withReaction(m, kind)));
      try {
        const updated = kind
          ? await api.messages.react(message.id, kind)
          : await api.messages.unreact(message.id);
        setItems((prev) => upsertMessage(prev, updated, { authoritative: true }));
      } catch (e) {
        setItems((prev) => replaceMessage(prev, message.id, () => before));
        errRef.current('react', e);
      }
    },
    [api],
  );

  const remove = useCallback(
    async (message: { id: string }) => {
      try {
        await api.messages.delete(message.id);
        setItems((prev) => markDeleted(prev, message.id));
      } catch (e) {
        errRef.current('delete', e);
      }
    },
    [api],
  );

  const startTyping = useCallback(
    (on: boolean) => rt.sendTyping(conversationId, on ? 'start' : 'stop'),
    [rt, conversationId],
  );
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const typing = Object.keys(typingAt).filter((id) => id !== user.id);

  return {
    items,
    loading,
    error,
    hasMore: Boolean(cursor),
    loadingMore,
    loadOlder,
    reload,
    send,
    retry,
    discard,
    react,
    remove,
    typing,
    reads,
    setReads,
    startTyping,
  };
}
