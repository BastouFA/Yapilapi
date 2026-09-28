'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LanguagePicker } from '@/components/LanguagePicker';
import { LegalLinks } from '@/components/Legal';
import type { MessageKey } from '@yapilapi/shared';
import { useSession } from './providers';

const JOURNEY = [
  'landing.journey.discover',
  'landing.journey.connect',
  'landing.journey.communicate',
  'landing.journey.participate',
  'landing.journey.buyBook',
  'landing.journey.experience',
  'landing.journey.remember',
] as const satisfies readonly MessageKey[];

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
            <b style={{ textTransform: 'uppercase' }}>{t('landing.new')}</b> {t('landing.eyebrow')}
          </span>
          <h1>
            {head} {tail ? <span className="grad-text">{tail}</span> : null}
          </h1>
          <p>{t('landing.intro')}</p>
          <ul className="landing__journey" aria-label={t('landing.journeyLabel')}>
            {JOURNEY.map((j) => (
              <li key={j}>{t(j)}</li>
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
            <div className="phone__bubble">{t('landing.demo.coming')}</div>
            <div className="phone__bubble phone__bubble--me">{t('landing.demo.onMyWay')}</div>
            <div className="phone__bubble">{t('landing.demo.playlist')}</div>
            <div className="phone__bubble phone__bubble--me">{t('landing.demo.onIt')}</div>
          </div>
          <div className="float-chip float-chip--1">
            <span /> {t('landing.chip.feed')}
          </div>
          <div className="float-chip float-chip--2">
            <span /> {t('landing.chip.why')}
          </div>
        </div>
      </main>
      <footer className="landing__foot site-legal">
        <LanguagePicker className="landing__lang" />
        <LegalLinks /> <span>© {new Date().getFullYear()} YAPILAPI</span>
      </footer>
    </div>
  );
}
