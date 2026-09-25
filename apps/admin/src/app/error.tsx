'use client';

import { useEffect } from 'react';
import { AlertIcon, ErrorState } from '@yapilapi/ui';
import { useT } from '@/i18n';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  useEffect(() => {
    console.error('console error', error.digest ?? 'no-digest');
  }, [error]);
  return (
    <main id="main" className="center-page">
      <ErrorState
        icon={<AlertIcon size={28} />}
        title={t('error.crashTitle')}
        description={t('error.crashBody')}
        retryLabel={t('common.retry')}
        onRetry={reset}
        {...(error.digest ? { referenceLabel: t('error.reference'), requestId: error.digest } : {})}
      />
    </main>
  );
}
