'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ToastProvider, UIProvider, type LinkProps } from '@yapilapi/ui';
import { ApiProvider } from '@/lib/api';
import { I18nProvider, useI18n, type Locale } from '@/i18n';

function AppLink({ href, ...rest }: LinkProps) {
  if (/^(https?:)?\/\//.test(href) || href.startsWith('mailto:'))
    return <a href={href} {...rest} />;
  return <Link href={href} {...rest} />;
}

function Inner({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  return (
    <UIProvider Link={AppLink} locale={locale}>
      <ToastProvider regionLabel={t('toast.region')} dismissLabel={t('toast.dismiss')}>
        {children}
      </ToastProvider>
    </UIProvider>
  );
}

export function Providers({
  apiUrl,
  locale,
  children,
}: {
  apiUrl: string;
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <I18nProvider locale={locale}>
      <ApiProvider baseUrl={apiUrl}>
        <Inner>{children}</Inner>
      </ApiProvider>
    </I18nProvider>
  );
}
