'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CirclesManager } from '@/components/Circles';

function Circles() {
  const params = useSearchParams();
  return <CirclesManager initialId={params.get('id')} />;
}

/** Your circles: make them, rename them, choose who's in them. Only you see them. */
export default function CirclesPage() {
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Circles</h1>
      </div>
      <Suspense>
        <Circles />
      </Suspense>
    </div>
  );
}
