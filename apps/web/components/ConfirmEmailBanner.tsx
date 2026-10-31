'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Icon } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';

/**
 * At the top of every page while the account still needs its email confirmed: where the link went,
 * that it unlocks posting and messaging everyone, to look in spam, and a button to send it again.
 * Coming back to the tab (after tapping the link in the mail app) checks again, so it goes away by itself.
 */
export function ConfirmEmailBanner() {
  const { me, refresh, toast, t } = useSession();
  const [busy, setBusy] = useState(false);
  const waiting = !!me?.needsVerification;

  useEffect(() => {
    if (!waiting) return;
    const back = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [waiting, refresh]);

  if (!me || !waiting) return null;
  return (
    <div className="announcement-slot">
      <section className="announcement confirm-email" role="region" aria-label={t('verifyBanner.title')}>
        <Icon name="info" />
        <div className="announcement__body">
          <strong className="announcement__title">{t('verifyBanner.title')}</strong>
          <p className="announcement__text">{t('verifyBanner.body', { email: me.email })}</p>
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.auth.resendVerification();
                  toast(t('m.verify.emailSent'));
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('m.verify.resendEmail')}
            </Button>
            <Link href="/settings/account#verification" className="yp-btn yp-btn--ghost yp-btn--sm">
              {t('m.verify.changeEmail')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
