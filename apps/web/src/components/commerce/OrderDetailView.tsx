'use client';

import { useState } from 'react';
import { ApiError, type Order, type Refund } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  StoreIcon,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';
import { PaymentMethodSelect } from './payment-method';

const OPEN_STATUSES = new Set(['pending_review', 'pending_payment']);
const REFUNDABLE_STATUSES = new Set(['paid', 'fulfilled', 'completed', 'partially_refunded']);

function PayNowSection({ order, onPaid }: { order: Order; onPaid: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const [paymentMethod, setPaymentMethod] = useState('tok_success');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pay = async () => {
    setBusy(true);
    setError('');
    try {
      await api.payments.pay(order.id, { paymentMethod });
      onPaid();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'payment_failed'
          ? t('commerce.checkout.declined')
          : describeError(e, t).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <PaymentMethodSelect value={paymentMethod} onChange={setPaymentMethod} />
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} onClick={() => void pay()}>
        {t('commerce.checkout.submit')}
      </Button>
    </Card>
  );
}

function FulfilSection({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.commerce.fulfilOrder(orderId, {
        carrier: carrier.trim() || undefined,
        trackingNumber: trackingNumber.trim() || undefined,
        trackingUrl: trackingUrl.trim() || undefined,
      });
      toast.show({ tone: 'success', title: t('commerce.orders.fulfilled_toast') });
      onDone();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('commerce.orders.fulfil')}</h3>
      <FormField label={t('commerce.orders.carrier')}>
        <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} />
      </FormField>
      <FormField label={t('commerce.orders.trackingNumber')}>
        <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
      </FormField>
      <FormField label={t('commerce.orders.trackingUrl')}>
        <Input type="url" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} />
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} onClick={() => void submit()}>
        {t('commerce.orders.fulfil')}
      </Button>
    </Card>
  );
}

