'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Product, ProductKind, Refund } from '@yapilapi/api-client';
import {
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  Select,
  StoreIcon,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';

const KINDS: ProductKind[] = ['physical', 'service', 'digital', 'booking'];
type Tab = 'products' | 'orders' | 'refunds' | 'payouts';

function ProductsPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useInfinite<Product>(
    (cursor, signal) =>
      api.commerce.myProducts({ limit: 20, signal, ...(cursor ? { cursor } : {}) }),
    'my-products',
  );
  const [kind, setKind] = useState<ProductKind>('physical');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priceCents, setPriceCents] = useState('1000');
  const [currency, setCurrency] = useState('USD');
  const [stock, setStock] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    if (!title.trim()) {
      setError(t('commerce.seller.form.title'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.commerce.create({
        kind,
        title: title.trim(),
        description: description.trim() || undefined,
        priceCents: Math.round(Number(priceCents)) || 1,
        currency,
        stock: kind === 'physical' ? Math.round(Number(stock)) || 0 : undefined,
      });
      toast.show({ tone: 'success', title: t('commerce.seller.created_toast') });
      setTitle('');
      setDescription('');
      state.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('commerce.seller.newProduct')}</h3>
        <FormField label={t('commerce.seller.form.kind')}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as ProductKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`commerce.kind.${k}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('commerce.seller.form.title')} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label={t('commerce.seller.form.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </FormField>
        <FormField label={t('commerce.seller.form.priceCents')}>
          <Input
            type="number"
            min={1}
            value={priceCents}
            onChange={(e) => setPriceCents(e.target.value)}
          />
        </FormField>
        <FormField label={t('commerce.seller.form.currency')}>
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </FormField>
        {kind === 'physical' ? (
          <FormField label={t('commerce.seller.form.stock')}>
            <Input type="number" min={0} value={stock} onChange={(e) => setStock(e.target.value)} />
          </FormField>
        ) : null}
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button loading={busy} onClick={() => void create()}>
          {t('commerce.seller.form.submit')}
        </Button>
      </Card>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((p) => (
            <li key={p.id} className="search-row">
              <Link href={`/shop/${encodeURIComponent(p.id)}`} className="search-row__text">
                <span>{p.title}</span>
                <span className="muted">
                  {fmt.currency(p.priceCents / 100, p.currency)} · {p.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OrdersPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const state = useInfinite(
    (cursor, signal) =>
      api.commerce.sellerOrders({ limit: 20, signal, ...(cursor ? { cursor } : {}) }),
    'seller-orders',
  );
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0)
    return <EmptyState icon={<StoreIcon size={28} />} title={t('commerce.orders.emptyTitle')} />;
  return (
    <ul className="stack-sm">
      {state.items.map((o) => (
        <li key={o.id} className="search-row">
          <Link href={`/shop/orders/${encodeURIComponent(o.id)}`} className="search-row__text">
            <span>{fmt.currency(o.totalCents / 100, o.currency)}</span>
            <span className="muted">{t(`commerce.orders.status.${o.status}`)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RefundsPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useInfinite<Refund>(
    (cursor, signal) =>
      api.payments.sellerRefunds({ limit: 20, signal, ...(cursor ? { cursor } : {}) }),
    'seller-refunds',
  );
  const [busy, setBusy] = useState<string | null>(null);

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
      state.reload();
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

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0)
    return <EmptyState icon={<StoreIcon size={28} />} title={t('commerce.refunds.emptyTitle')} />;
  return (
    <ul className="stack-sm">
      {state.items.map((rf) => (
        <li key={rf.id} className="search-row">
          <span className="search-row__text">
            <span>{fmt.currency(rf.amountCents / 100, rf.currency)}</span>
            <span className="muted">
              {t(`commerce.refunds.status.${rf.status}`)} · {rf.reason}
            </span>
          </span>
          {rf.status === 'requested' ? (
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
  );
}

function PayoutsPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const balance = useAsync((signal) => api.payments.balance({ signal }), [api]);
  const account = useAsync((signal) => api.payments.payoutAccount({ signal }), [api]);
  const payouts = useAsync((signal) => api.payments.payouts({ signal }), [api]);
  const [country, setCountry] = useState('US');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setUp = async () => {
    setBusy(true);
    setError('');
    try {
      await api.payments.createPayoutAccount({ country: country.trim().toUpperCase() });
      account.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  const request = async (currency: string) => {
    setBusy(true);
    try {
      await api.payments.requestPayout({ currency });
      toast.show({ tone: 'success', title: t('commerce.seller.payoutRequested_toast') });
      balance.reload();
      payouts.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  if (balance.loading || account.loading) return <PageSpinner />;
  if (balance.error) return <ErrorView error={balance.error} onRetry={balance.reload} />;

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('commerce.seller.balance')}</h3>
        {balance.data && balance.data.balances.length === 0 ? <p className="muted">—</p> : null}
        {(balance.data?.balances ?? []).map((b) => (
          <div key={b.currency} className="stack-sm">
            <p>
              {t('commerce.seller.totalOwed')}: {fmt.currency(b.totalCents / 100, b.currency)}
            </p>
            <p>
              {t('commerce.seller.available')}: {fmt.currency(b.availableCents / 100, b.currency)}
            </p>
            <p className="muted">
              {t('commerce.seller.pending', { days: balance.data!.holdDays })}:{' '}
              {fmt.currency(b.pendingCents / 100, b.currency)}
            </p>
            {account.data?.account?.kycStatus === 'verified' && b.availableCents > 0 ? (
              <Button size="sm" loading={busy} onClick={() => void request(b.currency)}>
                {t('commerce.seller.requestPayout')}
              </Button>
            ) : null}
          </div>
        ))}
      </Card>

      <Card padding="md" className="stack-sm">
        {account.data?.account ? (
          <p>{t('commerce.seller.kycStatus', { status: account.data.account.kycStatus })}</p>
        ) : (
          <>
            <p className="muted">{t('commerce.seller.payoutAccountMissing')}</p>
            <FormField label={t('commerce.checkout.country')}>
              <Input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value)} />
            </FormField>
            {error ? (
              <p className="yl-notice yl-notice--danger" role="alert">
                {error}
              </p>
            ) : null}
            <Button loading={busy} onClick={() => void setUp()}>
              {t('commerce.seller.createPayoutAccount')}
            </Button>
          </>
        )}
      </Card>

      {payouts.data && payouts.data.items.length > 0 ? (
        <ul className="stack-sm">
          {payouts.data.items.map((p) => (
            <li key={p.id} className="search-row">
              <span className="search-row__text">
                <span>{fmt.currency(p.amountCents / 100, p.currency)}</span>
                <span className="muted">{t(`commerce.seller.payoutStatus.${p.status}`)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SellerDashboardView() {
  const { t } = useI18n();
  usePageTitle(t('commerce.seller.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('products');

  return (
    <>
      <PageHeader title={t('commerce.seller.title')} lead={t('commerce.seller.lead')} />
      <FeedTabs
        label={t('commerce.seller.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'products', label: t('commerce.seller.tab.products') },
          { id: 'orders', label: t('commerce.seller.tab.orders') },
          { id: 'refunds', label: t('commerce.seller.tab.refunds') },
          { id: 'payouts', label: t('commerce.seller.tab.payouts') },
        ]}
      >
        {tab === 'products' ? <ProductsPanel key="products" /> : null}
        {tab === 'orders' ? <OrdersPanel key="orders" /> : null}
        {tab === 'refunds' ? <RefundsPanel key="refunds" /> : null}
        {tab === 'payouts' ? <PayoutsPanel key="payouts" /> : null}
      </FeedTabs>
    </>
  );
}
