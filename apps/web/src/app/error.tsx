'use client';

import { useEffect } from 'react';
import { ErrorState, AlertIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';

/** Last-resort boundary for unexpected render errors. The digest is a support reference, never a stack trace. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="center-page">
      <ErrorState
        icon={<AlertIcon size={28} />}
        title={t('error.pageTitle')}
        description={t('error.pageBody')}
        retryLabel={t('common.retry')}
        onRetry={reset}
        referenceLabel={t('error.reference')}
        requestId={error.digest ?? null}
      />
    </main>
  );
}
