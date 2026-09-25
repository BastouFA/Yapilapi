'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Avatar,
  BagIcon,
  Button,
  CalendarIcon,
  CommentIcon,
  CompassIcon,
  HomeIcon,
  MapPinIcon,
  StoreIcon,
  UsersIcon,
  LogoutIcon,
  Logo,
  Menu,
  PlusIcon,
  SettingsIcon,
  SkipLink,
  UserIcon,
  BookmarkIcon,
  ClockIcon,
  SearchIcon,
  BellIcon,
  CameraIcon,
  CodeIcon,
  ImageIcon,
  MicIcon,
  PeopleIcon,
  SparkIcon,
  StarIcon,
  VideoIcon,
  useToast,
  useUI,
  Dialog,
  InfoIcon,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { RealtimeProvider, useRealtime } from '@/lib/realtime';
import { PreferencesProvider, usePreferences } from '@/lib/preferences';
import { inQuietHours, minutesOfDay, minutesToTime, useDailyUsage } from '@/lib/attention';
import { describeError } from '@/lib/errors';

interface NavItem {
  href: string;
  label: string;
  icon: typeof HomeIcon;
  active: (path: string) => boolean;
  emphasis?: boolean;
  /** Unread count shown as a badge. */
  badge?: number;
  /** Accessible name when it differs from the visible label (e.g. includes the unread count). */
  ariaLabel?: string;
  /** Only in the side navigation; on small screens it lives in the account menu. */
  sideOnly?: boolean;
}

function useNav(): NavItem[] {
  const { t } = useI18n();
  const { user } = useSession();
  const { unread, notifUnread } = useRealtime();
  const me = `/u/${user.profile.username}`;
  return [
    { href: '/', label: t('nav.home'), icon: HomeIcon, active: (p) => p === '/' },
    {
      href: '/search',
      label: t('nav.search'),
      icon: SearchIcon,
      active: (p) => p.startsWith('/search'),
      sideOnly: true,
    },
    {
      href: '/notifications',
      label: t('nav.notifications'),
      icon: BellIcon,
      active: (p) => p.startsWith('/notifications'),
      badge: notifUnread,
      sideOnly: true,
      ...(notifUnread > 0
        ? { ariaLabel: t('nav.notificationsUnread', { count: notifUnread }) }
        : {}),
    },
    {
      href: '/discover',
      label: t('nav.discover'),
      icon: CompassIcon,
      active: (p) => p.startsWith('/discover'),
    },
    {
      href: '/create',
      label: t('nav.create'),
      icon: PlusIcon,
      active: (p) => p.startsWith('/create'),
      emphasis: true,
    },
    {
      href: '/communities',
      label: t('nav.communities'),
      icon: UsersIcon,
      active: (p) => p.startsWith('/communities'),
    },
    {
      href: '/events',
      label: t('nav.events'),
      icon: CalendarIcon,
      active: (p) => p.startsWith('/events'),
      sideOnly: true,
    },
    {
      href: '/places',
      label: t('nav.places'),
      icon: MapPinIcon,
      active: (p) => p.startsWith('/places'),
      sideOnly: true,
    },
    {
      href: '/businesses',
      label: t('nav.businesses'),
      icon: StoreIcon,
      active: (p) => p.startsWith('/businesses'),
      sideOnly: true,
    },
    {
      href: '/shop',
      label: t('nav.shop'),
      icon: BagIcon,
      active: (p) => p.startsWith('/shop'),
      sideOnly: true,
    },
    {
      href: '/inbox',
      label: t('nav.inbox'),
      icon: CommentIcon,
      active: (p) => p.startsWith('/inbox'),
      badge: unread,
      ...(unread > 0 ? { ariaLabel: t('nav.inboxUnread', { count: unread }) } : {}),
    },
    { href: me, label: t('nav.profile'), icon: UserIcon, active: (p) => p === me, sideOnly: true },
    {
      href: '/ai',
      label: t('nav.ai'),
      icon: SparkIcon,
      active: (p) => p.startsWith('/ai'),
      sideOnly: true,
    },
    {
      href: '/creator',
      label: t('nav.creator'),
      icon: StarIcon,
      active: (p) => p.startsWith('/creator'),
      sideOnly: true,
    },
    {
      href: '/studio',
      label: t('nav.studio'),
      icon: VideoIcon,
      active: (p) => p.startsWith('/studio'),
      sideOnly: true,
    },
    {
      href: '/live',
      label: t('nav.live'),
      icon: MicIcon,
      active: (p) => p.startsWith('/live'),
      sideOnly: true,
    },
    {
      href: '/memory',
      label: t('nav.memory'),
      icon: ImageIcon,
      active: (p) => p.startsWith('/memory'),
      sideOnly: true,
    },
    {
      href: '/real',
      label: t('nav.real'),
      icon: CameraIcon,
      active: (p) => p.startsWith('/real'),
      sideOnly: true,
    },
    {
      href: '/together',
      label: t('nav.together'),
      icon: PeopleIcon,
      active: (p) => p.startsWith('/together'),
      sideOnly: true,
    },
    {
      href: '/developer',
      label: t('nav.developer'),
      icon: CodeIcon,
      active: (p) => p.startsWith('/developer'),
      sideOnly: true,
    },
  ];
}

