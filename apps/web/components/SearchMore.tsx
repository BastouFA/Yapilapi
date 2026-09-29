'use client';

import { Button, EmptyState, List, ListItem, ProductCard } from '@yapilapi/design-system';
import { BuyButton } from '@/components/BuyButton';
import { NextLink } from '@/lib/link';
import { useSession } from '@/app/providers';

export type PlaceResult = { id: string; name: string; category: string; city: string | null };
export type BusinessResult = { id: string; slug: string; name: string; category: string | null; description: string | null };
export type ProductResult = { id: string; kind: string; title: string; priceCents: number; currency: string };

/** Places, businesses and products a search found (shared by Wander and Search). */
export function MoreResults({ places, businesses, products }: { places: PlaceResult[]; businesses: BusinessResult[]; products: ProductResult[] }) {
  const { t, locale } = useSession();
  return (
    <>
      {places.length ? (
        <section className="stack-sm" aria-labelledby="res-places">
          <h2 id="res-places" className="section-title">
            {t('discover.places')}
          </h2>
          <List>
            {places.map((p) => (
              <ListItem key={p.id} href={`/places/${p.id}`} linkAs={NextLink} primary={p.name} secondary={[p.category, p.city].filter(Boolean).join(' · ')} />
            ))}
          </List>
        </section>
      ) : null}
      {businesses.length ? (
        <section className="stack-sm" aria-labelledby="res-businesses">
          <h2 id="res-businesses" className="section-title">
            {t('discover.businesses')}
          </h2>
          <List>
            {businesses.map((b) => (
              <ListItem key={b.id} href={`/b/${b.slug}`} linkAs={NextLink} primary={b.name} secondary={b.category ?? undefined} />
            ))}
          </List>
        </section>
      ) : null}
      {products.length ? (
        <section className="stack-sm" aria-labelledby="res-products">
          <h2 id="res-products" className="section-title">
            {t('discover.products')}
          </h2>
          <div className="yp-grid">
            {products.map((p) => (
              <ProductCard key={p.id} product={{ ...p, inventory: null }} locale={locale} action={<BuyButton productId={p.id} />} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

/** A search that didn't go through, with Try again. */
export function SearchFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useSession();
  return <EmptyState title={message} action={<Button onClick={onRetry}>{t('m.common.retry')}</Button>} />;
}
