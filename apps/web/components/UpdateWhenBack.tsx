'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useCalls } from '@/components/Calls';
import { keepBrowserPush } from '@/lib/push';
import { useSession } from '@/app/providers';

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

/**
 * A page left open (a home-screen app kept for days) keeps running the version it loaded. When it
 * comes back to the screen after a while and a newer version is out, it reloads into it. Not in
 * the middle of something: making a post, live, watching together, in a call, or with words typed
 * in a message box.
 */
export function UpdateWhenBack() {
  const path = usePathname();
  const { current: call } = useCalls();
  const { me } = useSession();
  // Each time the app opens, and for whichever account is signed in: notifications reach this phone.
  const accountId = me?.id;
  useEffect(() => {
    if (accountId) void keepBrowserPush().catch(() => {});
  }, [accountId]);
  useEffect(() => {
    if (BUILD === 'dev') return;
    let hiddenAt = 0;
    const busy = () =>
      !!call ||
      ['/create', '/camera', '/live', '/watch', '/recaps/new', '/stash/new'].some((p) => path.startsWith(p)) ||
      [...document.querySelectorAll('textarea')].some((t) => t.value.trim());
    const check = async () => {
      try {
        const r = await fetch('/app-version', { cache: 'no-store' });
        const { build } = (await r.json()) as { build?: string };
        if (build && build !== 'dev' && build !== BUILD && !busy()) location.reload();
      } catch {
        /* offline: next time */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) void check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Opened from the home screen (restored, not reloaded): check once.
    const onShow = (e: PageTransitionEvent) => e.persisted && void check();
    window.addEventListener('pageshow', onShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onShow);
    };
  }, [path, call]);
  return null;
}
