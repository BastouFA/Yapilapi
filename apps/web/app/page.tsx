'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LanguagePicker } from '@/components/LanguagePicker';
import { LegalLinks } from '@/components/Legal';
import { Icon, type IconName } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';
import { useSession } from './providers';

/** What the landing page says YAPILAPI is, in order: voice first, then what's built on it. */
const FEATURES = [
  { icon: 'mic', title: 'landing.talk.title', body: 'landing.talk.body' },
  { icon: 'globe', title: 'landing.languages.title', body: 'landing.languages.body' },
  { icon: 'signal', title: 'landing.data.title', body: 'landing.data.body' },
  { icon: 'volume', title: 'landing.radio.title', body: 'landing.radio.body' },
  { icon: 'map-pin', title: 'landing.city.title', body: 'landing.city.body' },
  { icon: 'repost', title: 'landing.mic.title', body: 'landing.mic.body' },
  { icon: 'users', title: 'landing.squads.title', body: 'landing.squads.body' },
] as const satisfies readonly { icon: IconName; title: MessageKey; body: MessageKey }[];

/** Loudness bars for the illustrated Yaps (no real recording behind them). */
const WAVE = [30, 52, 78, 46, 92, 64, 38, 70, 100, 58, 34, 74, 88, 50, 28, 62, 84, 44, 66, 36, 54, 80, 42, 26];

export default function Landing() {
  const { me, loading, t } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading && me) router.replace('/home');
  }, [loading, me, router]);

  // "Speak. The world understands." → the second sentence gets the brand gradient (the full stop
  // may be a language's own: 。 ۔ । ።).
  const [head, tail] = t('app.tagline').split(/(?<=[.。۔।።])\s+/);

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
      <main className="landing__main" id="main">
        <div className="landing__hero">
          <div className="stack" style={{ gap: 'var(--space-6)' }}>
            <span className="landing__eyebrow">
              <b aria-hidden>
                <Icon name="mic" size={14} />
              </b>
              {t('landing.eyebrow')}
            </span>
            <h1>
              {head} {tail ? <span className="grad-text">{tail}</span> : null}
            </h1>
            <p>{t('landing.intro')}</p>
            <div className="row" style={{ gap: 'var(--space-3)' }}>
              <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--lg">
                {t('auth.signup.title')}
              </Link>
              <Link href="/login" className="yp-btn yp-btn--secondary yp-btn--lg">
                {t('auth.login.title')}
              </Link>
            </div>
          </div>
          {/* Illustration only: two phones playing Yaps, with their words written out. */}
          <div className="landing__stage" aria-hidden>
            <div className="phone phone--a">
              <div className="phone__row">
                {Array.from({ length: 4 }, (_, i) => (
                  <span key={i} className="phone__ring">
                    <i />
                  </span>
                ))}
              </div>
              {[t('landing.demo.coming'), t('landing.demo.playlist')].map((words, i) => (
                <div key={i} className="phone__card">
                  <div className="phone__line" style={{ width: i ? '40%' : '55%' }} />
                  <div className="phone__yap">
                    <span className="phone__play" />
                    <span className="phone__wave">
                      {WAVE.slice(i * 4, i * 4 + 20).map((h, j) => (
                        <i key={j} style={{ height: `${h}%` }} />
                      ))}
                    </span>
                  </div>
                  <div className="phone__words">{words}</div>
                </div>
              ))}
            </div>
            <div className="phone phone--b">
              <div className="phone__live" />
              {[t('landing.demo.onMyWay'), t('landing.demo.onIt')].map((words, i) => (
                <div key={i} className={i ? 'phone__bubble phone__bubble--me' : 'phone__bubble'}>
                  <span className="phone__wave phone__wave--sm">
                    {WAVE.slice(i * 6, i * 6 + 14).map((h, j) => (
                      <i key={j} style={{ height: `${h}%` }} />
                    ))}
                  </span>
                  {words}
                </div>
              ))}
            </div>
            <div className="float-chip float-chip--1">
              <span /> {t('landing.chip.feed')}
            </div>
            <div className="float-chip float-chip--2">
              <span /> {t('landing.chip.why')}
            </div>
          </div>
        </div>
        <section className="landing__features" aria-labelledby="landing-features">
          <h2 id="landing-features" className="landing__features-title">
            {t('landing.journeyLabel')}
          </h2>
          <ul>
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="landing__feature-icon" aria-hidden>
                  <Icon name={f.icon} size={22} />
                </span>
                <h3>{t(f.title)}</h3>
                <p>{t(f.body)}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <footer className="landing__foot site-legal">
        <LanguagePicker className="landing__lang" />
        <LegalLinks /> <span>© {new Date().getFullYear()} YAPILAPI</span>
      </footer>
    </div>
  );
}
