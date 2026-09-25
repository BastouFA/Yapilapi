'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MeResponse, SelfUser } from '@yapilapi/api-client';
import { useApi } from './api';

interface Ctx {
  user: SelfUser;
  flags: Record<string, boolean>;
  isTeen: boolean;
  refresh: () => Promise<void>;
}
const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({
  initial,
  children,
}: {
  initial: MeResponse;
  children: ReactNode;
}) {
  const api = useApi();
  const [me, setMe] = useState(initial);
  const refresh = useCallback(async () => {
    setMe(await api.auth.me());
  }, [api]);
  const value = useMemo<Ctx>(
    () => ({ user: me.user, flags: me.flags, isTeen: me.user.ageBand === 'teen', refresh }),
    [me, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionContext);
  if (!c) throw new Error('useSession() requires an authenticated route');
  return c;
}
