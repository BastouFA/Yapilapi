'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DataSaverProvider, Toast, TranslationProvider, type ToastAction, type TranslationContextValue } from '@yapilapi/design-system';
import {
  isRtl,
  loadLocale,
  localeReady,
  t as translate,
  tp as translatePlural,
  type ConnectionHints,
  type DataSaverMode,
  type Me,
  type MessageKey,
  type PluralKey,
} from '@yapilapi/shared';
import { ApiError } from '@yapilapi/api-client';
import { api, errorMessage, sharedRequest, WS_URL } from '@/lib/api';
import { ServerWake } from '@/components/ServerWake';
import { revealLocale, startLocale, visitorLocale, writeLocaleChoice, writeLocaleHint } from '@/lib/locale-script';
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

type RealtimeEvent = { type: string; data: any };
type Listener = (event: RealtimeEvent) => void;

export interface VoiceOffers {
  transcripts: boolean;
  translation: boolean;
  listen: boolean;
}

export interface Session {
  me: Me | null;
  /** True until the account (or that nobody is signed in) and its language are both here. */
  loading: boolean;
  /** Why the account couldn't be checked (the API didn't answer), as opposed to being signed out. */
  sessionError: string | null;
  refresh: () => Promise<Me | null>;
  setMe: (me: Me | null) => void;
  flags: Record<string, boolean>;
  /** What voice messages offer here now (GET /v1/flags): their transcript, its translation, and "Listen in …". */
  voice: VoiceOffers;
  /** Load the feature flags again (after an admin changes one; also when the tab comes back to the front). */
  refreshFlags: () => Promise<void>;
  unread: { notifications: number; messages: number };
  setUnread: (u: Partial<{ notifications: number; messages: number }>) => void;
  /** A short message; with an `action` (like "Add to a board") it shows a button and stays longer. */
  toast: (message: string, action?: ToastAction) => void;
  subscribe: (fn: Listener) => () => void;
  /** Send a small frame on the realtime socket (like "typing"); dropped when it isn't open. */
  sendRealtime: (frame: { type: string; conversationId?: string }) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Plural-aware: picks the form of `key` for `count` (`.one`, `.other`, or Arabic's `.two`, `.few`…), and passes {count}. */
  tp: (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;
  locale: string;
  /** Without an account: show the site in this language, and remember it on this browser. */
  chooseLocale: (locale: string) => Promise<void>;
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

// Only English comes with the page; other languages are fetched on demand (packages/shared/src/i18n-core.ts).
// The language the page starts in (a returning reader's, or a visitor's) starts downloading as the
// page's code runs, alongside the account.
if (typeof window !== 'undefined') void loadLocale(startLocale());

export function Providers({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  // Automatic translation works on the server now (both flags on, and a real model).
  const [autoTranslation, setAutoTranslation] = useState(false);
  // Whether the server can translate at all (older servers don't say: assume it can).
  const [translationWorks, setTranslationWorks] = useState(true);
  const [voice, setVoice] = useState<VoiceOffers>({ transcripts: false, translation: false, listen: false });
  const [unread, setUnreadState] = useState({ notifications: 0, messages: 0 });
  const unreadAnswers = useRef(0);
  const setUnread = useCallback((u: Partial<{ notifications: number; messages: number }>) => {
    if (u.messages !== undefined) unreadAnswers.current++;
    setUnreadState((s) => ({ ...s, ...u }));
  }, []);
  const [toastState, setToastState] = useState<{ id: number; message: string; action?: ToastAction } | null>(null);
  const toastId = useRef(0);
  const toast = useCallback((message: string, action?: ToastAction) => setToastState({ id: ++toastId.current, message, action }), []);
  const clearToast = useCallback(() => setToastState(null), []);
  const listeners = useRef(new Set<Listener>());
  const socket = useRef<WebSocket | null>(null);

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
      // The account arrives with its language ready, so nothing shows in English first and a
      // language just chosen in Settings switches in one step.
      await loadLocale(user.locale);
      setMe(user);
      setSessionError(null);
      return user;
    } catch (e) {
      // Only the API saying so signs you out here; a dropped connection or a restart keeps the
      // account already showing, and before one has loaded the app says why with Try again.
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setSessionError(null);
      } else setSessionError(errorMessage(e));
      return null;
    } finally {
      setMeLoading(false);
    }
  }, []);

