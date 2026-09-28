'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, List, ListItem, ProductCard, Skeleton } from '@yapilapi/design-system';
import { api, errorMessage, isGone } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { BuyButton } from '@/components/BuyButton';
import { BusinessInsights } from '@/components/BusinessInsights';
import { useSession } from '../../../providers';

export default function BusinessPage() {
  const { slug } = useParams<{ slug: string }>();
  const { locale, me, t } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.businesses.get>> | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone.
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    api.businesses.get(slug).then(setData, (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))));
  }, [slug]);
  useEffect(() => {
    load();
  }, [load]);
  if (missing) return <EmptyState title={t('bizPage.notFound')} />;
  if (!data && loadError) return <EmptyState title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!data) return <Skeleton height={240} />;
  const { business, places, products } = data;
  const [runBefore, runAfter = ''] = t('bizPage.runBy').split('{name}');
  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        <div className="row">
          <Badge tone="neutral">{business.category}</Badge>
          {business.verified ? <Badge tone="success">{t('bizPage.verified')}</Badge> : null}
        </div>
        <h1 className="profile__name">{business.name}</h1>
        {business.description ? <p style={{ margin: 0 }}>{business.description}</p> : null}
        <span className="muted">
          {runBefore}
          <Link href={`/u/${business.owner.username}`}>{business.owner.displayName}</Link>
          {runAfter}
          {business.website ? (
            <>
              {' · '}
              <a href={business.website} target="_blank" rel="noopener noreferrer nofollow">
                {t('bizPage.website')}
              </a>
            </>
          ) : null}
        </span>
      </div>
      {me?.id === business.owner.id ? <BusinessInsights businessId={business.id} /> : null}
      {places.length ? (
        <List label={t('bizPage.locations')}>
          {places.map((p) => (
            <ListItem key={p.id} href={`/places/${p.id}`} linkAs={NextLink} primary={p.name} secondary={[p.address, p.city].filter(Boolean).join(', ')} />
          ))}
        </List>
      ) : null}
      {products.length ? <h2 className="section-title">{t('bizPage.products')}</h2> : null}
      <div className="yp-grid">
        {products.map((p) => (
          <ProductCard key={p.id} product={p as never} locale={locale} action={<BuyButton productId={p.id} />} />
        ))}
      </div>
    </div>
  );
}
