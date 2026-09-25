import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Device from 'expo-device';
import {
  ApiError,
  type LoginResult,
  type MeResponse,
  type RegisterInput,
  type SelfUser,
} from '@yapilapi/api-client';
import { createMobileApi, type MobileApi } from '../api';
import { createSecureTokenStore, type TokenStore } from './token-store';
import { API_URL } from '../config';
import { kv } from '../lib/kv';
import { usePrefs } from '../prefs';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'error';
export type LoginOutcome = { kind: 'ok' } | { kind: 'mfa'; challengeToken: string };

interface AuthValue {
  status: AuthStatus;
  user: SelfUser | null;
  flags: Record<string, boolean>;
  api: MobileApi;
  /** True while the cached profile is shown because the server could not be reached. */
  offline: boolean;
  register: (input: Omit<RegisterInput, 'acceptTerms' | 'locale' | 'timezone'>) => Promise<void>;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  verifyMfa: (
    challengeToken: string,
    code: { code?: string; recoveryCode?: string },
  ) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  retryBoot: () => void;
  /** Called by sign-out cleanup hooks (query cache, outbox, push token). Returns an unregister function. */
  onSignOut: (fn: () => void | Promise<void>) => () => void;
}

const AuthContext = createContext<AuthValue | null>(null);
const ME_KEY = 'yl.me.v1';

export interface AuthProviderProps {
  children: React.ReactNode;
  baseUrl?: string;
  tokenStore?: TokenStore;
  fetch?: typeof fetch;
}

const deviceLabel = () => {
  try {
    return (
      [Device.manufacturer, Device.modelName].filter(Boolean).join(' ').slice(0, 80) || undefined
    );
  } catch {
    return undefined;
  }
};
const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function AuthProvider({
  children,
  baseUrl = API_URL,
  tokenStore,
  fetch: fetchImpl,
}: AuthProviderProps) {
  const store = useMemo(() => tokenStore ?? createSecureTokenStore(), [tokenStore]);
  const tokenRef = useRef<string | null>(null);
  const { prefs } = usePrefs();
  const localeRef = useRef(prefs.locale);
  localeRef.current = prefs.locale;
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<SelfUser | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [offline, setOffline] = useState(false);
  const [bootNonce, setBootNonce] = useState(0);
  const signOutHooks = useRef(new Set<() => void | Promise<void>>());

  const localSignOut = useRef<() => Promise<void>>(async () => undefined);
  const api = useMemo(
    () =>
      createMobileApi({
        baseUrl,
        getToken: () => tokenRef.current,
        locale: () => localeRef.current,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onUnauthorized: () => {
          if (tokenRef.current) void localSignOut.current();
        },
      }),
    [baseUrl, fetchImpl],
  );

  localSignOut.current = async () => {
    tokenRef.current = null;
    await store.clear();
    await kv.remove(ME_KEY);
    for (const fn of [...signOutHooks.current]) {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    }
    setUser(null);
    setFlags({});
    setOffline(false);
    setStatus('signedOut');
  };

  const applyMe = useCallback((me: MeResponse) => {
    setUser(me.user);
    setFlags(me.flags ?? {});
    setOffline(false);
    setStatus('signedIn');
    void kv.set(ME_KEY, me);
  }, []);

  // Boot: restore the session from secure storage and confirm it with the server (cached profile when offline).
  useEffect(() => {
    let live = true;
    (async () => {
      setStatus('loading');
      const token = await store.get();
      if (!live) return;
      if (!token) {
        setStatus('signedOut');
        return;
      }
      tokenRef.current = token;
      try {
        const me = await api.auth.me({ skipUnauthorizedHook: true });
        if (live) applyMe(me);
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) {
          await localSignOut.current();
          return;
        }
        const cached = await kv.get<MeResponse>(ME_KEY);
        if (cached) {
          setUser(cached.user);
          setFlags(cached.flags ?? {});
          setOffline(true);
          setStatus('signedIn');
        } else setStatus('error');
      }
    })();
    return () => {
      live = false;
    };
  }, [store, api, applyMe, bootNonce]);

  const establish = useCallback(
    async (token: string | undefined, u: SelfUser) => {
      if (!token)
        throw new ApiError('bad_response', 'The server did not return a session token', 200);
      await store.set(token);
      tokenRef.current = token;
      // /me also returns the feature flags for this user.
      try {
        applyMe(await api.auth.me({ skipUnauthorizedHook: true }));
      } catch {
        setUser(u);
        setStatus('signedIn');
      }
    },
    [store, api, applyMe],
  );

  const register = useCallback<AuthValue['register']>(
    async (input) => {
      const res = await api.auth.register({
        ...input,
        acceptTerms: true,
        locale: localeRef.current,
        timezone: timezone(),
      });
      await establish(res.token, res.user);
    },
    [api, establish],
  );

  const login = useCallback<AuthValue['login']>(
    async (email, password) => {
      const label = deviceLabel();
      const res: LoginResult = await api.auth.login({
        email: email.trim(),
        password,
        ...(label ? { deviceLabel: label } : {}),
      });
      if (res.mfaRequired) return { kind: 'mfa', challengeToken: res.challengeToken };
      await establish(res.token, res.user);
      return { kind: 'ok' };
    },
    [api, establish],
  );

  const verifyMfa = useCallback<AuthValue['verifyMfa']>(
    async (challengeToken, c) => {
      const res = await api.auth.mfaVerify(
        c.recoveryCode
          ? { challengeToken, recoveryCode: c.recoveryCode }
          : { challengeToken, code: c.code ?? '' },
      );
      await establish(res.token, res.user);
    },
    [api, establish],
  );

  const logout = useCallback(async () => {
    // Run sign-out hooks first (push token unregistration needs the still-valid session), then revoke the session.
    for (const fn of [...signOutHooks.current]) {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    }
    try {
      await api.auth.logout();
    } catch {
      /* the session is dropped locally regardless */
    }
    signOutHooks.current.clear();
    await localSignOut.current();
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      applyMe(await api.auth.me());
    } catch {
      /* keep current */
    }
  }, [api, applyMe]);
  const retryBoot = useCallback(() => setBootNonce((n) => n + 1), []);
  const onSignOut = useCallback((fn: () => void | Promise<void>) => {
    signOutHooks.current.add(fn);
    return () => {
      signOutHooks.current.delete(fn);
    };
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      flags,
      api,
      offline,
      register,
      login,
      verifyMfa,
      logout,
      refresh,
      retryBoot,
      onSignOut,
    }),
    [
      status,
      user,
      flags,
      api,
      offline,
      register,
      login,
      verifyMfa,
      logout,
      refresh,
      retryBoot,
      onSignOut,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
export const useApi = () => useAuth().api;
export const useMe = () => {
  const { user } = useAuth();
  if (!user) throw new Error('useMe requires a signed-in user');
  return user;
};
