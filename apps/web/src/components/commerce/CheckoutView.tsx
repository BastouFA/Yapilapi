'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, type ShippingAddressInput } from '@yapilapi/api-client';
import { Button, Card, FormField, Input } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';
import { PaymentMethodSelect } from './payment-method';

type Step = 'form' | 'paying' | 'processing' | 'done';

/** Buy-now checkout for a single product: creates the order (server-priced), then pays it with a provider token. */
export function CheckoutView({ productId }: { productId: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const quantity = Math.max(1, Number(params.get('qty')) || 1);
  usePageTitle(t('commerce.checkout.title'), t('app.name'));

  const product = useAsync((signal) => api.commerce.get(productId, { signal }), [api, productId]);
  const [address, setAddress] = useState<ShippingAddressInput>({
    name: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
  });
  const [paymentMethod, setPaymentMethod] = useState('tok_success');
  const [step, setStep] = useState<Step>('form');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (product.loading) return <PageSpinner />;
  if (product.error) return <ErrorView error={product.error} onRetry={product.reload} />;
  const p = product.data;
  if (!p) return null;

  const needsShipping = p.kind === 'physical';
  const subtotal = p.priceCents * quantity;
  const shipping = needsShipping ? p.delivery.shippingCents : 0;
  const tax = Math.round((subtotal * p.taxBps) / 10_000);
  const total = subtotal + shipping + tax;

  const submit = async () => {
    setError('');
    if (
      needsShipping &&
      (!address.name.trim() ||
        !address.line1.trim() ||
        !address.city.trim() ||
        !address.postalCode.trim() ||
        address.country.trim().length !== 2)
    ) {
      setError(t('commerce.checkout.errAddress'));
      return;
    }
    setStep('paying');
    try {
      const { order, held } = await api.commerce.createOrder({
        items: [{ productId, quantity }],
        ...(needsShipping
          ? { shippingAddress: { ...address, country: address.country.trim().toUpperCase() } }
          : {}),
      });
      if (held) {
        setNotice(t('commerce.checkout.held'));
        setStep('done');
        return;
      }
      const r = await api.payments.pay(order.id, { paymentMethod });
      if (r.payment.status === 'processing') {
        setNotice(t('commerce.checkout.processing'));
        setStep('processing');
      } else if (r.payment.status === 'requires_action') {
        setNotice(t('commerce.checkout.requiresAction'));
        setStep('processing');
      } else {
        setNotice(t('commerce.checkout.success'));
        setStep('done');
      }
      router.push(`/shop/orders/${encodeURIComponent(order.id)}`);
    } catch (e) {
      setStep('form');
      if (e instanceof ApiError && e.code === 'payment_failed') {
        setError(t('commerce.checkout.declined'));
      } else {
        setError(describeError(e, t).message);
      }
    }
  };

  return (
    <>
      <PageHeader title={t('commerce.checkout.title')} />
      <Card padding="lg" className="stack">
        <h2 className="section-title">{t('commerce.checkout.orderSummary')}</h2>
        <p>
          {p.title} × {quantity}
        </p>
        <dl className="stack-sm">
          <div className="button-row">
            <dt>{t('commerce.checkout.subtotal')}</dt>
            <dd>{fmt.currency(subtotal / 100, p.currency)}</dd>
          </div>
          {needsShipping ? (
            <div className="button-row">
              <dt>{t('commerce.checkout.shipping')}</dt>
              <dd>{fmt.currency(shipping / 100, p.currency)}</dd>
            </div>
          ) : null}
          {tax > 0 ? (
            <div className="button-row">
              <dt>{t('commerce.checkout.tax')}</dt>
              <dd>{fmt.currency(tax / 100, p.currency)}</dd>
            </div>
          ) : null}
          <div className="button-row">
            <dt>
              <strong>{t('commerce.checkout.total')}</strong>
            </dt>
            <dd>
              <strong>{fmt.currency(total / 100, p.currency)}</strong>
            </dd>
          </div>
        </dl>

        {needsShipping ? (
          <>
            <h2 className="section-title">{t('commerce.checkout.shippingAddress')}</h2>
            <FormField label={t('commerce.checkout.name')} required>
              <Input
                value={address.name}
                onChange={(e) => setAddress({ ...address, name: e.target.value })}
              />
            </FormField>
            <FormField label={t('commerce.checkout.line1')} required>
              <Input
                value={address.line1}
                onChange={(e) => setAddress({ ...address, line1: e.target.value })}
              />
            </FormField>
            <FormField label={t('commerce.checkout.line2')}>
              <Input
                value={address.line2}
                onChange={(e) => setAddress({ ...address, line2: e.target.value })}
              />
            </FormField>
            <FormField label={t('commerce.checkout.city')} required>
              <Input
                value={address.city}
                onChange={(e) => setAddress({ ...address, city: e.target.value })}
              />
            </FormField>
            <FormField label={t('commerce.checkout.region')}>
              <Input
                value={address.region}
                onChange={(e) => setAddress({ ...address, region: e.target.value })}
              />
            </FormField>
            <FormField label={t('commerce.checkout.postalCode')} required>
              <Input
                value={address.postalCode}
                onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
              />
            </FormField>
            <FormField label={t('commerce.checkout.country')} required>
              <Input
                value={address.country}
                maxLength={2}
                onChange={(e) => setAddress({ ...address, country: e.target.value })}
              />
            </FormField>
          </>
        ) : null}

        <p className="muted">{t('commerce.checkout.devNotice')}</p>
        <PaymentMethodSelect value={paymentMethod} onChange={setPaymentMethod} />

        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="yl-notice yl-notice--info">{notice}</p> : null}

        <div className="button-row">
          <Button
            loading={step === 'paying'}
            loadingLabel={t('commerce.checkout.paying')}
            onClick={() => void submit()}
          >
            {t('commerce.checkout.submit')}
          </Button>
        </div>
      </Card>
    </>
  );
}
