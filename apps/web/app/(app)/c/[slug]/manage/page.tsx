'use client';

import { useParams } from 'next/navigation';
import { CommunityManage } from '@/components/CommunityManage';

/** Community settings, for its owner, admins and moderators. */
export default function CommunityManagePage() {
  const { slug } = useParams<{ slug: string }>();
  return <CommunityManage key={slug} slug={slug} />;
}
