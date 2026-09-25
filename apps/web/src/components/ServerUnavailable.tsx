'use client';

import { AlertIcon, ErrorState } from '@yapilapi/ui';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n';

/** Shown when the API cannot be reached while verifying the session: never treated as "signed out". */
export function ServerUnavailable({ requestId }: { requestId: string | null }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <main id="main" className="center-page">
      <ErrorState
        icon={<AlertIcon size={28} />}
        title={t('error.unavailableTitle')}
        description={t('error.unavailableBody')}
        retryLabel={t('common.retry')}
        onRetry={() => router.refresh()}
        referenceLabel={t('error.reference')}
        requestId={requestId}
      />
    </main>
  );
}
