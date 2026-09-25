'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState, EventCard, Segments, Skeleton } from '@yapilapi/design-system';
import type { EventItem } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

type Scope = 'upcoming' | 'now' | 'going' | 'hosting';
const EMPTY: Record<Scope, string> = {
  upcoming: 'No upcoming events you can see yet.',
  now: 'Nothing is happening right now.',
  going: "You haven't said you're going to anything yet.",
  hosting: "You aren't hosting any events.",
};

/** Events you can see: upcoming, happening now, ones you're going to and ones you host. */
export default function EventsPage() {
  const { t, toast, locale } = useSession();
  const [scope, setScope] = useState<Scope>('upcoming');
  const [items, setItems] = useState<EventItem[] | null>(null);
  useEffect(() => {
    setItems(null);
    api.events.list(scope).then(
      (r) => setItems(r.items),
      (e) => {
        setItems([]);
        toast(errorMessage(e));
      },
    );
  }, [scope, toast]);
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Events</h1>
        <Link href="/events/new" className="yp-btn yp-btn--primary yp-btn--sm">
          {t('events.create')}
        </Link>
      </div>
      <Segments
        label="Which events"
        value={scope}
        onChange={setScope}
        options={[
          { id: 'upcoming', label: 'Upcoming' },
          { id: 'now', label: 'Happening now' },
          { id: 'going', label: 'Going' },
          { id: 'hosting', label: 'Hosting' },
        ]}
      />
      {items === null ? (
        <Skeleton height={160} />
      ) : items.length ? (
        <div className="yp-grid">
          {items.map((e) => (
            <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
          ))}
        </div>
      ) : (
        <EmptyState title="No events" body={EMPTY[scope]} />
      )}
    </div>
  );
}
