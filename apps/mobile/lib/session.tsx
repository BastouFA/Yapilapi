import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { Me } from '../../../packages/shared/src/types';
import { sessionCheckFailure, takeOver, takeOverCandidates } from '../../../packages/shared/src/accounts';
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
  /** Send a small frame on the realtime socket (like "typing"); dropped when it isn't open. */
  sendRealtime: (frame: { type: string; conversationId?: string }) => void;
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
  sendRealtime: () => {},
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
  const socketRef = useRef<WebSocket | null>(null);
  const waitForRealtime = useCallback(async () => {
    for (let i = 0; i < 50 && !ready.current; i++) await new Promise((r) => setTimeout(r, 100));
  }, []);

  const meRef = useRef(me);
  meRef.current = me;

  // A check that couldn't be answered (offline, or a problem on our side) is tried again soon.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retrySoon = useCallback(() => {
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => void refreshRef.current(), 15_000);
  }, []);
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  /**
   * The next account on this phone with a working session becomes the one in use (the rules are in
   * packages/shared/src/accounts.ts). 'pending': one is in use but the API couldn't confirm it yet
   * (offline): keep loading rather than show the welcome screen, and check again. 'signedOut':
   * nobody is left.
   */
  const takeOverNext = useCallback(
    async (leavingId?: string | null): Promise<'switched' | 'pending' | 'signedOut'> => {
      const r = await takeOver(takeOverCandidates(await storedAccounts(), leavingId), {
        activate: activateAccount,
        whoAmI: async () => (await (await client()).auth.me()).user,
        forget: forgetAccount,
      });
      if (r.kind === 'switched') {
        setMe(r.user);
        setAccounts(await rememberAccount(r.user));
        void followActiveAccount();
        return 'switched';
      }
      setAccounts(await storedAccounts());
      if (r.kind === 'pending') {
        setMe(undefined);
        retrySoon();
        return 'pending';
      }
      await restoreToken(undefined);
      setMe(null);
      return 'signedOut';
    },
    [retrySoon],
  );

  const refresh = useCallback(async () => {
    // No account in use (it was logged out elsewhere on this phone): another saved one takes over.
    if (!(await getToken())) {
      await takeOverNext();
      return;
    }
    try {
      const api = await client();
      const user = (await api.auth.me()).user;
      setMe(user);
      // Kept with its own token, so it can be switched back to after adding another account.
      setAccounts(await rememberAccount(user).catch(() => storedAccounts()));
    } catch (e) {
      const failure = sessionCheckFailure(e);
      // Offline, or the API had a problem: stay signed in (and keep loading if nothing showed
      // yet) rather than showing the welcome screen. Only a session the API says has ended is
      // forgotten; a server error or a rate limit never signs anyone out.
      if (failure !== 'ended') {
        setMe((cur) => cur);
        // Offline is checked again when the connection is back; a problem on our side, in a moment.
        if (failure === 'unavailable' && meRef.current === undefined) retrySoon();
        return;
      }
      // The session in use ended (logged out elsewhere, password changed): forget it, and let
      // another account signed in on this phone take over when there is one.
      const token = await getToken();
      const ended = token ? await accountWithToken(token) : null;
      if (ended) await forgetAccount(ended);
      await restoreToken(undefined);
      await takeOverNext(ended);
    }
  }, [takeOverNext, retrySoon]);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    void storedAccounts().then(setAccounts);
  }, [refresh]);

  // Started offline: find out who is signed in as soon as the connection is back.
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
    // Another account on this phone takes over; offline, it stays in use and is checked again.
    return (await takeOverNext(current?.id)) === 'signedOut' ? ('signedOut' as const) : ('switched' as const);
  }, [takeOverNext]);

  const signOutEverywhere = useCallback(async () => {
    const current = meRef.current;
    // Every session ends on the API, and every device stops getting this account's notifications.
    await (await client()).auth.logoutAll();
    await restoreToken(undefined);
    if (current) setAccounts(await forgetAccount(current.id));
    return (await takeOverNext(current?.id)) === 'signedOut' ? ('signedOut' as const) : ('switched' as const);
  }, [takeOverNext]);

  const switchAccount = useCallback(async (id: string) => {
    if (meRef.current?.id === id) return true;
    const before = await getToken();
    // Its token is gone from the keychain: nothing to switch to, so it leaves the list (it needs a new log in).
    if (!(await activateAccount(id))) {
      setAccounts(await forgetAccount(id));
      return false;
    }
    try {
      const user = (await (await client()).auth.me()).user;
      setMe(user);
      setAccounts(await rememberAccount(user));
      void followActiveAccount();
      return true;
    } catch (e) {
      await restoreToken(before);
      // Its session ended (logged out elsewhere, or the password changed): it needs a new log in.
      // Offline or a problem on our side: it stays on the phone, to try again.
      if (sessionCheckFailure(e) === 'ended') setAccounts(await forgetAccount(id));
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
    // Reading the token takes a moment: a second connect in the meantime (the app coming to the front
    // just as it starts) would open a second socket, delivering every event twice.
    let connecting = false;

    const connect = async () => {
      if (stopped || ws || connecting) return;
      connecting = true;
      const token = await getToken()
        .catch(() => undefined)
        .finally(() => (connecting = false));
      if (!token || stopped || ws) return;
      const socket = new (WebSocket as unknown as RNWebSocketCtor)(realtimeUrl(), null, { headers: { authorization: `Bearer ${token}` } });
      ws = socket;
      socketRef.current = socket;
      // Each socket keeps its own ping, so an old one closing late never stops the new one's.
      let ping: ReturnType<typeof setInterval> | undefined;
      socket.onopen = () => {
        attempt = 0;
        clearInterval(ping);
        ping = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'ping' })), 25_000);
      };
      socket.onmessage = (ev: MessageEvent) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(String(ev.data)) as RealtimeEvent;
        } catch {
          return; // a malformed frame
        }
        if (event.type === 'ready') ready.current = true;
        // One screen's handler failing doesn't keep the event from the others.
        listeners.current.forEach((l) => {
          try {
            l(event);
          } catch {
            /* that handler's problem */
          }
        });
      };
      socket.onclose = () => {
        clearInterval(ping);
        if (socketRef.current === socket) socketRef.current = null;
        if (ws !== socket && ws) return; // an old socket closing after a new one opened
        ready.current = false;
        ws = null;
        if (stopped || (AppState.currentState !== 'active' && !keepAlive.current)) return;
        attempt++;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
    };
    const disconnect = () => {
      clearTimeout(retry);
      // Closing it stops its ping (onclose).
      ws?.close();
      ws = null;
    };

    void connect();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        attempt = 0;
        void connect();
        listeners.current.forEach((l) => {
          try {
            l({ type: 'app.foreground' });
          } catch {
            /* that handler's problem */
          }
        });
      } else if (s === 'background' && !keepAlive.current) disconnect();
    });
    return () => {
      stopped = true;
      sub.remove();
      disconnect();
    };
    // The account, not the profile object: refreshing your profile (a new name, a setting) keeps the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  const sendRealtime = useCallback((frame: { type: string; conversationId?: string }) => {
    const socket = socketRef.current;
    if (socket?.readyState === 1) socket.send(JSON.stringify(frame));
  }, []);

  return (
    <Ctx.Provider
      value={{ me, refresh, signOut, signOutEverywhere, accounts, switchAccount, removeAccount, subscribe, sendRealtime, setKeepAlive, waitForRealtime }}
    >
      {children}
    </Ctx.Provider>
  );
}
