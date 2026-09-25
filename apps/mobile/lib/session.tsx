import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { Me } from '../../../packages/shared/src/types';
import { client, getToken, realtimeUrl, signOut as apiSignOut } from './api';

export type RealtimeEvent = { type: string; data?: any };
type Listener = (e: RealtimeEvent) => void;

interface SessionCtx {
  /** undefined while loading, null when signed out. */
  me: Me | null | undefined;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Subscribe to realtime events from the API socket. Returns an unsubscribe function. */
  subscribe: (fn: Listener) => () => void;
  /** Keep the socket open in the background (during a call, so signaling keeps flowing). */
  setKeepAlive: (on: boolean) => void;
  /** Resolves once the realtime socket is open (or after a few seconds, whichever is first). */
  waitForRealtime: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  me: undefined,
  refresh: async () => {},
  signOut: async () => {},
  subscribe: () => () => {},
  setKeepAlive: () => {},
  waitForRealtime: async () => {},
});
export const useSession = () => useContext(Ctx);

/** Calls `fn` for every realtime event while the component is mounted. */
export function useRealtime(fn: Listener) {
  const { subscribe } = useSession();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

// React Native's WebSocket takes a third argument with headers; the DOM typings don't know it.
type RNWebSocketCtor = new (url: string, protocols?: string | string[] | null, options?: { headers: Record<string, string> }) => WebSocket;

/**
 * Who is signed in, plus the realtime socket (the same /v1/realtime endpoint the web app
 * uses, authenticated with the Bearer token in a header). The socket stays open while the
 * app is in the foreground and reconnects with backoff.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const listeners = useRef(new Set<Listener>());
  const keepAlive = useRef(false);
  const setKeepAlive = useCallback((on: boolean) => void (keepAlive.current = on), []);
  const ready = useRef(false);
  const waitForRealtime = useCallback(async () => {
    for (let i = 0; i < 50 && !ready.current; i++) await new Promise((r) => setTimeout(r, 100));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const api = await client();
      setMe((await api.auth.me()).user);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await apiSignOut();
    setMe(null);
  }, []);

  useEffect(() => {
    if (!me) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = async () => {
      if (stopped || ws) return;
      const token = await getToken();
      if (!token || stopped) return;
      const socket = new (WebSocket as unknown as RNWebSocketCtor)(realtimeUrl(), null, { headers: { authorization: `Bearer ${token}` } });
      ws = socket;
      socket.onopen = () => {
        attempt = 0;
        ping = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'ping' })), 25_000);
      };
      socket.onmessage = (ev: MessageEvent) => {
        try {
          const event = JSON.parse(String(ev.data)) as RealtimeEvent;
          if (event.type === 'ready') ready.current = true;
          listeners.current.forEach((l) => l(event));
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        clearInterval(ping);
        ready.current = false;
        if (ws === socket) ws = null;
        if (stopped || (AppState.currentState !== 'active' && !keepAlive.current)) return;
        attempt++;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
    };
    const disconnect = () => {
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close();
      ws = null;
    };

    void connect();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        attempt = 0;
        void connect();
        listeners.current.forEach((l) => l({ type: 'app.foreground' }));
      } else if (s === 'background' && !keepAlive.current) disconnect();
    });
    return () => {
      stopped = true;
      sub.remove();
      disconnect();
    };
  }, [me]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  return <Ctx.Provider value={{ me, refresh, signOut, subscribe, setKeepAlive, waitForRealtime }}>{children}</Ctx.Provider>;
}
