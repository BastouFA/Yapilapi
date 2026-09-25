'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, EmptyState, EventCard, Skeleton } from '@yapilapi/design-system';
import type { EventItem } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { BuyButton } from '@/components/BuyButton';
import { BookTable, ManageBookings, PlaceReviews } from '@/components/PlaceExtras';
import { ProductCard } from '@yapilapi/design-system';
import { useSession } from '../../../providers';

export default function PlacePage() {
  const { id } = useParams<{ id: string }>();
  const { locale } = useSession();
  const [data, setData] = useState<{ place: Record<string, any>; events: EventItem[]; products: Record<string, any>[] } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api.places.get(id).then(setData, () => setMissing(true));
  }, [id]);
  if (missing) return <EmptyState title="Place not found" />;
  if (!data) return <Skeleton height={240} />;
  const { place, events, products } = data;
  const hours = Object.entries(place.hours ?? {}) as [string, string][];
  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        <Badge tone="neutral">{place.category}</Badge>
        <h1 className="profile__name">{place.name}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {[place.address, place.city, place.country].filter(Boolean).join(', ')}
        </p>
        {place.business ? <Link href={`/b/${place.business.slug}`}>{place.business.name}</Link> : null}
        {place.description ? <p style={{ margin: 0 }}>{place.description}</p> : null}
        {place.lat && place.lng ? (
          <a
            href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=17/${place.lat}/${place.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="yp-chip"
          >
            Open in map
          </a>
        ) : null}
      </div>
      {hours.length ? (
        <section className="stack-sm">
          <h2 className="section-title">Hours</h2>
          <table className="table">
            <tbody>
              {hours.map(([d, h]) => (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  <td>{h}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {events.length ? (
        <section className="stack-sm">
          <h2 className="section-title">Upcoming here</h2>
          <div className="yp-grid">
            {events.map((e) => (
              <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
            ))}
          </div>
        </section>
      ) : null}
      {products.length ? (
        <section className="stack-sm">
          <h2 className="section-title">Menu, products and bookings</h2>
          <div className="yp-grid">
            {products.map((p) => (
              <ProductCard key={p.id} product={p as never} locale={locale} action={<BuyButton productId={p.id} />} />
            ))}
          </div>
        </section>
      ) : null}
      {place.business ? <BookTable placeId={place.id} /> : null}
      <ManageBookings placeId={place.id} />
      <PlaceReviews placeId={place.id} />
    </div>
  );
}
