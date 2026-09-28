'use client';

import { useParams } from 'next/navigation';
import { RoomView } from '@/components/RoomView';

/** A live audio room in a community. The audio itself stays with RoomsProvider, so it keeps playing on other pages. */
export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  return <RoomView id={id} />;
}
