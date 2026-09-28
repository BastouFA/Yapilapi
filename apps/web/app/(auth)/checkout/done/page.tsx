'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Skeleton } from '@yapilapi/design-system';
import { api } from '@/lib/api';
import { useSession } from '../../../providers';

/**
 * Where Paystack sends people after paying (callback_url). The order is only
 * paid once Paystack's signed webhook arrives, so this page waits for that.
 * Opened as a pop-up from checkout, it closes itself; the checkout sheet in
 * the other window shows the result.
 */
function Done() {
  const { t } = useSession();
  const reference = useSearchParams().get('reference') ?? '';
  // Our references are "ypl-<order id>".
  const orderId = /^ypl-([0-9a-f-]{36})$/.exec(reference)?.[1] ?? null;
  const [status, setStatus] = useState<'waiting' | 'paid' | 'unknown'>(orderId ? 'waiting' : 'unknown');

  useEffect(() => {
    if (!orderId) return;
    let stop = false;
    void (async () => {
      for (let i = 0; i < 60 && !stop; i++) {
        const o = await api.orders.get(orderId).catch(() => null);
        if (o?.order.status === 'paid') {
          setStatus('paid');
          if (window.opener) setTimeout(() => window.close(), 1500);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!stop) setStatus('unknown');
    })();
    return () => {
      stop = true;
    };
  }, [orderId]);

  return (
    <div className="stack">
      <h1>{t('payment.done.title')}</h1>
      {status === 'paid' ? (
        <Alert tone="success" title={t('m.drops.purchase.paid')}>
          {t('payment.done.paid')}
        </Alert>
      ) : status === 'waiting' ? (
        <>
          <Skeleton height={48} />
          <p className="muted" style={{ margin: 0 }}>
            {t('payment.done.waiting')}
          </p>
        </>
      ) : (
        <Alert tone="info">{t('payment.done.pending')}</Alert>
      )}
      <Link href="/home" className="yp-btn yp-btn--primary yp-btn--block">
        {t('onboarding.finish')}
      </Link>
    </div>
  );
}

export default function CheckoutDonePage() {
  return (
    <Suspense>
      <Done />
    </Suspense>
  );
}
