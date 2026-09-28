'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState, Skeleton } from '@yapilapi/design-system';
import type { MarketListing } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { ListingForm } from '@/components/MarketForm';
import { useSession } from '../../../../providers';

/** Change one of your listings. */
export default function EditListingPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useSession();
  const [listing, setListing] = useState<MarketListing | null | 'missing'>(null);
  useEffect(() => {
    api.market.get(id).then(
      (r) => setListing(r.listing.mine ? r.listing : 'missing'),
      () => setListing('missing'),
    );
  }, [id]);
  return (
    <div className="yp-shell__inner market">
      <div className="yp-topbar">
        <h1>{t('market.edit.title')}</h1>
      </div>
      {listing === null ? (
        <Skeleton height={320} />
      ) : listing === 'missing' ? (
        <EmptyState title={t('market.listing.missing')} body={t('market.listing.missingBody')} />
      ) : (
        <ListingForm listing={listing} />
      )}
    </div>
  );
}
