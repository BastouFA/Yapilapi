'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { EventForm } from '@/components/EventForm';

function NewEvent() {
  return <EventForm communityId={useSearchParams().get('community')} />;
}

/** Make an event (`?community=` makes it a community's event). */
export default function NewEventPage() {
  return (
    <Suspense>
      <NewEvent />
    </Suspense>
  );
}
