'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AdminMe, PlatformRoleName, SelfUser } from '@yapilapi/api-client';

export const ROLE_RANK: Record<PlatformRoleName, number> = {
  user: 0,
  support: 1,
  moderator: 2,
  admin: 3,
  superadmin: 4,
};

interface Ctx {
  user: SelfUser;
  role: PlatformRoleName;
  permissions: ReadonlySet<string>;
  /** True when the role's permission table includes `permission`. The server still decides on every request. */
  can: (permission: string) => boolean;
  /** True when the role ranks at least `role` (used for actions whose API routes are gated by role, not permission). */
  atLeast: (role: PlatformRoleName) => boolean;
}
const AdminContext = createContext<Ctx | null>(null);

export function makeAdminContext(user: SelfUser, admin: AdminMe): Ctx {
  const permissions = new Set(admin.permissions);
  return {
    user,
    role: admin.role,
    permissions,
    can: (p) => permissions.has(p),
    atLeast: (r) => ROLE_RANK[admin.role] >= ROLE_RANK[r],
  };
}

export function AdminProvider({
  user,
  admin,
  children,
}: {
  user: SelfUser;
  admin: AdminMe;
  children: ReactNode;
}) {
  const value = useMemo(() => makeAdminContext(user, admin), [user, admin]);
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function AdminTestProvider({ value, children }: { value: Ctx; children: ReactNode }) {
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin(): Ctx {
  const c = useContext(AdminContext);
  if (!c) throw new Error('useAdmin() requires a staff session');
  return c;
}
