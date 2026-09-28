'use client';

import { useParams } from 'next/navigation';
import { EchoComposer } from '@/components/Echo';

/** Echo a reel: answer it with your own video, the two shown together in a new reel. */
export default function EchoPage() {
  const { id } = useParams<{ id: string }>();
  return <EchoComposer key={id} postId={id} />;
}
