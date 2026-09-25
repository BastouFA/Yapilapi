'use client';

import { EmptyState, buttonClass } from '@yapilapi/ui';
import Link from 'next/link';
import { useT } from '@/i18n';

export function NotFoundView() {
  const t = useT();
  return (
    <main id="main" className="center-page">
      <EmptyState
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={
          <Link href="/" className={buttonClass({ variant: 'secondary' })}>
            {t('notFound.home')}
          </Link>
        }
      />
    </main>
  );
}
