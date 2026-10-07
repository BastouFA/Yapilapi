'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button, EmptyState, NavBar, Skeleton, type NavEntry } from '@yapilapi/design-system';
import { NextLink } from '@/lib/link';
import { RailAccountButton } from '@/components/AccountMenu';
import { AnnouncementBanner } from '@/components/AnnouncementBanner';
import { BirthDateGate } from '@/components/BirthDateGate';
import { CallsProvider } from '@/components/Calls';
import { CheckoutProvider } from '@/components/Checkout';
import { RoomsProvider } from '@/components/Rooms';
import { Sidebar } from '@/components/Sidebar';
import { isPublicPath, SignedOutShell } from '@/components/SignedOut';
import { UsageHeartbeat } from '@/components/UsageHeartbeat';
import { YapPlayer } from '@/components/Yap';
import { useSession } from '../providers';

function currentTab(path: string, username?: string): NavEntry['id'] | undefined {
  if (path.startsWith('/home')) return 'home';
  if (
    path.startsWith('/discover') ||
    path.startsWith('/search') ||
    path.startsWith('/t/') ||
    path.startsWith('/c/') ||
    path.startsWith('/communities') ||
    path.startsWith('/events') ||
    path.startsWith('/places') ||
    path.startsWith('/market')
  )
    return 'discover';
  if (path.startsWith('/create') || path.startsWith('/camera')) return 'create';
  if (path.startsWith('/inbox') || path.startsWith('/yap') || path.startsWith('/notifications')) return 'inbox';
  if (username && path.startsWith(`/u/${username}`)) return 'profile';
  if (path.startsWith('/settings') || path.startsWith('/studio') || path.startsWith('/saved')) return 'profile';
  return undefined;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, unread, locale, sessionError, refresh, t } = useSession();
  const router = useRouter();
  const path = usePathname();

  // Shared links (posts, reels, profiles, events, communities) stay open without an account.
  const openWithoutAccount = isPublicPath(path);

  useEffect(() => {
    if (loading) return;
    if (!me && sessionError) return;
    if (!me) {
      // Back to the same place after logging in, query and all (a settings section, a search).
      if (!openWithoutAccount) router.replace(`/login?next=${encodeURIComponent(path + location.search + location.hash)}`);
    } else if (!me.onboarded && !path.startsWith('/onboarding')) router.replace('/onboarding');
  }, [loading, me, path, router, openWithoutAccount, sessionError]);

  // The account couldn't be checked: say why rather than treat it as signed out.
  if (!loading && !me && sessionError)
    return (
      <main className="yp-shell__main" id="main">
        <div className="yp-shell__inner">
          <EmptyState level={1} title={sessionError} action={<Button onClick={() => void refresh()}>{t('m.common.retry')}</Button>} />
        </div>
      </main>
    );
  if (!loading && !me && openWithoutAccount) return <SignedOutShell>{children}</SignedOutShell>;
  // An account made before a date of birth was required gives it once, before anything else.
  if (!loading && me?.needsBirthDate) return <BirthDateGate />;

  if (loading || !me)
    return (
      <div className="yp-shell">
        <main className="yp-shell__main" id="main">
          <div className="yp-shell__inner" aria-busy>
            <Skeleton height={40} />
            <Skeleton height={220} />
            <Skeleton height={220} />
          </div>
        </main>
      </div>
    );

  const items: NavEntry[] = [
    { id: 'home', href: '/home' },
    { id: 'discover', href: '/discover' },
    // Spark opens the camera, where you choose Post, Reel or Story (or the gallery, or writing).
    { id: 'create', href: '/camera' },
    { id: 'inbox', href: '/inbox', badge: unread.messages + unread.notifications },
    { id: 'profile', href: `/u/${me.username}`, avatar: { name: me.displayName, src: me.avatarUrl } },
  ];

  // Yap mode: chats on their own (components/YapShell.tsx draws its own bar).
  if (path.startsWith('/yap'))
    return (
      <CallsProvider>
        <RoomsProvider>
          <CheckoutProvider>
            <main className="yap-mode__main" id="main">
              {children}
            </main>
            <YapPlayer />
          </CheckoutProvider>
        </RoomsProvider>
      </CallsProvider>
    );

  return (
    <CallsProvider>
      <RoomsProvider>
        <CheckoutProvider>
          <div className="yp-shell">
            <NavBar
              items={items}
              current={currentTab(path, me.username)}
              linkAs={NextLink}
              locale={locale}
              logoSrc="/mark.svg"
              searchHref="/search"
              footer={<RailAccountButton />}
            />
            <main className="yp-shell__main" id="main">
              {/* A note from the team to everyone, until it ends or you close it. */}
              <AnnouncementBanner />
              {children}
            </main>
            <Sidebar />
            <UsageHeartbeat />
            <YapPlayer />
          </div>
        </CheckoutProvider>
      </RoomsProvider>
    </CallsProvider>
  );
}
