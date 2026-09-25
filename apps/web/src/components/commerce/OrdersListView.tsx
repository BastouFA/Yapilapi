'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Order } from '@yapilapi/api-client';
import { Badge, Card, EmptyState, FeedTabs, StoreIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

type Tab = 'buying' | 'selling';

function OrderRow({ o }: { o: Order }) {
  const { t, fmt } = useI18n();
  return (
    <Card as="li" padding="md" className="stack-sm">
      <Link href={`/shop/orders/${encodeURIComponent(o.id)}`} className="entity-card__title">
        {t('commerce.orders.total', { amount: fmt.currency(o.totalCents / 100, o.currency) })}
      </Link>
      <span className="entity-card__meta">
        <Badge>{t(`commerce.orders.status.${o.status}`)}</Badge>
        <span>{t('commerce.orders.placedOn', { date: fmt.dateTime(o.createdAt) })}</span>
      </span>
    </Card>
  );
}

function OrdersPanel({ tab }: { tab: Tab }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<Order>(
    (cursor, signal) =>
      tab === 'buying'
        ? api.commerce.orders({ limit: 15, signal, ...(cursor ? { cursor } : {}) })
        : api.commerce.sellerOrders({ limit: 15, signal, ...(cursor ? { cursor } : {}) }),
    tab,
  );
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={<StoreIcon size={28} />}
        title={t('commerce.orders.emptyTitle')}
        description={t('commerce.orders.emptyBody')}
      />
    );
  }
  return (
    <div className="stack">
      <ul className="stack-sm" aria-label={t('commerce.orders.title')}>
        {state.items.map((o) => (
          <OrderRow key={o.id} o={o} />
        ))}
      </ul>
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </div>
  );
}

export function OrdersListView() {
  const { t } = useI18n();
  usePageTitle(t('commerce.orders.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('buying');

  return (
    <>
      <PageHeader title={t('commerce.orders.title')} />
      <FeedTabs
        label={t('commerce.orders.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'buying', label: t('commerce.orders.tab.buying') },
          { id: 'selling', label: t('commerce.orders.tab.selling') },
        ]}
      >
        <OrdersPanel key={tab} tab={tab} />
      </FeedTabs>
    </>
  );
}
