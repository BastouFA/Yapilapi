'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Business } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CheckIcon,
  EmptyState,
  IconButton,
  Input,
  SearchIcon,
  CloseIcon,
  StoreIcon,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

function BusinessCard({ b }: { b: Business }) {
  const { t } = useI18n();
  return (
    <Card as="li" padding="md" className="entity-card">
      {b.coverUrl ? <img src={b.coverUrl} alt="" className="entity-card__media" /> : null}
      <Link href={`/businesses/${encodeURIComponent(b.slug)}`} className="entity-card__title">
        {b.name}
      </Link>
      <span className="entity-card__meta">
        <span>{b.category}</span>
        {b.verified ? <Badge icon={<CheckIcon size={12} />}>{t('business.verified')}</Badge> : null}
      </span>
      <span className="entity-card__meta">
        {t('business.followers', { count: b.followerCount })}
      </span>
    </Card>
  );
}

export function BusinessListView() {
  const api = useApi();
  const { t } = useI18n();
  usePageTitle(t('business.title'), t('app.name'));
  const [q, setQ] = useState('');
  const [verified, setVerified] = useState(false);

  const state = useInfinite<Business>(
    (cursor, signal) =>
      api.business.list({
        q: q || undefined,
        verified: verified || undefined,
        limit: 15,
        signal,
        ...(cursor ? { cursor } : {}),
      }),
    `${q}:${verified}`,
  );

  return (
    <>
      <PageHeader title={t('business.title')} />
      <form
        role="search"
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          state.reload();
        }}
      >
        <div className="yl-field search-input-field">
          <label htmlFor="biz-q" className="yl-sr-only">
            {t('business.searchPlaceholder')}
          </label>
          <Input
            id="biz-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('business.searchPlaceholder')}
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
        <Button type="submit" leadingIcon={<SearchIcon size={16} />}>
          {t('search.submit')}
        </Button>
      </form>
      <Checkbox
        label={t('business.filter.verified')}
        checked={verified}
        onChange={(e) => setVerified(e.target.checked)}
      />
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          icon={<StoreIcon size={28} />}
          title={t('business.emptyTitle')}
          description={t('business.emptyBody')}
        />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="card-grid">
          {state.items.map((b) => (
            <BusinessCard key={b.id} b={b} />
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
    </>
  );
}
