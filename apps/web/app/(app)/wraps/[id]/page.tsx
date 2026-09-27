'use client';

import { useParams } from 'next/navigation';
import { WrapView } from '@/components/WeeklyWrap';

/** One week's wrap: only you see it; share its card if you like. */
export default function WrapPage() {
  const { id } = useParams<{ id: string }>();
  return <WrapView id={id} />;
}