function RefundsSection({ orderId, isSeller }: { orderId: string; isSeller: boolean }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const refunds = useAsync(
    (signal) => api.payments.orderRefunds(orderId, { signal }),
    [api, orderId],
  );
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const request = async () => {
    if (!reason.trim()) {
      setError(t('commerce.refunds.reason'));
      return;
    }
    setBusy('request');
    setError('');
    try {
      await api.payments.requestRefund(orderId, {
        reason: reason.trim(),
        amountCents: amount ? Math.round(Number(amount) * 100) : undefined,
      });
      toast.show({ tone: 'success', title: t('commerce.refunds.requested_toast') });
      setReason('');
      setAmount('');
      refunds.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    setBusy(id);
    try {
      if (decision === 'approve') await api.payments.approveRefund(id);
      else await api.payments.denyRefund(id);
      toast.show({
        tone: 'success',
        title: t(
          decision === 'approve'
            ? 'commerce.refunds.approved_toast'
            : 'commerce.refunds.denied_toast',
        ),
      });
      refunds.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="refunds-h" className="stack-sm">
      <h2 id="refunds-h" className="section-title">
        {t('commerce.refunds.title')}
      </h2>
      {refunds.error ? <ErrorView error={refunds.error} onRetry={refunds.reload} /> : null}
      {refunds.data && refunds.data.items.length === 0 ? (
        <p className="muted">{t('commerce.refunds.emptyTitle')}</p>
      ) : null}
      {refunds.data && refunds.data.items.length > 0 ? (
        <ul className="stack-sm">
          {refunds.data.items.map((rf: Refund) => (
            <li key={rf.id} className="search-row">
              <span className="search-row__text">
                <span>{fmt.currency(rf.amountCents / 100, rf.currency)}</span>
                <span className="muted">
                  {t(`commerce.refunds.status.${rf.status}`)} · {rf.reason}
                </span>
              </span>
              {isSeller && rf.status === 'requested' ? (
                <span className="button-row">
                  <Button
                    size="sm"
                    loading={busy === rf.id}
                    onClick={() => void decide(rf.id, 'approve')}
                  >
                    {t('commerce.refunds.approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === rf.id}
                    onClick={() => void decide(rf.id, 'deny')}
                  >
                    {t('commerce.refunds.deny')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!isSeller ? (
        <Card padding="md" className="stack-sm">
          <h3 className="section-title">{t('commerce.refunds.request')}</h3>
          <FormField label={t('commerce.refunds.reason')} required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </FormField>
          <FormField label={t('commerce.refunds.amount')}>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          {error ? (
            <p className="yl-notice yl-notice--danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button loading={busy === 'request'} onClick={() => void request()}>
            {t('commerce.refunds.submit')}
          </Button>
        </Card>
      ) : null}
    </section>
  );
}

export function OrderDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const order = useAsync((signal) => api.commerce.getOrder(id, { signal }), [api, id]);
  usePageTitle(t('commerce.orders.title'), t('app.name'));

  if (order.loading) return <PageSpinner />;
  if (order.error) {
    if (order.error instanceof ApiError && order.error.status === 404) {
      return <EmptyState icon={<StoreIcon size={28} />} title={t('commerce.orders.notFound')} />;
    }
    return <ErrorView error={order.error} onRetry={order.reload} />;
  }
  const o = order.data;
  if (!o) return null;
  // The API's order view omits `buyer` entirely for the buyer themselves, and always includes it (even as just an id)
  // for anyone else who may see the order (seller or staff) — see orderViews() in commerce/orders.ts.
  const isSeller = o.buyer !== undefined;

  const run = async (fn: () => Promise<unknown>, okMessage?: string) => {
    try {
      await fn();
      order.reload();
      if (okMessage) toast.show({ tone: 'success', title: okMessage });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  return (
    <>
      <PageHeader
        title={t('commerce.orders.total', { amount: fmt.currency(o.totalCents / 100, o.currency) })}
      />
      <div className="event-detail__head">
        <div className="stack-sm">
          <Badge>{t(`commerce.orders.status.${o.status}`)}</Badge>
          <span>{t('commerce.orders.placedOn', { date: fmt.dateTime(o.createdAt) })}</span>
          {isSeller && o.buyer ? (
            <span>{t('commerce.orders.buyer', { name: o.buyer.displayName ?? o.buyer.id })}</span>
          ) : null}
          {o.heldForReview ? (
            <p className="yl-notice yl-notice--warning">{t('commerce.orders.heldForReview')}</p>
          ) : null}
        </div>
        <div className="button-row">
          {!isSeller && OPEN_STATUSES.has(o.status) ? (
            <Button
              variant="ghost"
              onClick={() =>
                void run(() => api.commerce.cancelOrder(o.id), t('commerce.orders.cancelled_toast'))
              }
            >
              {t('commerce.orders.cancel')}
            </Button>
          ) : null}
          {!isSeller && (o.status === 'fulfilled' || o.status === 'partially_refunded') ? (
            <Button
              onClick={() =>
                void run(
                  () => api.commerce.completeOrder(o.id),
                  t('commerce.orders.completed_toast'),
                )
              }
            >
              {t('commerce.orders.complete')}
            </Button>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="items-h" className="stack-sm">
        <h2 id="items-h" className="section-title">
          {t('commerce.orders.itemsTitle')}
        </h2>
        <ul className="stack-sm">
          {o.items.map((it) => (
            <li key={it.id} className="search-row">
              <span className="search-row__text">
                <span>
                  {it.title} × {it.quantity}
                </span>
                <span className="muted">{fmt.currency(it.lineTotalCents / 100, o.currency)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {o.shippingAddress ? (
        <section aria-labelledby="addr-h" className="stack-sm">
          <h2 id="addr-h" className="section-title">
            {t('commerce.orders.shippingAddress')}
          </h2>
          <p>
            {o.shippingAddress.name}
            <br />
            {o.shippingAddress.line1}
            {o.shippingAddress.line2 ? (
              <>
                <br />
                {o.shippingAddress.line2}
              </>
            ) : null}
            <br />
            {o.shippingAddress.city} {o.shippingAddress.postalCode}
            <br />
            {o.shippingAddress.country}
          </p>
        </section>
      ) : null}

      {o.tracking ? (
        <section aria-labelledby="track-h" className="stack-sm">
          <h2 id="track-h" className="section-title">
            {t('commerce.orders.tracking')}
          </h2>
          <p>
            {o.tracking.carrier} {o.tracking.trackingNumber}
          </p>
        </section>
      ) : null}

      {!isSeller && o.status === 'pending_payment' ? (
        <PayNowSection order={o} onPaid={() => order.reload()} />
      ) : null}

      {isSeller && (o.status === 'paid' || o.status === 'partially_refunded') ? (
        <FulfilSection orderId={o.id} onDone={() => order.reload()} />
      ) : null}

      {REFUNDABLE_STATUSES.has(o.status) ? (
        <RefundsSection orderId={o.id} isSeller={isSeller} />
      ) : null}
    </>
  );
}
