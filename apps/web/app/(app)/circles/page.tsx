'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CirclesManager } from '@/components/Circles';
import { useSession } from '@/app/providers';

function Circles() {
  const params = useSearchParams();
  return <CirclesManager initialId={params.get('id')} />;
}

/** Your circles: make them, rename them, choose who's in them. Only you see them. */
export default function CirclesPage() {
  const { t } = useSession();
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.circles.title')}</h1>
      </div>
      <Suspense>
        <Circles />
      </Suspense>
    </div>
  );
}
