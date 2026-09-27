import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import type { Me } from '../../../packages/shared/src/types';
import {
  accountWithToken,
  activateAccount,
  client,
  forgetAccount,
  getToken,
  realtimeUrl,
  rememberAccount,
  restoreToken,
  signOut as apiSignOut,
  signOutStoredAccount,
  storedAccounts,
  type StoredAccount,
} from './api';
import { onBackOnline } from './network';
import { followActiveAccount, stopPushForThisAccount } from './push';

export type RealtimeEvent = { type: string; data?: any };
type Listener = (e: RealtimeEvent) => void;

interface SessionCtx {
  /** undefined while loading, null when signed out. */
  me: Me | null | undefined;
  refresh: () => Promise<void>;
  /**
   * Log out of the account in use on this phone. When other accounts are signed in here, the next
   * one takes over ('switched'); otherwise the app goes back to the welcome screen ('signedOut').
   */
  signOut: () => Promise<'switched' | 'signedOut'>;
  /** Log out of every device (this one included): the account's sessions all end. */
  signOutEverywhere: () => Promise<'switched' | 'signedOut'>;
  /** The accounts signed in on this phone (the one in use included), in the order they were added. */
  accounts: StoredAccount[];
  /** Use another signed-in account. False when it needs a new log in (its session ended). */
  switchAccount: (id: string) => Promise<boolean>;
  /** Log out of an account that isn't the one in use. */
  removeAccount: (id: string) => Promise<void>;
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
  signOut: async () => 'signedOut',
  signOutEverywhere: async () => 'signedOut',
  accounts: [],
  switchAccount: async () => false,
  removeAccount: async () => {},
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
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const listeners = useRef(new Set<Listener>());
  const keepAlive = useRef(false);
  const setKeepAlive = useCallback((on: boolean) => void (keepAlive.current = on), []);
  const ready = useRef(false);
  const waitForRealtime = useCallback(async () => {
    for (let i = 0; i < 50 && !ready.current; i++) await new Promise((r) => setTimeout(r, 100));
  }, []);

  /** The next saved account that still has a working session, made the one in use; null when there is none. */
  const takeOver = useCallback(async (): Promise<Me | null> => {
    for (const a of await storedAccounts()) {
      if (!(await activateAccount(a.id))) {
        await forgetAccount(a.id);
        continue;
      }
      try {
        const user = (await (await client()).auth.me()).user;
        setAccounts(await rememberAccount(user));
        return user;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'network') return null;
        await forgetAccount(a.id);
      }
    }
    await restoreToken(undefined);
    setAccounts(await storedAccounts());
    return null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      // No account in use (it was logged out elsewhere on this phone): another saved one takes over.
      if (!(await getToken())) return setMe(await takeOver());
      const api = await client();
      const user = (await api.auth.me()).user;
      setMe(user);
      // Kept with its own token, so it can be switched back to after adding another account.
      setAccounts(await rememberAccount(user).catch(() => storedAccounts()));
    } catch (e) {
      // Offline with a saved session: stay signed in (and keep loading) rather than showing the
      // welcome screen; the check runs again when the connection is back.
      if (e instanceof ApiError && e.code === 'network') return setMe((cur) => cur);
      // The session in use ended (logged out elsewhere, password changed): forget it, and let
      // another account signed in on this phone take over when there is one.
      const token = await getToken();
      const ended = token ? await accountWithToken(token) : null;
      if (ended) await forgetAccount(ended);
      await restoreToken(undefined);
      setMe(await takeOver());
    }
  }, [takeOver]);

  useEffect(() => {
    void refresh();
    void storedAccounts().then(setAccounts);
  }, [refresh]);

  // Started offline: find out who is signed in as soon as the connection is back.
  const meRef = useRef(me);
  meRef.current = me;
  useEffect(
    () =>
      onBackOnline(() => {
        if (meRef.current === undefined) void refresh();
      }),
    [refresh],
  );

  const signOut = useCallback(async () => {
    const current = meRef.current;
    await stopPushForThisAccount();
    await apiSignOut();
    if (current) setAccounts(await forgetAccount(current.id));
    const next = await takeOver();
    setMe(next);
    if (next) void followActiveAccount();
    return next ? ('switched' as const) : ('signedOut' as const);
  }, [takeOver]);

  const signOutEverywhere = useCallback(async () => {
    const current = meRef.current;
    // Every session ends on the API, and every device stops getting this account's notifications.
    await (await client()).auth.logoutAll();
    await restoreToken(undefined);
    if (current) setAccounts(await forgetAccount(current.id));
    const next = await takeOver();
    setMe(next);
    if (next) void followActiveAccount();
    return next ? ('switched' as const) : ('signedOut' as const);
  }, [takeOver]);

  const switchAccount = useCallback(async (id: string) => {
    if (meRef.current?.id === id) return true;
    const before = await getToken();
    if (!(await activateAccount(id))) return false;
    try {
      const user = (await (await client()).auth.me()).user;
      setMe(user);
      setAccounts(await rememberAccount(user));
      void followActiveAccount();
      return true;
    } catch (e) {
      await restoreToken(before);
      // Its session ended (logged out elsewhere, or the password changed): it needs a new log in.
      if (!(e instanceof ApiError && e.code === 'network')) setAccounts(await forgetAccount(id));
      return false;
    }
  }, []);

  const removeAccount = useCallback(async (id: string) => {
    if (meRef.current?.id === id) return;
    setAccounts(await signOutStoredAccount(id));
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

  return (
    <Ctx.Provider value={{ me, refresh, signOut, signOutEverywhere, accounts, switchAccount, removeAccount, subscribe, setKeepAlive, waitForRealtime }}>
      {children}
    </Ctx.Provider>
  );
}
