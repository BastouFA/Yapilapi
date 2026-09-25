'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RealtimeEvent } from '@yapilapi/api-client';
import { useApi, useApiBaseUrl } from './api';
import { useSession } from './session';
import { backoffMs, wsUrlFrom } from './chat-state';

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';
type Listener = (e: RealtimeEvent) => void;

interface RealtimeCtx {
  status: RealtimeStatus;
  /** Total unread messages across conversations (capped per conversation by the API). */
  unread: number;
  refreshUnread: () => void;
  /** Total unread notifications (from the notifications centre; distinct from message unread). */
  notifUnread: number;
  refreshNotifUnread: () => void;
  /** Receive every frame. Includes a synthetic `rt.reconnected` after the socket comes back (refetch what you show). */
  onEvent: (l: Listener) => () => void;
  /** Ask the server to push a conversation that is not auto-subscribed (community channels). Ref-counted; unsubscribes when released. */
  watch: (conversationId: string) => () => void;
  /**
   * Make sure this socket receives a conversation that was created after it connected. The server only auto-subscribes
   * conversations that existed at connect time (and ones it announces with `conversation.added`), so a brand-new
   * conversation must be subscribed explicitly. Never unsubscribes.
   */
  ensure: (conversationId: string) => void;
  sendTyping: (conversationId: string, state: 'start' | 'stop') => void;
  /** Tell list views that something changed locally (mute, pin, leave) so they refetch. */
  notifyInboxChanged: () => void;
}

const Ctx = createContext<RealtimeCtx | null>(null);

const NO_RECONNECT = new Set([4401, 1008, 1003]);

