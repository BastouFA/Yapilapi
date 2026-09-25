'use client';

import type { ReactNode } from 'react';
import { Logo, SkipLink, useUI } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { LocaleMenu, ThemeMenu } from './Menus';

export function AuthFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { Link } = useUI();
  return (
    <div className="auth">
      <SkipLink href="#main">{t('a11y.skip')}</SkipLink>
      <aside className="auth__brand" data-lowbw="hide">
        <div className="auth__brand-inner">
          <Logo name={t('app.name')} size={44} />
          <p className="auth__tagline">{t('app.tagline')}</p>
          <p className="auth__pitch">{t('app.pitch')}</p>
          <ul className="auth__points">
            <li>{t('auth.point1')}</li>
            <li>{t('auth.point2')}</li>
            <li>{t('auth.point3')}</li>
          </ul>
        </div>
      </aside>
      <div className="auth__col">
        <header className="auth__top">
          <Link href="/" className="auth__logo" aria-label={t('app.home')}>
            <Logo name={t('app.name')} size={30} />
          </Link>
          <div className="auth__prefs">
            <LocaleMenu />
            <ThemeMenu />
          </div>
        </header>
        <main id="main" className="auth__main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
