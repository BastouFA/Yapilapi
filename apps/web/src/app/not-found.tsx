'use client';

import Link from 'next/link';
import { EmptyState, buttonClass } from '@yapilapi/ui';
import { useI18n } from '@/i18n';

export default function NotFound() {
  const { t } = useI18n();
  return (
    <main id="main" className="center-page">
      <EmptyState
        title={t('error.notFoundTitle')}
        description={t('error.notFoundBody')}
        headingLevel={2}
        action={
          <Link href="/" className={buttonClass({ variant: 'primary' })}>
            {t('app.home')}
          </Link>
        }
      />
    </main>
  );
}