/**
 * One WebSocket per signed-in tab. The browser never holds a long-lived credential for it: it asks the API for a
 * single-use, 60-second ticket (authenticated by the session cookie) and redeems it in the upgrade request.
 * On loss it reconnects with backoff, then tells listeners to refetch anything they display so nothing is missed.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const base = useApiBaseUrl();
  const { user } = useSession();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [unread, setUnread] = useState(0);
  const [notifUnread, setNotifUnread] = useState(0);
  const listeners = useRef(new Set<Listener>());
  const watched = useRef(new Map<string, number>());
  const ensured = useRef(new Set<string>());
  const socketRef = useRef<WebSocket | null>(null);
  const userId = user.id;

  const inboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshUnread = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      api.conversations.unreadCount().then(
        (r) => setUnread(r.messages),
        () => undefined,
      );
    }, 250);
  }, [api]);

  const notifRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshNotifUnread = useCallback(() => {
    if (notifRefreshTimer.current) return;
    notifRefreshTimer.current = setTimeout(() => {
      notifRefreshTimer.current = null;
      api.notifications.unreadCount().then(
        (r) => setNotifUnread(r.total),
        () => undefined,
      );
    }, 250);
  }, [api]);

  const emit = useCallback((e: RealtimeEvent) => {
    for (const l of [...listeners.current]) {
      try {
        l(e);
      } catch {
        /* one bad listener must not stop the others */
      }
    }
  }, []);

  const send = useCallback((frame: Record<string, unknown>) => {
    const s = socketRef.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(frame));
  }, []);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let hadOpen = false;

    const connect = async () => {
      if (stopped) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setStatus('offline');
        return;
      }
      setStatus(hadOpen ? 'reconnecting' : 'connecting');
      let url: string;
      try {
        const t = await api.realtime.ticket();
        url = wsUrlFrom(base, t.url);
      } catch {
        return schedule();
      }
      if (stopped) return;
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onmessage = (ev) => {
        let frame: RealtimeEvent;
        try {
          frame = JSON.parse(String(ev.data)) as RealtimeEvent;
        } catch {
          return;
        }
        if (frame.type === 'ready') {
          attempt = 0;
          setStatus('open');
          for (const id of new Set([...watched.current.keys(), ...ensured.current]))
            ws.send(JSON.stringify({ type: 'subscribe', conversationId: id }));
          if (hadOpen) emit({ type: 'rt.reconnected' });
          hadOpen = true;
          refreshUnread();
        }
        if (
          frame.type === 'message.new' ||
          frame.type === 'conversation.added' ||
          frame.type === 'conversation.removed' ||
          (frame.type === 'conversation.read' && (frame as { userId?: string }).userId === userId)
        ) {
          refreshUnread();
        }
        // New-conversation and first-message pushes only arrive as a generic notification: tell views to refetch their list.
        if (frame.type === 'notification' && (frame as { kind?: string }).kind === 'message') {
          if (inboxTimer.current) clearTimeout(inboxTimer.current);
          inboxTimer.current = setTimeout(() => {
            inboxTimer.current = null;
            emit({ type: 'rt.inbox-changed' });
            refreshUnread();
          }, 400);
        }
        // Every notification (any kind) updates the notifications-centre badge and tells open lists to refetch.
        if (frame.type === 'notification') {
          refreshNotifUnread();
          emit({ type: 'rt.notification' });
        }
        emit(frame);
      };
      ws.onclose = (ev) => {
        if (socketRef.current === ws) socketRef.current = null;
        if (stopped) return;
        if (NO_RECONNECT.has(ev.code)) {
          setStatus('offline');
          return;
        }
        schedule();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };

    const schedule = () => {
      if (stopped) return;
      setStatus(hadOpen ? 'reconnecting' : 'connecting');
      retry = setTimeout(() => void connect(), backoffMs(attempt++));
    };

    const nudge = () => {
      if (stopped || socketRef.current) return;
      if (retry) clearTimeout(retry);
      attempt = 0;
      void connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') nudge();
    };
    window.addEventListener('online', nudge);
    document.addEventListener('visibilitychange', onVisible);
    void connect();

    // Keep-alive so idle proxies do not drop the connection.
    const ping = setInterval(() => {
      const s = socketRef.current;
      if (s?.readyState === WebSocket.OPEN) s.send('{"type":"ping"}');
    }, 25_000);

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clearInterval(ping);
      window.removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', onVisible);
      const s = socketRef.current;
      socketRef.current = null;
      s?.close(1000, 'navigating away');
    };
  }, [api, base, emit, refreshUnread, refreshNotifUnread, userId]);

  useEffect(() => {
    api.conversations.unreadCount().then(
      (r) => setUnread(r.messages),
      () => undefined,
    );
    api.notifications.unreadCount().then(
      (r) => setNotifUnread(r.total),
      () => undefined,
    );
  }, [api]);

  const onEvent = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => {
      listeners.current.delete(l);
    };
  }, []);

  const watch = useCallback(
    (conversationId: string) => {
      const n = watched.current.get(conversationId) ?? 0;
      watched.current.set(conversationId, n + 1);
      if (n === 0) send({ type: 'subscribe', conversationId });
      return () => {
        const c = (watched.current.get(conversationId) ?? 1) - 1;
        if (c <= 0) {
          watched.current.delete(conversationId);
          send({ type: 'unsubscribe', conversationId });
        } else watched.current.set(conversationId, c);
      };
    },
    [send],
  );

  const ensure = useCallback(
    (conversationId: string) => {
      if (ensured.current.has(conversationId)) return;
      ensured.current.add(conversationId);
      send({ type: 'subscribe', conversationId });
    },
    [send],
  );

  const notifyInboxChanged = useCallback(() => {
    emit({ type: 'rt.inbox-changed' });
    refreshUnread();
  }, [emit, refreshUnread]);

  const sendTyping = useCallback(
    (conversationId: string, state: 'start' | 'stop') =>
      send({ type: 'typing', conversationId, state }),
    [send],
  );

  const value = useMemo<RealtimeCtx>(
    () => ({
      status,
      unread,
      refreshUnread,
      notifUnread,
      refreshNotifUnread,
      onEvent,
      watch,
      ensure,
      sendTyping,
      notifyInboxChanged,
    }),
    [
      status,
      unread,
      refreshUnread,
      notifUnread,
      refreshNotifUnread,
      onEvent,
      watch,
      ensure,
      sendTyping,
      notifyInboxChanged,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRealtime() requires <RealtimeProvider>');
  return c;
}

/** Subscribe to realtime frames for the lifetime of a component. The handler may change every render. */
export function useRealtimeEvents(handler: Listener): void {
  const { onEvent } = useRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onEvent((e) => ref.current(e)), [onEvent]);
}
