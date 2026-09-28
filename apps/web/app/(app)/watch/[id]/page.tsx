'use client';

import { useParams } from 'next/navigation';
import { WatchScreen } from '@/components/WatchScreen';

/** Watch together: a chat's shared video, reactions, queue and the chat beside it. */
export default function WatchPage() {
  const { id } = useParams<{ id: string }>();
  return <WatchScreen key={id} id={id} />;
}
