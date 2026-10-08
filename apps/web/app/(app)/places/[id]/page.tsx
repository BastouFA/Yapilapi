'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, EventCard, Skeleton } from '@yapilapi/design-system';
import { hoursInWeekOrder, hoursKeyLabel, PLACE_CATEGORIES, type EventItem, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { BuyButton } from '@/components/BuyButton';
import { BookTable, ManageBookings, MyBookings, PlaceReviews } from '@/components/PlaceExtras';
import { EditPlace } from '@/components/EditPlace';
import { PlayAsRadio } from '@/components/Radio';
import { ProductCard } from '@yapilapi/design-system';
import { useSession } from '../../../providers';

export default function PlacePage() {
  const { id } = useParams<{ id: string }>();
  const { locale, t, me } = useSession();
  const [booked, setBooked] = useState(0);
  const [data, setData] = useState<{ place: Record<string, any>; events: EventItem[]; products: Record<string, any>[] } | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone.
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    api.places.get(id).then(setData, (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  if (missing) return <EmptyState level={1} title={t('m.place.notFound')} />;
  if (!data && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!data) return <Skeleton height={240} />;
  const { place, events, products } = data;
  const hours = hoursInWeekOrder(place.hours);
  const category = (PLACE_CATEGORIES as readonly string[]).includes(place.category) ? t(`place.category.${place.category}` as MessageKey) : place.category;
  const mine = !!place.business?.mine;
  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        <Badge tone="neutral">{category}</Badge>
        <h1 className="profile__name">{place.name}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {[place.address, place.city, place.country].filter(Boolean).join(', ')}
        </p>
        {place.business ? <Link href={`/b/${place.business.slug}`}>{place.business.name}</Link> : null}
        {place.description ? <p style={{ margin: 0 }}>{place.description}</p> : null}
        {place.lat != null && place.lng != null ? (
          <a
            href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=17/${place.lat}/${place.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="yp-chip"
          >
            {t('m.place.openMap')}
          </a>
        ) : null}
        {/* Yap Radio: the Yaps tagged here, one after another. */}
        <div className="row">
          <PlayAsRadio station={{ kind: 'place', key: place.id }} />
        </div>
      </div>
      {hours.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('m.place.hours')}</h2>
          <table className="table">
            <tbody>
              {hours.map(([d, h]) => (
                <tr key={d}>
                  <th scope="row">{hoursKeyLabel(d, locale)}</th>
                  <td>{/^\s*closed\s*$/i.test(String(h)) ? t('place.closed') : String(h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {events.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('m.place.upcoming')}</h2>
          <div className="yp-grid">
            {events.map((e) => (
              <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
            ))}
          </div>
        </section>
      ) : null}
      {products.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('m.place.offers')}</h2>
          <div className="yp-grid">
            {products.map((p) => (
              <ProductCard key={p.id} product={p as never} locale={locale} action={<BuyButton productId={p.id} />} />
            ))}
          </div>
        </section>
      ) : null}
      {place.business && me && !mine ? (
        <>
          <BookTable placeId={place.id} hours={place.hours ?? null} onBooked={() => setBooked((n) => n + 1)} />
          <MyBookings placeId={place.id} version={booked} />
        </>
      ) : null}
      {mine ? <EditPlace key={JSON.stringify(place)} place={place} onSaved={(p) => setData({ ...data, place: p })} /> : null}
      {mine ? <ManageBookings placeId={place.id} /> : null}
      <PlaceReviews placeId={place.id} isOwner={mine} />
    </div>
  );
}