  // The language on screen: the account's once it is here. Before that, the one the page started in
  // (lib/locale-script.ts), and without an account the visitor's: chosen here, else the browser's.
  // Both are read after hydration, so the first render matches the server's English page (which
  // stays hidden until its language is ready, when it isn't English).
  const [start, setStart] = useState<string | null>(null);
  const [visitor, setVisitor] = useState('en');
  useLayoutEffect(() => {
    setStart(startLocale());
    setVisitor(visitorLocale());
  }, []);
  const chooseLocale = useCallback(async (code: string) => {
    writeLocaleChoice(code);
    // Switches once the language is here, so nothing shows in English on the way.
    await loadLocale(code);
    setVisitor(code);
  }, []);

  // The reader's language, when it isn't loaded yet (signing in, switching accounts): the app waits
  // for it as it waits for the account. A catalog that can't be fetched leaves the text in English.
  const locale = me?.locale ?? (meLoading ? (start ?? 'en') : visitor);
  const [fetched, setFetched] = useState<string | null>(null);
  const ready = localeReady(locale) || fetched === locale;
  useEffect(() => {
    if (localeReady(locale)) return;
    let live = true;
    void loadLocale(locale).then(() => live && setFetched(locale));
    return () => {
      live = false;
    };
  }, [locale]);
  const loading = meLoading || !ready;

  const refreshFlags = useCallback(
    () =>
      api
        .flags()
        .then((r) => {
          setFlags(r.flags);
          setAutoTranslation(!!r.autoTranslation);
          setTranslationWorks(r.translation ?? true);
          setVoice({ transcripts: !!r.voiceTranscripts, translation: !!r.voiceTranslation, listen: !!r.voiceListen });
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
    void refreshFlags();
  }, [refresh, refreshFlags]);
  // A feature an admin turned on or off reaches open tabs when they come back to the front.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshFlags();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshFlags]);

  // <html lang> and dir follow the language on screen, before the browser paints it (so Arabic never
  // shows left to right first), and this browser remembers a signed-in reader's for the next page
  // load (lib/locale-script.ts). Signed out, pages follow the visitor's language.
  const signedIn = !!me;
  useLayoutEffect(() => {
    if (loading) return;
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtl(locale) ? 'rtl' : 'ltr';
    writeLocaleHint(signedIn ? locale : null);
  }, [loading, locale, signedIn]);
  // The page's first language is ready and rendered: show the page (hidden until then when it isn't English).
  useLayoutEffect(() => {
    if (start !== null && ready) revealLocale();
  }, [start, ready]);

  // Unread counts, then realtime updates. The socket reconnects with backoff, and at once when the
  // page comes back (a phone's home-screen app woken from the background, the network back): a
  // socket the phone froze can look open but be dead, so after a while away it's replaced. Each new
  // socket says `ready`, and the open pages fetch what came in meanwhile (the same messages on every device).
  useEffect(() => {
    if (!me) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    // Only the newest connect() opens a socket (one may still be waiting for its ticket).
    let generation = 0;
    // Whether this page is on screen: in the background, new messages come as notifications.
    const sayPresence = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', onScreen: document.visibilityState === 'visible' }));
    };
    // Shared with the inbox and notifications pages, which ask for the same lists as they open.
    const loadCounts = () => {
      sharedRequest('notifications', () => api.notifications.list())
        .then((r) => setUnreadState((u) => ({ ...u, notifications: r.unread })))
        .catch(() => {});
      // Set aside if the server said a newer count meanwhile: this list may be from before a chat was read.
      const asked = unreadAnswers.current;
      sharedRequest('conversations', () => api.conversations.list())
        .then((r) => {
          if (asked === unreadAnswers.current) setUnreadState((u) => ({ ...u, messages: r.items.reduce((s, c) => s + c.unreadCount, 0) }));
        })
        .catch(() => {});
    };
    loadCounts();
    const connect = async () => {
      if (stopped) return;
      const gen = ++generation;
      // The API may be on another host, where the session cookie doesn't reach: open the socket with a short ticket.
      const ticket = await api.realtime.ticket().then(
        (r) => r.ticket,
        () => null,
      );
      if (stopped || gen !== generation) return;
      const sock = new WebSocket(ticket ? `${WS_URL}?ticket=${encodeURIComponent(ticket)}` : WS_URL);
      ws = sock;
      socket.current = sock;
      // A ping now and then keeps proxies from closing a quiet socket.
      // No pong for two pings: the connection is gone without saying so; start a new one.
      let ping: ReturnType<typeof setInterval> | undefined;
      let heard = Date.now();
      sock.onopen = () => {
        attempt = 0;
        heard = Date.now();
        sayPresence();
        ping = setInterval(() => {
          if (sock.readyState !== WebSocket.OPEN) return;
          if (Date.now() - heard > 60_000) return sock.close();
          sock.send(JSON.stringify({ type: 'ping' }));
        }, 25_000);
      };
      sock.onmessage = (ev) => {
        heard = Date.now();
        let event: RealtimeEvent;
        try {
          event = JSON.parse(ev.data);
        } catch {
          return; // a malformed frame
        }
        if (event.type === 'pong') return;
        // A like joining an unread "Ada and 2 others" row isn't one more unread.
        if (event.type === 'notification.created' && !event.data?.grouped) setUnreadState((u) => ({ ...u, notifications: u.notifications + 1 }));
        // The same as the server counts: messages from others, and calls you missed (not the other lines in a chat).
        const counts = event.data?.kind !== 'system' || (event.data.system?.type === 'call' && event.data.system.outcome === 'missed');
        // In the open chat it counts only while the page is out of sight: there, nobody has read it yet.
        const onScreen = location.pathname.startsWith(`/inbox/${event.data?.conversationId}`) && document.visibilityState === 'visible';
        if (event.type === 'message.created' && counts && event.data.sender.id !== me.id && !onScreen)
          setUnreadState((u) => ({ ...u, messages: u.messages + 1 }));
        // A chat was read, on this device or another: the server's own count.
        if (event.type === 'messages.unread') setUnread({ messages: event.data.count, notifications: event.data.notifications });
        // One page's handler failing doesn't keep the event from the others.
        listeners.current.forEach((l) => {
          try {
            l(event);
          } catch (e) {
            console.error(e);
          }
        });
      };
      sock.onclose = () => {
        clearInterval(ping);
        if (socket.current === sock) socket.current = null;
        // A socket replaced on purpose (the page came back) doesn't schedule another.
        if (stopped || ws !== sock) return;
        attempt++;
        clearTimeout(retry);
        retry = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt));
      };
    };
    void connect();
    const reconnectNow = () => {
      clearTimeout(retry);
      attempt = 0;
      const old = ws;
      ws = null;
      if (old && old.readyState !== WebSocket.CLOSED) old.close();
      if (socket.current === old) socket.current = null;
      void connect();
    };
    const back = () => {
      loadCounts();
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (!ws || ws.readyState !== WebSocket.OPEN || away > 15_000) reconnectNow();
    };
    const onVisibility = () => {
      sayPresence();
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else back();
    };
    const onFocus = () => loadCounts();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', reconnectNow);
    window.addEventListener('pageshow', back);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('pageshow', back);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [me]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  const sendRealtime = useCallback((frame: { type: string; conversationId?: string }) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(key, locale, isolate(locale, vars)), [locale]);
  const tp = useCallback(
    (key: PluralKey, count: number, vars?: Record<string, string | number>) => translatePlural(key, count, locale, isolate(locale, vars)),
    [locale],
  );

