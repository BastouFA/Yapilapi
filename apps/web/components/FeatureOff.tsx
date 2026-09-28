'use client';

import { EmptyState } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

/** Full-page state for a feature that isn't switched on yet, with the page's own heading. */
export function FeatureOff({ name }: { name: string }) {
  const { t } = useSession();
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{name}</h1>
      </div>
      <EmptyState title={t('featureOff.title', { name })} body={t('featureOff.body')} />
    </div>
  );
}
