'use client';

import { Suspense } from 'react';
import { PlanForm } from '@/components/Plans';
import { FeatureOff } from '@/components/FeatureOff';
import { useSession } from '@/app/providers';

/** Make a plan: from Create, from Wander (a place, event or stash) or from a friend who's free. */
export default function NewPlanPage() {
  const { t, flags } = useSession();
  if (flags.GO_OUT === false) return <FeatureOff name={t('plans.title')} />;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('plans.make')}</h1>
      </div>
      {/* The place, the friend or the title it starts with come in the link (?place=, ?with=, ?title=). */}
      <Suspense>
        <PlanForm />
      </Suspense>
    </div>
  );
}