  // "See translation": signed in, while translation is turned on and the server has a model to
  // translate with (else every tap would end in "couldn't be translated"). Automatic translation (and
  // translated caption tracks) when the server can, and the reader hasn't turned it off.
  const translationOn = !!me && !!flags.AI_TRANSLATION && translationWorks;
  const translation = useMemo<TranslationContextValue | null>(
    () =>
      translationOn && me
        ? {
            locale,
            languages: me.translation?.languages ?? [],
            auto: autoTranslation && (me.translation?.auto ?? false),
            translate: (kind, id, target) => api.translate({ kind, id, target }).then((r) => r.translation),
            translateMany: (items, target) => api.translations({ target, items }),
            captionUrl: autoTranslation ? (mediaId, lang, target) => api.studio.translatedCaptionUrl(mediaId, lang, target) : undefined,
          }
        : null,
    [translationOn, autoTranslation, locale, me],
  );

  return (
    <Ctx.Provider
      value={{
        me,
        loading,
        sessionError,
        refresh,
        setMe,
        flags,
        voice,
        refreshFlags,
        unread,
        setUnread,
        toast,
        subscribe,
        sendRealtime,
        t,
        tp,
        locale,
        chooseLocale,
        dataSaver: { account: accountSaver, device: deviceSaver, mode: saverMode, active: saverOn, hints, setDevice },
      }}
    >
      {/* First thing a keyboard reaches on every page, in the reader's language (so not before it has loaded). */}
      {loading ? null : (
        <a href="#main" className="skip-link">
          {t('nav.skipToContent')}
        </a>
      )}
      <DataSaverProvider on={saverOn}>
        <TranslationProvider value={translation}>{children}</TranslationProvider>
      </DataSaverProvider>
      <ServerWake />
      <Toast id={toastState?.id} message={toastState?.message ?? null} action={toastState?.action} onDone={clearToast} />
    </Ctx.Provider>
  );
}
