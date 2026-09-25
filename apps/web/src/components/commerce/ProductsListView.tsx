'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Product, ProductKind } from '@yapilapi/api-client';
import {
  Badge,
  Card,
  EmptyState,
  Input,
  Select,
  StoreIcon,
  IconButton,
  CloseIcon,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

const KINDS: ProductKind[] = ['physical', 'service', 'digital', 'booking'];

export function ProductCard({ p }: { p: Product }) {
  const { t, fmt } = useI18n();
  return (
    <Card as="li" padding="md" className="entity-card">
      {p.media[0] ? <img src={p.media[0].url} alt="" className="entity-card__media" /> : null}
      <Link href={`/shop/${encodeURIComponent(p.id)}`} className="entity-card__title">
        {p.title}
      </Link>
      <span className="entity-card__meta">
        <span>{fmt.currency(p.priceCents / 100, p.currency)}</span>
        {p.status === 'sold_out' ? (
          <Badge tone="warning">{t('commerce.soldOut')}</Badge>
        ) : !p.inStock ? (
          <Badge tone="warning">{t('commerce.outOfStock')}</Badge>
        ) : null}
      </span>
      <span className="entity-card__meta">
        {p.seller.name ? <span>{t('commerce.sellerLabel', { name: p.seller.name })}</span> : null}
        {p.rating.count > 0 ? (
          <span>
            {t('commerce.rating', {
              average: fmt.number(p.rating.average, { maximumFractionDigits: 1 }),
              count: p.rating.count,
            })}
          </span>
        ) : null}
      </span>
    </Card>
  );
}

export function ProductsListView() {
  const api = useApi();
  const { t } = useI18n();
  usePageTitle(t('commerce.title'), t('app.name'));
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ProductKind | ''>('');

  const key = `list:${q}:${kind}`;
  const state = useInfinite<Product>(
    (cursor, signal) =>
      api.commerce.products({
        q: q || undefined,
        kind: kind || undefined,
        limit: 15,
        signal,
        ...(cursor ? { cursor } : {}),
      }),
    key,
  );

  return (
    <>
      <PageHeader title={t('commerce.title')} lead={t('commerce.lead')} />
      <div className="stack">
        <form
          role="search"
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            state.reload();
          }}
        >
          <div className="yl-field search-input-field">
            <label htmlFor="commerce-q" className="yl-sr-only">
              {t('commerce.searchPlaceholder')}
            </label>
            <Input
              id="commerce-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('commerce.searchPlaceholder')}
              endAdornment={
                q ? (
                  <IconButton
                    label={t('search.clear')}
                    size="sm"
                    icon={<CloseIcon size={16} />}
                    onClick={() => setQ('')}
                  />
                ) : undefined
              }
            />
          </div>
          <label htmlFor="commerce-kind" className="yl-sr-only">
            {t('commerce.filter.kind')}
          </label>
          <Select
            id="commerce-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ProductKind | '')}
          >
            <option value="">{t('commerce.filter.kind')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`commerce.kind.${k}`)}
              </option>
            ))}
          </Select>
        </form>
        {state.loading ? <PageSpinner /> : null}
        {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error && state.items.length === 0 ? (
          <EmptyState
            icon={<StoreIcon size={28} />}
            title={t('commerce.emptyTitle')}
            description={t('commerce.emptyBody')}
          />
        ) : null}
        {state.items.length > 0 ? (
          <ul className="card-grid">
            {state.items.map((p) => (
              <ProductCard key={p.id} p={p} />
            ))}
          </ul>
        ) : null}
        <InfiniteFooter
          hasMore={state.hasMore}
          loading={state.loadingMore}
          error={state.moreError}
          onLoadMore={state.loadMore}
          onRetry={state.loadMore}
        />
      </div>
    </>
  );
}
