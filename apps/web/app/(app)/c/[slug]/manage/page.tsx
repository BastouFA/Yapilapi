'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CommunityManage } from '@/components/CommunityManage';

function Manage() {
  const { slug } = useParams<{ slug: string }>();
  return <CommunityManage key={slug} slug={slug} initialSection={useSearchParams().get('tab')} />;
}

/** Community settings, for its owner, admins and moderators (`?tab=requests` opens a section). */
export default function CommunityManagePage() {
  return (
    <Suspense>
      <Manage />
    </Suspense>
  );
}
