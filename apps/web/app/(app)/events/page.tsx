'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState, EventCard, Segments, Skeleton } from '@yapilapi/design-system';
import type { EventItem, MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

type Scope = 'upcoming' | 'now' | 'going' | 'hosting';
const EMPTY: Record<Scope, MessageKey> = {
  upcoming: 'm.events.empty.upcoming',
  now: 'm.events.empty.now',
  going: 'm.events.empty.going',
  hosting: 'm.events.empty.hosting',
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
        <h1>{t('events.title')}</h1>
        <Link href="/events/new" className="yp-btn yp-btn--primary yp-btn--sm">
          {t('events.create')}
        </Link>
      </div>
      <Segments
        label={t('m.events.scope')}
        value={scope}
        onChange={setScope}
        options={[
          { id: 'upcoming', label: t('m.events.upcoming') },
          { id: 'now', label: t('discover.now') },
          { id: 'going', label: t('events.going') },
          { id: 'hosting', label: t('m.events.hosting') },
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
        <EmptyState title={t('m.events.none')} body={t(EMPTY[scope])} />
      )}
    </div>
  );
}
