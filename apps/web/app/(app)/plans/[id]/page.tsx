'use client';

import { useParams } from 'next/navigation';
import { PlanPage } from '@/components/Plans';
import { FeatureOff } from '@/components/FeatureOff';
import { useSession } from '@/app/providers';

/** One plan, for the people in it. Anyone else gets "not found". */
export default function PlanRoute() {
  const { id } = useParams<{ id: string }>();
  const { t, flags } = useSession();
  if (flags.GO_OUT === false) return <FeatureOff name={t('plans.title')} />;
  return (
    <div className="yp-shell__inner">
      <PlanPage id={id} />
    </div>
  );
}
