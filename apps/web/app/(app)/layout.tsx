'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { NavBar, Skeleton, type NavEntry } from '@yapilapi/design-system';
import { NextLink } from '@/lib/link';
import { CallsProvider } from '@/components/Calls';
import { CheckoutProvider } from '@/components/Checkout';
import { Sidebar } from '@/components/Sidebar';
import { isPublicPath, SignedOutShell } from '@/components/SignedOut';
import { UsageHeartbeat } from '@/components/UsageHeartbeat';
import { pickMediaForCreate } from '@/lib/pending-media';
import { useSession } from '../providers';

function currentTab(path: string, username?: string): NavEntry['id'] | undefined {
  if (path.startsWith('/home')) return 'home';
  if (
    path.startsWith('/discover') ||
    path.startsWith('/search') ||
    path.startsWith('/t/') ||
    path.startsWith('/c/') ||
    path.startsWith('/events') ||
    path.startsWith('/places')
  )
    return 'discover';
  if (path.startsWith('/create')) return 'create';
  if (path.startsWith('/inbox') || path.startsWith('/notifications')) return 'inbox';
  if (username && path.startsWith(`/u/${username}`)) return 'profile';
  if (path.startsWith('/settings') || path.startsWith('/studio')) return 'profile';
  return undefined;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, unread, locale } = useSession();
  const router = useRouter();
  const path = usePathname();

  // Shared links (posts, reels, profiles, events, communities) stay open without an account.
  const openWithoutAccount = isPublicPath(path);

  useEffect(() => {
    if (loading) return;
    if (!me) {
      if (!openWithoutAccount) router.replace(`/login?next=${encodeURIComponent(path)}`);
    } else if (!me.onboarded && !path.startsWith('/onboarding')) router.replace('/onboarding');
  }, [loading, me, path, router, openWithoutAccount]);

  if (!loading && !me && openWithoutAccount) return <SignedOutShell>{children}</SignedOutShell>;

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
    { id: 'create', href: '/create' },
    { id: 'inbox', href: '/inbox', badge: unread.messages + unread.notifications },
    { id: 'profile', href: `/u/${me.username}` },
  ];

  return (
    <CallsProvider>
      <CheckoutProvider>
        <div className="yp-shell">
          {/* Tapping "+" opens the photo and video chooser at once (and Create behind it). */}
          <div
            className="yp-nav-wrap"
            onClickCapture={(e) => {
              const a = (e.target as HTMLElement).closest('a');
              if (a?.getAttribute('href') === '/create' && !e.metaKey && !e.ctrlKey) pickMediaForCreate('post');
            }}
          >
            <NavBar items={items} current={currentTab(path, me.username)} linkAs={NextLink} locale={locale} logoSrc="/mark.svg" searchHref="/search" />
          </div>
          <main className="yp-shell__main" id="main">
            {children}
          </main>
          <Sidebar />
          <UsageHeartbeat />
        </div>
      </CheckoutProvider>
    </CallsProvider>
  );
}
