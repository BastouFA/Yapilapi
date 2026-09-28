'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';
import { Alert, Card } from '@yapilapi/design-system';
import { LEGAL_DOCS, LEGAL_UPDATED, type LegalSlug } from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { LanguagePicker } from './LanguagePicker';

/**
 * The legal and policy pages (/legal/*): public, no sign-in. The chrome is
 * translated; the bodies are English templates (marked lang="en") that a
 * lawyer must review before launch. In development a banner says so.
 */

/** Only in development builds: these pages are templates. */
function TemplateBanner() {
  const { t, locale } = useSession();
  if (process.env.NODE_ENV === 'production') return null;
  return (
    <Alert tone="warning" locale={locale} className="legal-banner">
      {t('legal.template')}
    </Alert>
  );
}

export function LegalShell({ children }: { children: React.ReactNode }) {
  const { me, t } = useSession();
  const path = usePathname();
  return (
    <div className="public-shell legal-shell">
      <header className="public-bar">
        <Link href={me ? '/home' : '/'} className="auth__brand">
          <img src="/mark.svg" alt="" width={28} height={28} />
          YAPILAPI
        </Link>
        {me ? null : (
          <div className="row">
            <Link href="/login" className="yp-btn yp-btn--ghost yp-btn--sm">
              {t('auth.login.submit')}
            </Link>
            <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--sm">
              {t('auth.signup.title')}
            </Link>
          </div>
        )}
      </header>
      <div className="legal-layout">
        <nav className="legal-nav" aria-label={t('legal.title')}>
          <Link href="/legal" aria-current={path === '/legal' ? 'page' : undefined}>
            {t('legal.all')}
          </Link>
          {LEGAL_DOCS.map((d) => (
            <Link key={d.slug} href={`/legal/${d.slug}`} aria-current={path === `/legal/${d.slug}` ? 'page' : undefined}>
              {t(d.title)}
            </Link>
          ))}
        </nav>
        <main className="legal-main" id="main">
          <TemplateBanner />
          {children}
        </main>
      </div>
      <footer className="legal-foot">
        <LanguagePicker className="legal-foot__lang" />
        <LegalLinks /> · © {new Date().getFullYear()} YAPILAPI
      </footer>
    </div>
  );
}

/** One policy: translated title and date, a note when the reader's language isn't English, then the English text. */
export function LegalDoc({ slug, children }: { slug: LegalSlug; children: React.ReactNode }) {
  const { t, locale } = useSession();
  const doc = LEGAL_DOCS.find((d) => d.slug === slug)!;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${LEGAL_UPDATED}T00:00:00Z`));
  return (
    <div className="legal-doc">
      <h1>{t(doc.title)}</h1>
      <p className="muted">{t('legal.updated', { date })}</p>
      {locale.split('-')[0] !== 'en' ? (
        <Alert tone="info" locale={locale}>
          {t('legal.englishOnly')}
        </Alert>
      ) : null}
      <article lang="en" dir="ltr" className="legal-body">
        {children}
      </article>
    </div>
  );
}

/** The list on /legal: every policy with a one-line summary. */
export function LegalIndex() {
  const { t } = useSession();
  return (
    <div className="legal-doc">
      <h1>{t('legal.title')}</h1>
      <p className="muted">{t('legal.index.body')}</p>
      <ul className="legal-index">
        {LEGAL_DOCS.map((d) => (
          <li key={d.slug}>
            <Link href={`/legal/${d.slug}`}>{t(d.title)}</Link>
            <span className="muted">{t(d.summary)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Links for footers: the policies people look for most, then all of them. */
export function LegalLinks({ className }: { className?: string }) {
  const { t } = useSession();
  const shown = LEGAL_DOCS.filter((d) => d.slug === 'terms' || d.slug === 'privacy' || d.slug === 'guidelines' || d.slug === 'cookies');
  return (
    <span className={className}>
      {shown.map((d) => (
        <Fragment key={d.slug}>
          <Link href={`/legal/${d.slug}`} className="muted">
            {t(d.title)}
          </Link>
          {' · '}
        </Fragment>
      ))}
      <Link href="/legal" className="muted">
        {t('legal.title')}
      </Link>
    </span>
  );
}

/** "By creating an account, you accept the Terms of service and confirm you have read the Privacy policy." */
export function SignupConsent() {
  const { t } = useSession();
  const links: Record<string, React.ReactNode> = {
    terms: (
      <Link key="terms" href="/legal/terms" target="_blank">
        {t('legal.terms')}
      </Link>
    ),
    privacy: (
      <Link key="privacy" href="/legal/privacy" target="_blank">
        {t('legal.privacy')}
      </Link>
    ),
  };
  const parts = t('auth.signup.consent').split(/(\{terms\}|\{privacy\})/);
  return (
    <p className="auth__foot" style={{ margin: 0 }}>
      {parts.map((p, i) => {
        const name = /^\{(terms|privacy)\}$/.exec(p)?.[1];
        return name ? links[name] : <Fragment key={i}>{p}</Fragment>;
      })}
    </p>
  );
}

/** In Settings: every policy, with its summary. */
export function LegalCard() {
  const { t } = useSession();
  return (
    <Card title={t('legal.title')} subtitle={t('legal.index.body')}>
      <ul className="legal-index">
        {LEGAL_DOCS.map((d) => (
          <li key={d.slug}>
            <Link href={`/legal/${d.slug}`}>{t(d.title)}</Link>
            <span className="muted">{t(d.summary)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
