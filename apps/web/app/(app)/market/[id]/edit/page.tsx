'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Skeleton } from '@yapilapi/design-system';
import type { MarketListing } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { ListingForm } from '@/components/MarketForm';
import { useSession } from '../../../../providers';

/** Change one of your listings. */
export default function EditListingPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useSession();
  const [listing, setListing] = useState<MarketListing | null | 'missing'>(null);
  // Why it couldn't load, when that isn't because it's gone.
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    api.market.get(id).then(
      (r) => setListing(r.listing.mine ? r.listing : 'missing'),
      (e) => (isGone(e) ? setListing('missing') : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="yp-shell__inner market">
      <div className="yp-topbar">
        <h1>{t('market.edit.title')}</h1>
      </div>
      {listing === null && loadError ? (
        <EmptyState title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />
      ) : listing === null ? (
        <Skeleton height={320} />
      ) : listing === 'missing' ? (
        <EmptyState title={t('market.listing.missing')} body={t('market.listing.missingBody')} />
      ) : (
        <ListingForm listing={listing} />
      )}
    </div>
  );
}
