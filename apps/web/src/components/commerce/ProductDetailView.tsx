'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type ProductReview } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
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
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

function ReviewRow({ r }: { r: ProductReview }) {
  const { t, fmt } = useI18n();
  return (
    <li className="stack-sm">
      <div className="person-row">
        <Avatar name={r.author.displayName} size="sm" decorative />
        <span className="person-row__text">{r.author.displayName}</span>
        {r.verifiedPurchase ? <Badge>{t('commerce.verifiedPurchase')}</Badge> : null}
      </div>
      <p>
        {'★'.repeat(r.rating)} · {fmt.dateTime(r.createdAt)}
      </p>
      {r.body ? <p>{r.body}</p> : null}
    </li>
  );
}

function ReviewsSection({ id, canReview }: { id: string; canReview: boolean }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useInfinite<ProductReview>(
    (cursor, signal) =>
      api.commerce.reviews(id, { limit: 20, signal, ...(cursor ? { cursor } : {}) }),
    'reviews',
  );
  const [rating, setRating] = useState('5');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await api.commerce.review(id, { rating: Number(rating), body: body.trim() || undefined });
      setBody('');
      toast.show({ tone: 'success', title: t('commerce.reviewSubmitted') });
      state.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="reviews-h" className="stack-sm">
      <h2 id="reviews-h" className="section-title">
        {t('commerce.reviewsTitle')}
      </h2>
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <p className="muted">{t('commerce.reviewsEmpty')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((r) => (
            <ReviewRow key={r.id} r={r} />
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
      {canReview ? (
        <Card padding="md" className="stack-sm">
          <h3 className="section-title">{t('commerce.writeReview')}</h3>
          <FormField label={t('commerce.reviewRating')}>
            <Select value={rating} onChange={(e) => setRating(e.target.value)}>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('commerce.reviewBody')}>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
          </FormField>
          {error ? (
            <p className="yl-notice yl-notice--danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button loading={busy} onClick={() => void submit()}>
            {t('commerce.reviewSubmit')}
          </Button>
        </Card>
      ) : null}
    </section>
  );
}

export function ProductDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const router = useRouter();
  const product = useAsync((signal) => api.commerce.get(id, { signal }), [api, id]);
  usePageTitle(product.data?.title, t('app.name'));

  const buyNow = () => {
    router.push(`/shop/checkout/${encodeURIComponent(id)}`);
  };

  if (product.loading) return <PageSpinner />;
  if (product.error) {
    if (product.error instanceof ApiError && product.error.status === 404) {
      return <EmptyState icon={<StoreIcon size={28} />} title={t('commerce.notFound')} />;
    }
    return <ErrorView error={product.error} onRetry={product.reload} />;
  }
  const p = product.data;
  if (!p) return null;
  const canBuy = !p.viewer.isSeller && p.status === 'active' && p.inStock;

  return (
    <>
      <PageHeader title={p.title} />
      {p.media[0] ? <img src={p.media[0].url} alt="" className="event-detail__cover" /> : null}
      <div className="event-detail__head">
        <div className="stack-sm">
          <span>{fmt.currency(p.priceCents / 100, p.currency)}</span>
          {p.seller.name ? <span>{t('commerce.sellerLabel', { name: p.seller.name })}</span> : null}
          {p.status === 'sold_out' ? (
            <Badge tone="warning">{t('commerce.soldOut')}</Badge>
          ) : p.inStock ? (
            <Badge>
              {typeof p.stock === 'number'
                ? t('commerce.stockRemaining', { count: p.stock })
                : t('commerce.inStock')}
            </Badge>
          ) : (
            <Badge tone="warning">{t('commerce.outOfStock')}</Badge>
          )}
          {p.rating.count > 0 ? (
            <span>
              {t('commerce.rating', {
                average: fmt.number(p.rating.average, { maximumFractionDigits: 1 }),
                count: p.rating.count,
              })}
            </span>
          ) : null}
        </div>
        <div className="button-row">
          {p.viewer.isSeller ? (
            <Badge>{t('commerce.viewerIsSeller')}</Badge>
          ) : canBuy ? (
            <Button onClick={buyNow}>{t('commerce.buyNow')}</Button>
          ) : null}
        </div>
      </div>

      {p.description ? <p>{p.description}</p> : null}
      {p.kind === 'digital' ? <p className="muted">{t('commerce.digitalNotice')}</p> : null}
      {p.returnsPolicy ? (
        <section aria-labelledby="returns-h" className="stack-sm">
          <h2 id="returns-h" className="section-title">
            {t('commerce.returnsPolicy')}
          </h2>
          <p>{p.returnsPolicy}</p>
        </section>
      ) : null}

      <ReviewsSection id={id} canReview={p.viewer.hasPurchased && !p.viewer.isSeller} />
    </>
  );
}
