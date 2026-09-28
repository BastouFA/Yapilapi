'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DataSaverProvider, Toast, TranslationProvider, type ToastAction, type TranslationContextValue } from '@yapilapi/design-system';
import {
  isRtl,
  t as translate,
  tp as translatePlural,
  type ConnectionHints,
  type DataSaverMode,
  type Me,
  type MessageKey,
  type PluralKey,
} from '@yapilapi/shared';
import { api, WS_URL } from '@/lib/api';
import {
  connectionHints,
  dataSaverActive,
  effectiveMode,
  onConnectionChange,
  readDeviceDataSaver,
  setDataSaverActive,
  startMeasuringData,
  writeDeviceDataSaver,
  type DeviceDataSaver,
} from '@/lib/data-saver';

type Listener = (event: { type: string; data: any }) => void;

export interface Session {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  setMe: (me: Me | null) => void;
  flags: Record<string, boolean>;
  unread: { notifications: number; messages: number };
  setUnread: (u: Partial<{ notifications: number; messages: number }>) => void;
  /** A short message; with an `action` (like "Add to a board") it shows a button and stays longer. */
  toast: (message: string, action?: ToastAction) => void;
  subscribe: (fn: Listener) => () => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Plural-aware: picks `<key>.one` or `<key>.other` for `count`, which is also passed as {count}. */
  tp: (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;
  locale: string;
  dataSaver: DataSaverState;
}

/** Data saver: the account's setting, this browser's override, and whether it is on right now. */
export interface DataSaverState {
  account: DataSaverMode;
  device: DeviceDataSaver;
  /** The mode in use here: the device's choice, or the account's. */
  mode: DataSaverMode;
  active: boolean;
  hints: ConnectionHints;
  setDevice: (v: DeviceDataSaver) => void;
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

// First strong isolate / pop directional isolate. In a right-to-left language, a name or title put
// into a sentence keeps its own direction, so an English name inside Arabic text reads correctly.
const FSI = '\u2068';
const PDI = '\u2069';
function isolate(locale: string, vars?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!vars || !isRtl(locale)) return vars;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = typeof v === 'string' && v ? `${FSI}${v}${PDI}` : v;
  return out;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [unread, setUnreadState] = useState({ notifications: 0, messages: 0 });
  const [toastState, setToastState] = useState<{ id: number; message: string; action?: ToastAction } | null>(null);
  const toastId = useRef(0);
  const toast = useCallback((message: string, action?: ToastAction) => setToastState({ id: ++toastId.current, message, action }), []);
  const clearToast = useCallback(() => setToastState(null), []);
  const listeners = useRef(new Set<Listener>());

  // Data saver: the account's setting (from /v1/auth/me), this browser's override and the connection.
  const [deviceSaver, setDeviceSaver] = useState<DeviceDataSaver>('account');
  const [hints, setHints] = useState<ConnectionHints>({});
  useEffect(() => {
    setDeviceSaver(readDeviceDataSaver());
    setHints(connectionHints());
    startMeasuringData();
    return onConnectionChange(() => setHints(connectionHints()));
  }, []);
  const setDevice = useCallback((v: DeviceDataSaver) => {
    writeDeviceDataSaver(v);
    setDeviceSaver(v);
  }, []);
  const accountSaver: DataSaverMode = me?.dataSaver ?? 'auto';
  const saverMode = effectiveMode(accountSaver, deviceSaver);
  const saverOn = dataSaverActive(saverMode, hints);
  // Set during render so requests made by children in this same render already ask for lite responses.
  setDataSaverActive(saverOn);

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
    const connect = async () => {
      if (stopped) return;
      // The API may be on another host, where the session cookie doesn't reach: open the socket with a short ticket.
      const ticket = await api.realtime.ticket().then(
        (r) => r.ticket,
        () => null,
      );
      if (stopped) return;
      ws = new WebSocket(ticket ? `${WS_URL}?ticket=${encodeURIComponent(ticket)}` : WS_URL);
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
        setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt));
      };
    };
    void connect();
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
  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(key, locale, isolate(locale, vars)), [locale]);
  const tp = useCallback(
    (key: PluralKey, count: number, vars?: Record<string, string | number>) => translatePlural(key, count, locale, isolate(locale, vars)),
    [locale],
  );

  // "See translation": signed in, and while translation is turned on.
  const translationOn = !!me && !!flags.AI_TRANSLATION;
  const translation = useMemo<TranslationContextValue | null>(
    () =>
      translationOn && me
        ? {
            locale,
            languages: me.translation?.languages ?? [],
            auto: !!me.translation?.auto,
            translate: (kind, id, target) => api.translate({ kind, id, target }).then((r) => r.translation),
          }
        : null,
    [translationOn, locale, me],
  );

  return (
    <Ctx.Provider
      value={{
        me,
        loading,
        refresh,
        setMe,
        flags,
        unread,
        setUnread,
        toast,
        subscribe,
        t,
        tp,
        locale,
        dataSaver: { account: accountSaver, device: deviceSaver, mode: saverMode, active: saverOn, hints, setDevice },
      }}
    >
      {/* First thing a keyboard reaches on every page, in the reader's language. */}
      <a href="#main" className="skip-link">
        {t('nav.skipToContent')}
      </a>
      <DataSaverProvider on={saverOn}>
        <TranslationProvider value={translation}>{children}</TranslationProvider>
      </DataSaverProvider>
      <Toast id={toastState?.id} message={toastState?.message ?? null} action={toastState?.action} onDone={clearToast} />
    </Ctx.Provider>
  );
}
