'use client';

import { useParams } from 'next/navigation';
import { CheckInDesk } from '@/components/CheckIn';

/** Check-in at the door, for the event's host and co-hosts. */
export default function CheckInPage() {
  const { id } = useParams<{ id: string }>();
  return <CheckInDesk key={id} eventId={id} />;
}
