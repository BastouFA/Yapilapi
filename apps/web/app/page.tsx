'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from './providers';

const JOURNEY = ['Discover', 'Connect', 'Communicate', 'Participate', 'Buy & book', 'Experience', 'Remember'];

export default function Landing() {
  const { me, loading, t } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading && me) router.replace('/home');
  }, [loading, me, router]);

  return (
    <div className="landing">
      <header className="landing__top">
        <Link href="/" className="auth__brand">
          <img src="/mark.svg" alt="" width={28} height={28} />
          YAPILAPI
        </Link>
        <div className="row">
          <Link href="/login" className="yp-btn yp-btn--ghost">
            {t('auth.login.submit')}
          </Link>
          <Link href="/signup" className="yp-btn yp-btn--primary">
            {t('auth.signup.submit')}
          </Link>
        </div>
      </header>
      <main className="landing__hero" id="main">
        <div className="stack">
          <h1>{t('app.tagline')}</h1>
          <p>
            People, communities, events, places and the things you love, in one place you control. No endless scroll by design: you choose what your feed shows,
            and you can always see why.
          </p>
          <ul className="landing__journey" aria-label="What you can do">
            {JOURNEY.map((j) => (
              <li key={j}>{j}</li>
            ))}
          </ul>
          <div className="row">
            <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--lg">
              {t('auth.signup.title')}
            </Link>
            <Link href="/login" className="yp-btn yp-btn--secondary yp-btn--lg">
              {t('auth.login.title')}
            </Link>
          </div>
        </div>
        <div className="landing__blocks" aria-hidden>
          {Array.from({ length: 18 }, (_, i) => (
            <span key={i} style={{ gridColumn: i % 5 === 0 ? 'span 2' : undefined }} />
          ))}
        </div>
      </main>
      <footer className="landing__foot">© {new Date().getFullYear()} YAPILAPI</footer>
    </div>
  );
}
