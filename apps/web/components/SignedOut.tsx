'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { EmptyState } from '@yapilapi/design-system';

/**
 * Shared links (posts, reels, profiles, events, communities) open for people
 * without an account. These pieces give them a calm way in, and send anything
 * that needs an account (like, comment, follow, RSVP, join) to sign in first.
 */

/** Pages someone can open from a shared link without signing in. */
export function isPublicPath(path: string): boolean {
  return /^\/(p|u|c|t)\/[^/]+\/?$/.test(path) || /^\/events\/(?!new\/?$)[^/]+\/?$/.test(path) || /^\/reels\/?$/.test(path);
}

/** The current page (with its query), for coming back after signing in. Falls back to `path` on the server. */
function here(path = '/'): string {
  return typeof window === 'undefined' ? path : `${window.location.pathname}${window.location.search}`;
}

/** Sign-in link that brings the person back to this page afterwards. */
export function signInHref(path?: string): string {
  return `/login?next=${encodeURIComponent(path ?? here())}`;
}

/** Returns a function that takes the person to sign in, then back here. */
export function useSignIn(): () => void {
  const router = useRouter();
  const path = usePathname();
  return useCallback(() => router.push(signInHref(here(path))), [router, path]);
}

/** The bar at the top of a shared page for people who aren't signed in. */
export function SignedOutBar() {
  const path = usePathname();
  return (
    <header className="public-bar">
      <Link href="/" className="auth__brand">
        <img src="/mark.svg" alt="" width={28} height={28} />
        YAPILAPI
      </Link>
      <p className="public-bar__note">You're viewing this without an account.</p>
      <div className="row">
        <Link href={signInHref(here(path))} className="yp-btn yp-btn--ghost yp-btn--sm">
          Sign in
        </Link>
        <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--sm">
          Join YAPILAPI
        </Link>
      </div>
    </header>
  );
}

/** Shell for a shared page seen without an account: the bar, then the page. */
export function SignedOutShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-shell">
      <SignedOutBar />
      <main className="yp-shell__main" id="main">
        {children}
      </main>
    </div>
  );
}

/** What someone without an account sees when the link isn't public. */
export function NeedsAccount({ title, body }: { title: string; body: string }) {
  const path = usePathname();
  return (
    <div className="yp-shell__inner">
      <EmptyState
        title={title}
        body={body}
        action={
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link href={signInHref(here(path))} className="yp-btn yp-btn--primary">
              Sign in
            </Link>
            <Link href="/signup" className="yp-btn yp-btn--secondary">
              Join YAPILAPI
            </Link>
          </div>
        }
      />
    </div>
  );
}

/** A short note under public content, for people who aren't signed in. */
export function JoinNote({ text }: { text: string }) {
  const path = usePathname();
  return (
    <aside className="public-join" aria-label="Join YAPILAPI">
      <p>{text}</p>
      <div className="row">
        <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--sm">
          Join YAPILAPI
        </Link>
        <Link href={signInHref(here(path))} className="yp-btn yp-btn--ghost yp-btn--sm">
          Sign in
        </Link>
      </div>
    </aside>
  );
}
