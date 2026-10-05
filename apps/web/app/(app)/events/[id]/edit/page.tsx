'use client';

import { useParams } from 'next/navigation';
import { EventForm } from '@/components/EventForm';

/** The host changes an event. */
export default function EditEventPage() {
  const { id } = useParams<{ id: string }>();
  return <EventForm key={id} eventId={id} />;
}
