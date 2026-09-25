'use client';

import type { ReactNode } from 'react';
import { ToastProvider, UIProvider } from '@yapilapi/ui';
import { ApiProvider } from '@/lib/api';
import { PrefsProvider, usePrefs, type DisplayPrefs } from '@/lib/prefs';
import { I18nProvider, useT } from '@/i18n';
import { AppLink } from './AppLink';

function Inner({ children }: { children: ReactNode }) {
  const t = useT();
  const { prefs } = usePrefs();
  return (
    <UIProvider Link={AppLink} locale={prefs.locale}>
      <ToastProvider regionLabel={t('toast.region')} dismissLabel={t('toast.dismiss')}>
        {children}
      </ToastProvider>
    </UIProvider>
  );
}

export function Providers({
  initialPrefs,
  apiUrl,
  children,
}: {
  initialPrefs: DisplayPrefs;
  apiUrl: string;
  children: ReactNode;
}) {
  return (
    <PrefsProvider initial={initialPrefs}>
      <I18nProvider>
        <ApiProvider baseUrl={apiUrl}>
          <Inner>{children}</Inner>
        </ApiProvider>
      </I18nProvider>
    </PrefsProvider>
  );
}
