'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Toast } from '@yapilapi/design-system';
import { t as translate, type Me, type MessageKey } from '@yapilapi/shared';
import { api, WS_URL } from '@/lib/api';

type Listener = (event: { type: string; data: any }) => void;

interface Session {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  setMe: (me: Me | null) => void;
  flags: Record<string, boolean>;
  unread: { notifications: number; messages: number };
  setUnread: (u: Partial<{ notifications: number; messages: number }>) => void;
  toast: (message: string) => void;
  subscribe: (fn: Listener) => () => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  locale: string;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside Providers');
  return s;
}

/** Subscribe to realtime events for the lifetime of a component. */
export function useRealtime(fn: Listener) {
  const { subscribe } = useSession();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [unread, setUnreadState] = useState({ notifications: 0, messages: 0 });
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const listeners = useRef(new Set<Listener>());

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.auth.me();
      setMe(user);
      return user;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .flags()
      .then((r) => setFlags(r.flags))
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (me?.locale) {
      document.documentElement.lang = me.locale;
      document.documentElement.dir = ['ar', 'he', 'fa', 'ur'].includes(me.locale.split('-')[0]!) ? 'rtl' : 'ltr';
    }
  }, [me?.locale]);

  // Unread counts, then realtime updates. The socket reconnects with backoff.
  useEffect(() => {
    if (!me) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    const loadCounts = () => {
      api.notifications
        .list()
        .then((r) => setUnreadState((u) => ({ ...u, notifications: r.unread })))
        .catch(() => {});
      api.conversations
        .list()
        .then((r) => setUnreadState((u) => ({ ...u, messages: r.items.reduce((s, c) => s + c.unreadCount, 0) })))
        .catch(() => {});
    };
    loadCounts();
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => (attempt = 0);
      ws.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data);
          if (event.type === 'notification.created') setUnreadState((u) => ({ ...u, notifications: u.notifications + 1 }));
          if (event.type === 'message.created' && event.data.sender.id !== me.id && !location.pathname.startsWith(`/inbox/${event.data.conversationId}`))
            setUnreadState((u) => ({ ...u, messages: u.messages + 1 }));
          listeners.current.forEach((l) => l(event));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        attempt++;
        setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
    };
    connect();
    const onFocus = () => loadCounts();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      ws?.close();
      window.removeEventListener('focus', onFocus);
    };
  }, [me]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  const setUnread = useCallback((u: Partial<{ notifications: number; messages: number }>) => setUnreadState((s) => ({ ...s, ...u })), []);
  const locale = me?.locale ?? 'en';
  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(key, locale, vars), [locale]);

  return (
    <Ctx.Provider value={{ me, loading, refresh, setMe, flags, unread, setUnread, toast: setToastMsg, subscribe, t, locale }}>
      {children}
      <Toast message={toastMsg} onDone={() => setToastMsg(null)} />
    </Ctx.Provider>
  );
}
