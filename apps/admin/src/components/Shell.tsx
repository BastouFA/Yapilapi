'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  AlertIcon,
  Badge,
  Button,
  ClockIcon,
  CompassIcon,
  FlagIcon,
  GlobeIcon,
  HomeIcon,
  LinkIcon,
  LogoutIcon,
  PollIcon,
  ShieldIcon,
  SkipLink,
  SparkIcon,
  UserIcon,
  UsersIcon,
  type IconProps,
} from '@yapilapi/ui';
import type { ComponentType } from 'react';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { activeNavId, visibleNav, type NavIcon } from '@/lib/nav';
import { useAdmin } from '@/lib/session';
import { LocaleSwitch } from './LocaleSwitch';
import { ThemeSwitch } from './ThemeSwitch';

const ICONS: Record<NavIcon, ComponentType<IconProps>> = {
  home: HomeIcon,
  users: UsersIcon,
  search: CompassIcon,
  shield: ShieldIcon,
  flag: FlagIcon,
  globe: GlobeIcon,
  store: HomeIcon,
  star: SparkIcon,
  card: PollIcon,
  alert: AlertIcon,
  spark: SparkIcon,
  chart: PollIcon,
  clock: ClockIcon,
  settings: UserIcon,
  link: LinkIcon,
};

export function Shell({ children }: { children: ReactNode }) {
  const { t, tx, label } = useI18n();
  const { user, role, can, atLeast } = useAdmin();
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const active = activeNavId(pathname);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.auth.logout();
    } catch {
      /* the session may already be gone: continue to sign-in */
    }
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className="shell">
      <SkipLink href="#main">{t('nav.skip')}</SkipLink>
      <header className="shell__top">
        <div className="shell__brand">
          <button
            type="button"
            className="shell__menu-btn"
            aria-expanded={open}
            aria-controls="primary-nav"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t('nav.closeMenu') : t('nav.menu')}
          </button>
          <Link href="/" className="shell__logo">
            {t('app.name')}
          </Link>
          <Badge tone="secondary">{t('app.consoleBadge')}</Badge>
        </div>
        <div className="shell__who">
          <LocaleSwitch />
          <ThemeSwitch />
          <span className="shell__user" data-testid="whoami">
            <span className="shell__username">{user.profile.username}</span>
            <Badge tone="primary">{label('role', role)}</Badge>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void signOut()}
            loading={signingOut}
            loadingLabel={t('common.working')}
            leadingIcon={<LogoutIcon size={16} />}
          >
            {t('nav.signOut')}
          </Button>
        </div>
      </header>
      <nav
        id="primary-nav"
        aria-label={t('nav.primary')}
        className={open ? 'shell__nav is-open' : 'shell__nav'}
      >
        {visibleNav(can, atLeast).map((g) => {
          const items = g.items;
          return (
            <div key={g.id} className="navgroup">
              <p className="navgroup__label" id={`ng-${g.id}`}>
                {tx(g.label)}
              </p>
              <ul aria-labelledby={`ng-${g.id}`}>
                {items.map((i) => {
                  const Icon = ICONS[i.icon];
                  return (
                    <li key={i.id}>
                      <Link
                        href={i.href}
                        className={active === i.id ? 'navlink is-active' : 'navlink'}
                        aria-current={active === i.id ? 'page' : undefined}
                      >
                        <Icon size={18} /> <span>{tx(i.label)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <main id="main" className="shell__main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
