'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertIcon, Button, ErrorState, LockIcon } from '@yapilapi/ui';
import { useT } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAdmin } from '@/lib/session';
import type { PlatformRoleName } from '@yapilapi/api-client';
import type { ReactNode } from 'react';

/** Shown when the API cannot be reached while verifying the session: never treated as "signed out". */
export function ServerUnavailable({ requestId }: { requestId: string | null }) {
  const t = useT();
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

/** Signed in, but the account has no staff role. */
export function NotStaff() {
  const t = useT();
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const out = async () => {
    setBusy(true);
    try {
      await api.auth.logout();
    } catch {
      /* already gone */
    }
    router.replace('/login');
    router.refresh();
  };
  return (
    <main id="main" className="center-page">
      <ErrorState
        icon={<LockIcon size={28} />}
        title={t('gate.notStaffTitle')}
        description={t('gate.notStaffBody')}
      />
      <div className="center-page__action">
        <Button
          variant="secondary"
          onClick={() => void out()}
          loading={busy}
          loadingLabel={t('common.working')}
        >
          {t('nav.signOut')}
        </Button>
      </div>
    </main>
  );
}

/**
 * Page-level access gate: shows a clear "not available for your role" state instead of a page full of 403s.
 * Convenience only (the API refuses the calls regardless): it must never be the reason something is safe.
 */
export function Guard({
  permission,
  minRole,
  children,
}: {
  permission?: string;
  minRole?: PlatformRoleName;
  children: ReactNode;
}) {
  const t = useT();
  const { can, atLeast } = useAdmin();
  const allowed = (!permission || can(permission)) && (!minRole || atLeast(minRole));
  if (allowed) return <>{children}</>;
  return (
    <div className="center-page" data-testid="no-access">
      <ErrorState
        icon={<LockIcon size={28} />}
        title={t('gate.noAccessTitle')}
        description={t('gate.noAccessBody')}
      />
    </div>
  );
}
