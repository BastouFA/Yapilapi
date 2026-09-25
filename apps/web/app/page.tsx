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

  // "Your social world. One place." → second sentence gets the brand gradient.
  const [head, tail] = t('app.tagline').split(/(?<=\.)\s+/);

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
        <div className="stack" style={{ gap: 'var(--space-6)' }}>
          <span className="landing__eyebrow">
            <b>NEW</b> Live, Real Together and Mini Apps
          </span>
          <h1>
            {head} {tail ? <span className="grad-text">{tail}</span> : null}
          </h1>
          <p>
            People, communities, events, places and the things you love, in one place you control. No endless scroll by design: you choose what your feed shows,
            and you can always see why.
          </p>
          <ul className="landing__journey" aria-label="What you can do">
            {JOURNEY.map((j) => (
              <li key={j}>{j}</li>
            ))}
          </ul>
          <div className="row" style={{ gap: 'var(--space-3)' }}>
            <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--lg">
              {t('auth.signup.title')}
            </Link>
            <Link href="/login" className="yp-btn yp-btn--secondary yp-btn--lg">
              {t('auth.login.title')}
            </Link>
          </div>
        </div>
        <div className="landing__stage" aria-hidden>
          <div className="phone phone--a">
            <div className="phone__row">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i} className="phone__ring">
                  <i />
                </span>
              ))}
            </div>
            <div className="phone__card">
              <div className="phone__line" style={{ width: '55%' }} />
              <div className="phone__img" />
              <div className="phone__line" style={{ width: '85%' }} />
              <div className="phone__line" style={{ width: '60%' }} />
            </div>
            <div className="phone__card">
              <div className="phone__line" style={{ width: '40%' }} />
              <div className="phone__img phone__img--2" />
            </div>
          </div>
          <div className="phone phone--b">
            <div className="phone__live" />
            <div className="phone__bubble">Are you coming tonight?</div>
            <div className="phone__bubble phone__bubble--me">On my way, saving you a seat</div>
            <div className="phone__bubble">Bring the playlist</div>
            <div className="phone__bubble phone__bubble--me">Already on it</div>
          </div>
          <div className="float-chip float-chip--1">
            <span /> You choose your feed
          </div>
          <div className="float-chip float-chip--2">
            <span /> See why every post is here
          </div>
        </div>
      </main>
      <footer className="landing__foot">© {new Date().getFullYear()} YAPILAPI</footer>
    </div>
  );
}
