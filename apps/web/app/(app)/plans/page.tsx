'use client';

import Link from 'next/link';
import { Icon } from '@yapilapi/design-system';
import { PlansHome } from '@/components/Plans';
import { FeatureOff } from '@/components/FeatureOff';
import { useSession } from '@/app/providers';

/** Your plans (docs/product/go-out-together.md): who's free, plans coming up and earlier ones. */
export default function PlansPage() {
  const { t, flags } = useSession();
  if (flags.GO_OUT === false) return <FeatureOff name={t('plans.title')} />;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('plans.title')}</h1>
        <Link href="/plans/new" className="yp-btn yp-btn--primary yp-btn--sm">
          <Icon name="plus" size={16} /> {t('plans.make')}
        </Link>
      </div>
      <PlansHome />
    </div>
  );
}
