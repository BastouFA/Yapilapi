'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, EmptyState, List, ListItem, ProductCard, Skeleton } from '@yapilapi/design-system';
import { api } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { BuyButton } from '@/components/BuyButton';
import { useSession } from '../../../providers';

export default function BusinessPage() {
  const { slug } = useParams<{ slug: string }>();
  const { locale } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.businesses.get>> | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api.businesses.get(slug).then(setData, () => setMissing(true));
  }, [slug]);
  if (missing) return <EmptyState title="Business not found" />;
  if (!data) return <Skeleton height={240} />;
  const { business, places, products } = data;
  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        <div className="row">
          <Badge tone="neutral">{business.category}</Badge>
          {business.verified ? <Badge tone="success">Verified</Badge> : null}
        </div>
        <h1 className="profile__name">{business.name}</h1>
        {business.description ? <p style={{ margin: 0 }}>{business.description}</p> : null}
        <span className="muted">
          Run by <Link href={`/u/${business.owner.username}`}>{business.owner.displayName}</Link>
          {business.website ? (
            <>
              {' · '}
              <a href={business.website} target="_blank" rel="noopener noreferrer nofollow">
                Website
              </a>
            </>
          ) : null}
        </span>
      </div>
      {places.length ? (
        <List label="Locations">
          {places.map((p) => (
            <ListItem key={p.id} href={`/places/${p.id}`} linkAs={NextLink} primary={p.name} secondary={[p.address, p.city].filter(Boolean).join(', ')} />
          ))}
        </List>
      ) : null}
      <div className="yp-grid">
        {products.map((p) => (
          <ProductCard key={p.id} product={p as never} locale={locale} action={<BuyButton productId={p.id} />} />
        ))}
      </div>
    </div>
  );
}