function AccountMenu({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const { user } = useSession();
  const { notifUnread } = useRealtime();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();

  const signOut = async () => {
    try {
      await api.auth.logout();
    } catch (e) {
      const d = describeError(e, t);
      if (!d.unauthenticated) {
        toast.show({ tone: 'danger', title: t('error.actionFailed'), description: d.message });
        return;
      }
    }
    router.replace('/login');
    router.refresh();
  };

  return (
    <Menu
      label={t('nav.account')}
      align={compact ? 'end' : 'start'}
      trigger={
        <button
          type="button"
          className={compact ? 'account-btn account-btn--compact' : 'account-btn'}
          aria-label={t('nav.account')}
          data-testid="account-menu"
        >
          <Avatar
            name={user.profile.displayName}
            src={user.profile.avatarUrl}
            size="sm"
            decorative
          />
          {!compact ? (
            <span className="account-btn__text">
              <span className="account-btn__name">{user.profile.displayName}</span>
              <span className="account-btn__handle" dir="ltr">
                @{user.profile.username}
              </span>
            </span>
          ) : null}
        </button>
      }
      items={[
        ...(compact
          ? [
              {
                id: 'search',
                label: t('nav.search'),
                icon: <SearchIcon size={16} />,
                onSelect: () => router.push('/search'),
              },
              {
                id: 'notifications',
                label:
                  notifUnread > 0
                    ? `${t('nav.notifications')} (${notifUnread})`
                    : t('nav.notifications'),
                icon: <BellIcon size={16} />,
                onSelect: () => router.push('/notifications'),
              },
              {
                id: 'events',
                label: t('nav.events'),
                icon: <CalendarIcon size={16} />,
                onSelect: () => router.push('/events'),
              },
              {
                id: 'places',
                label: t('nav.places'),
                icon: <MapPinIcon size={16} />,
                onSelect: () => router.push('/places'),
              },
              {
                id: 'businesses',
                label: t('nav.businesses'),
                icon: <StoreIcon size={16} />,
                onSelect: () => router.push('/businesses'),
              },
              {
                id: 'shop',
                label: t('nav.shop'),
                icon: <BagIcon size={16} />,
                onSelect: () => router.push('/shop'),
              },
              {
                id: 'ai',
                label: t('nav.ai'),
                icon: <SparkIcon size={16} />,
                onSelect: () => router.push('/ai'),
              },
              {
                id: 'creator',
                label: t('nav.creator'),
                icon: <StarIcon size={16} />,
                onSelect: () => router.push('/creator'),
              },
              {
                id: 'studio',
                label: t('nav.studio'),
                icon: <VideoIcon size={16} />,
                onSelect: () => router.push('/studio'),
              },
              {
                id: 'live',
                label: t('nav.live'),
                icon: <MicIcon size={16} />,
                onSelect: () => router.push('/live'),
              },
              {
                id: 'memory',
                label: t('nav.memory'),
                icon: <ImageIcon size={16} />,
                onSelect: () => router.push('/memory'),
              },
              {
                id: 'real',
                label: t('nav.real'),
                icon: <CameraIcon size={16} />,
                onSelect: () => router.push('/real'),
              },
              {
                id: 'together',
                label: t('nav.together'),
                icon: <PeopleIcon size={16} />,
                onSelect: () => router.push('/together'),
              },
              {
                id: 'developer',
                label: t('nav.developer'),
                icon: <CodeIcon size={16} />,
                onSelect: () => router.push('/developer'),
              },
            ]
          : []),
        {
          id: 'profile',
          label: t('nav.profile'),
          icon: <UserIcon size={16} />,
          onSelect: () => router.push(`/u/${user.profile.username}`),
        },
        {
          id: 'saved',
          label: t('nav.saved'),
          icon: <BookmarkIcon size={16} />,
          onSelect: () => router.push('/saved'),
        },
        {
          id: 'settings',
          label: t('nav.settings'),
          icon: <SettingsIcon size={16} />,
          onSelect: () => router.push('/settings/profile'),
        },
        {
          id: 'signout',
          label: t('nav.signOut'),
          icon: <LogoutIcon size={16} />,
          separatorBefore: true,
          onSelect: () => void signOut(),
        },
      ]}
    />
  );
}

/** Moves focus to the page heading after client-side navigation so keyboard and screen-reader users land on new content. */
function RouteFocus({ mainRef }: { mainRef: React.RefObject<HTMLElement | null> }) {
  const pathname = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = requestAnimationFrame(() => {
      const main = mainRef.current;
      if (!main) return;
      const h1 = main.querySelector<HTMLElement>('h1');
      const target = h1 ?? main;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(id);
  }, [pathname, mainRef]);
  return null;
}

function Banners() {
  const { t, fmt } = useI18n();
  const { user, refresh } = useSession();
  const api = useApi();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { saved } = usePreferences();

  const resend = async () => {
    setSending(true);
    try {
      await api.auth.resendVerification();
      toast.show({ tone: 'success', title: t('verify.resent') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setSending(false);
    }
  };
  const cancelDeletion = async () => {
    try {
      await api.account.cancelDeletion();
      await refresh();
      toast.show({ tone: 'success', title: t('account.deletionCancelled') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const inQuiet = saved
    ? inQuietHours(minutesOfDay(saved.timezone), saved.quietHoursStart, saved.quietHoursEnd)
    : false;

  return (
    <div className="banners">
      {user.deletionScheduledFor ? (
        <div className="yl-notice yl-notice--warning banner" role="status">
          <span>
            {t('account.deletionBanner', {
              date: fmt.dateTime(user.deletionScheduledFor, saved?.timezone),
            })}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void cancelDeletion()}>
            {t('account.cancelDeletion')}
          </Button>
        </div>
      ) : null}
      {!user.emailVerified && !dismissed ? (
        <div className="yl-notice yl-notice--info banner" role="status">
          <span>{t('verify.banner', { email: user.email })}</span>
          <span className="banner__actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void resend()}
              loading={sending}
              loadingLabel={t('common.working')}
            >
              {t('verify.resend')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
              {t('common.dismiss')}
            </Button>
          </span>
        </div>
      ) : null}
      {inQuiet && saved ? (
        <div className="yl-notice yl-notice--info banner" role="status">
          <ClockIcon size={16} />{' '}
          <span>
            {t('attention.quietBanner', { until: minutesToTime(saved.quietHoursEnd ?? 0) })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function AttentionEffects() {
  const { saved } = usePreferences();
  const { user } = useSession();
  const { t } = useI18n();
  const router = useRouter();
  const { limitReached, snooze } = useDailyUsage(
    user.id,
    saved?.dailyLimitMinutes ?? null,
    saved?.timezone ?? 'UTC',
  );

  useEffect(() => {
    document.documentElement.toggleAttribute('data-focus', Boolean(saved?.focusMode));
    return () => document.documentElement.removeAttribute('data-focus');
  }, [saved?.focusMode]);

  return (
    <Dialog
      open={limitReached}
      onClose={() => snooze(10)}
      title={t('attention.limitTitle')}
      closeLabel={t('common.close')}
      description={t('attention.limitBody', { minutes: saved?.dailyLimitMinutes ?? 0 })}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              snooze(10);
              router.push('/settings/attention');
            }}
          >
            {t('attention.changeLimit')}
          </Button>
          <Button onClick={() => snooze(10)}>{t('attention.tenMore')}</Button>
        </>
      }
    >
      <p className="dialog-note">
        <InfoIcon size={16} /> {t('attention.limitHint')}
      </p>
    </Dialog>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { Link } = useUI();
  const pathname = usePathname();
  const nav = useNav();
  const mainRef = useRef<HTMLElement>(null);

  const renderLink = (item: NavItem, variant: 'side' | 'tab') => {
    const active = item.active(pathname);
    const Icon = item.icon;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          {...(item.ariaLabel ? { 'aria-label': item.ariaLabel } : {})}
          className={
            variant === 'side'
              ? `sidenav__link${active ? ' is-active' : ''}${item.emphasis ? ' sidenav__link--emph' : ''}`
              : `tabbar__link${active ? ' is-active' : ''}${item.emphasis ? ' tabbar__link--emph' : ''}`
          }
          data-testid={`nav-${item.href === '/' ? 'home' : item.href.split('/')[1]}`}
        >
          <span className="navicon">
            <Icon size={variant === 'side' ? 22 : 24} />
            {item.badge && item.badge > 0 ? (
              <span className="navbadge" aria-hidden="true" data-testid="inbox-badge">
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </span>
          <span>{item.label}</span>
        </Link>
      </li>
    );
  };

  return (
    <div className="shell">
      <SkipLink href="#main">{t('a11y.skip')}</SkipLink>
      <aside className="shell__side">
        <div className="shell__brand">
          <Link href="/" aria-label={t('app.home')}>
            <Logo name={t('app.name')} />
          </Link>
        </div>
        <nav aria-label={t('nav.primary')}>
          <ul className="sidenav">{nav.map((n) => renderLink(n, 'side'))}</ul>
        </nav>
        <div className="shell__account">
          <AccountMenu />
        </div>
      </aside>
      <div className="shell__col">
        <header className="shell__top">
          <Link href="/" aria-label={t('app.home')}>
            <Logo name={t('app.name')} size={28} />
          </Link>
          <AccountMenu compact />
        </header>
        <main id="main" ref={mainRef} className="shell__main" tabIndex={-1}>
          <Banners />
          {children}
        </main>
      </div>
      <nav className="tabbar" aria-label={t('nav.primary')}>
        <ul className="tabbar__list">
          {nav.filter((n) => !n.sideOnly).map((n) => renderLink(n, 'tab'))}
        </ul>
      </nav>
      <RouteFocus mainRef={mainRef} />
      <AttentionEffects />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PreferencesProvider>
      <RealtimeProvider>
        <ShellInner>{children}</ShellInner>
      </RealtimeProvider>
    </PreferencesProvider>
  );
}
