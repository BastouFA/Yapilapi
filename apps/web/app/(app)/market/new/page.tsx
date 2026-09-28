'use client';

import Link from 'next/link';
import { ListingForm } from '@/components/MarketForm';
import { useSession } from '../../../providers';

/** Sell something on Market. */
export default function NewListingPage() {
  const { t } = useSession();
  return (
    <div className="yp-shell__inner market">
      <div className="yp-topbar">
        <h1>{t('market.new.title')}</h1>
        <Link href="/market/mine" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('market.yours')}
        </Link>
      </div>
      <p className="muted market__intro">{t('market.new.intro')}</p>
      <ListingForm />
    </div>
  );
}
