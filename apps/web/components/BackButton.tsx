'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Icon } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

/** Pages visited in the app since it loaded: with none, Back would leave YAPILAPI, so it goes up instead. */
let moves = 0;

/**
 * Back to where you came from, or to `fallback` when the page was opened directly from a link
 * (then there's no page of ours to go back to).
 */
export function BackButton({ fallback = '/home' }: { fallback?: string }) {
  const router = useRouter();
  const { t } = useSession();
  return (
    <button type="button" className="yp-btn yp-btn--ghost yp-btn--sm back-button" onClick={() => (moves > 0 ? router.back() : router.push(fallback))}>
      <Icon name="arrow-left" size={18} />
      {t('m.common.back')}
    </button>
  );
}

/** The main tabs: you arrive at them from the navigation, so there's nothing to go back to. */
const ROOTS = new Set(['/', '/home', '/discover', '/inbox', '/search', '/onboarding']);
/** Full-screen views and pages that draw their own back or close control. */
const OWN_BACK = [/^\/reels$/, /^\/inbox\/./, /^\/yap(\/|$)/, /^\/s\//, /^\/camera/, /^\/watch\//, /^\/live\/./, /^\/rooms\//, /^\/together\/./, /^\/wraps\/./];
/** Pages that list things: where "up" goes when there's no history (an item's page goes to its list). */
const LISTS = [
  '/admin',
  '/archive',
  '/circles',
  '/squads',
  '/communities',
  '/drafts',
  '/drops',
  '/events',
  '/legal',
  '/live',
  '/market',
  '/memories',
  '/mixes',
  '/notifications',
  '/questions',
  '/recaps',
  '/saved',
  '/settings',
  '/studio',
  '/tickets',
  '/together',
  '/wraps',
];
/** Items whose list isn't their first path segment. */
const UP: [RegExp, string][] = [
  [/^\/admin$/, '/settings'],
  [/^\/(p|b|chapters|places|boards)\//, '/home'],
  [/^\/(u|t)\//, '/discover'],
  [/^\/c\//, '/communities'],
  [/^\/(sounds|music|reels)\//, '/reels'],
];

/** Where Back goes when there's no page of ours to return to: the nearest list above this page. */
export function upFrom(path: string): string {
  for (const [re, to] of UP) if (re.test(path)) return to;
  const parts = path.split('/').filter(Boolean);
  for (let n = parts.length - 1; n > 0; n--) {
    const parent = `/${parts.slice(0, n).join('/')}`;
    if (LISTS.includes(parent)) return parent;
  }
  return '/home';
}

/**
 * The Back button at the top of every page that isn't a main tab, so nothing you open is a dead end.
 * Your own profile counts as a tab.
 */
export function PageBack() {
  const path = usePathname() ?? '/';
  const { me } = useSession();
  // Counts moves between pages (the shell stays mounted while pages change). Compared with the
  // last path rather than "not the first run", so effects that run twice don't count a move.
  const last = useRef(path);
  useEffect(() => {
    if (last.current === path) return;
    last.current = path;
    moves++;
  }, [path]);
  if (ROOTS.has(path) || OWN_BACK.some((re) => re.test(path))) return null;
  if (me && path === `/u/${me.username}`) return null;
  return (
    <div className="page-back">
      <BackButton fallback={upFrom(path)} />
    </div>
  );
}
