import type { PlatformRoleName } from '@yapilapi/api-client';
import type { MessageKey } from '@/i18n';

export type NavIcon =
  | 'home'
  | 'users'
  | 'search'
  | 'shield'
  | 'flag'
  | 'globe'
  | 'store'
  | 'star'
  | 'card'
  | 'alert'
  | 'spark'
  | 'chart'
  | 'clock'
  | 'settings'
  | 'link';

export interface NavItem {
  id: string;
  href: string;
  label: MessageKey;
  icon: NavIcon;
  /** Permission from GET /v1/admin/me the item needs (the API enforces it again on every call). */
  permission?: string;
  /** Minimum role for items backed by role-gated (not permission-gated) API routes. */
  minRole?: PlatformRoleName;
}
export interface NavGroup {
  id: string;
  label: MessageKey;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    id: 'overview',
    label: 'nav.group.overview',
    items: [{ id: 'dashboard', href: '/', label: 'nav.dashboard', icon: 'home' }],
  },
  {
    id: 'people',
    label: 'nav.group.people',
    items: [
      { id: 'users', href: '/users', label: 'nav.users', icon: 'users', permission: 'users.read' },
      {
        id: 'content',
        href: '/content',
        label: 'nav.content',
        icon: 'search',
        permission: 'content.read',
      },
    ],
  },
  {
    id: 'safety',
    label: 'nav.group.safety',
    items: [
      {
        id: 'moderation',
        href: '/moderation',
        label: 'nav.moderation',
        icon: 'shield',
        permission: 'cases.read',
      },
      {
        id: 'communities',
        href: '/communities',
        label: 'nav.communities',
        icon: 'globe',
        permission: 'communities.read',
      },
    ],
  },
  {
    id: 'commerce',
    label: 'nav.group.commerce',
    items: [
      {
        id: 'businesses',
        href: '/businesses',
        label: 'nav.businesses',
        icon: 'store',
        permission: 'businesses.read',
      },
      {
        id: 'creators',
        href: '/creators',
        label: 'nav.creators',
        icon: 'star',
        permission: 'creators.read',
      },
      {
        id: 'payments',
        href: '/payments',
        label: 'nav.payments',
        icon: 'card',
        permission: 'payments.read',
      },
      { id: 'fraud', href: '/fraud', label: 'nav.fraud', icon: 'alert', permission: 'fraud.read' },
    ],
  },
  {
    id: 'insights',
    label: 'nav.group.insights',
    items: [
      {
        id: 'analytics',
        href: '/analytics/msa',
        label: 'nav.analytics',
        icon: 'chart',
        permission: 'analytics.read',
      },
      { id: 'ai', href: '/ai', label: 'nav.ai', icon: 'spark', permission: 'ai.read' },
    ],
  },
  {
    id: 'platform',
    label: 'nav.group.platform',
    items: [
      { id: 'audit', href: '/audit', label: 'nav.audit', icon: 'clock', permission: 'audit.read' },
      { id: 'flags', href: '/flags', label: 'nav.flags', icon: 'flag', permission: 'flags.read' },
      {
        id: 'developer',
        href: '/developer',
        label: 'nav.developer',
        icon: 'link',
        permission: 'miniapps.review',
      },
    ],
  },
];

/** Which nav item owns this pathname. */
export function activeNavId(pathname: string): string {
  if (pathname === '/') return 'dashboard';
  for (const g of NAV)
    for (const i of g.items) {
      const base = i.href === '/analytics/msa' ? '/analytics' : i.href;
      if (base !== '/' && (pathname === base || pathname.startsWith(`${base}/`))) return i.id;
    }
  return '';
}

/**
 * The sections a role sees. Purely cosmetic: hiding a link never grants or removes access, because every API route
 * checks the role, the permission and MFA on its own.
 */
export function visibleNav(
  can: (permission: string) => boolean,
  atLeast: (role: PlatformRoleName) => boolean,
): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) => (!i.permission || can(i.permission)) && (!i.minRole || atLeast(i.minRole)),
    ),
  })).filter((g) => g.items.length > 0);
}
