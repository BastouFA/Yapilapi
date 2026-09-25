'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { EventSummary } from '@yapilapi/api-client';
import {
  Button,
  Card,
  Checkbox,
  CalendarIcon,
  EmptyState,
  FeedTabs,
  IconButton,
  Input,
  SearchIcon,
  CloseIcon,
  buttonClass,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { hasLocationOptIn, requestCoarsePosition, setLocationOptIn } from '@/lib/geo';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

type Tab =
  'upcoming' | 'hosting' | 'attending' | 'interested' | 'waitlist' | 'saved' | 'invited' | 'past';
const TABS: Tab[] = [
  'upcoming',
  'hosting',
  'attending',
  'interested',
  'waitlist',
  'saved',
  'invited',
  'past',
];
const MINE_ROLE: Record<
  Exclude<Tab, 'upcoming'>,
  'hosting' | 'attending' | 'interested' | 'waitlist' | 'saved' | 'invited' | 'past'
> = {
  hosting: 'hosting',
  attending: 'attending',
  interested: 'interested',
  waitlist: 'waitlist',
  saved: 'saved',
  invited: 'invited',
  past: 'past',
};

function EventCard({ ev }: { ev: EventSummary }) {
  const { t, fmt } = useI18n();
  return (
    <Card as="li" padding="md" className="entity-card">
      {ev.coverUrl ? <img src={ev.coverUrl} alt="" className="entity-card__media" /> : null}
      <Link href={`/events/${encodeURIComponent(ev.id)}`} className="entity-card__title">
        {ev.title}
      </Link>
      <span className="entity-card__meta">
        <span>{fmt.dateTime(ev.startsAt)}</span>
        {ev.locationText ? <span>{ev.locationText}</span> : null}
        {ev.distanceKm !== undefined ? (
          <span>
            {t('events.distanceKm', {
              km: fmt.number(ev.distanceKm, { maximumFractionDigits: 1 }),
            })}
          </span>
        ) : null}
      </span>
      <span className="entity-card__meta">
        <span>{t('events.going', { count: ev.goingCount })}</span>
        {ev.host ? <span>{t('events.hostedBy', { name: ev.host.displayName })}</span> : null}
      </span>
    </Card>
  );
}

function BrowsePanel() {
  const api = useApi();
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [online, setOnline] = useState(false);
  const [free, setFree] = useState(false);
  const [nearMe, setNearMe] = useState(false);
  const [pos, setPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [needsLocation, setNeedsLocation] = useState(false);

  const share = async () => {
    const r = await requestCoarsePosition();
    if (r.ok) {
      setLocationOptIn(true);
      setPos(r.position);
      setNeedsLocation(false);
      setNearMe(true);
    } else {
      setNeedsLocation(true);
    }
  };

  // If the person already opted in to sharing an approximate location elsewhere, honour it here too.
  useEffect(() => {
    if (hasLocationOptIn()) void share();
  }, []);

  const key =
    nearMe && pos ? `nearby:${pos.latitude}:${pos.longitude}` : `list:${q}:${online}:${free}`;
  const state = useInfinite<EventSummary>(async (cursor, signal) => {
    if (nearMe) {
      if (!pos) return { items: [], nextCursor: null };
      return api.events.nearby({
        lat: pos.latitude,
        lng: pos.longitude,
        limit: 15,
        signal,
        ...(cursor ? { cursor } : {}),
      });
    }
    return api.events.list({
      q: q || undefined,
      online: online || undefined,
      free: free || undefined,
      limit: 15,
      signal,
      ...(cursor ? { cursor } : {}),
    });
  }, key);

  return (
    <div className="stack">
      <form
        role="search"
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          state.reload();
        }}
      >
        <div className="yl-field search-input-field">
          <label htmlFor="events-q" className="yl-sr-only">
            {t('events.searchPlaceholder')}
          </label>
          <Input
            id="events-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('events.searchPlaceholder')}
            endAdornment={
              q ? (
                <IconButton
                  label={t('search.clear')}
                  size="sm"
                  icon={<CloseIcon size={16} />}
                  onClick={() => setQ('')}
                />
              ) : undefined
            }
          />
        </div>
        <Button type="submit" leadingIcon={<SearchIcon size={16} />}>
          {t('search.submit')}
        </Button>
      </form>
      <div className="inline-form">
        <Checkbox
          label={t('events.filter.online')}
          checked={online}
          onChange={(e) => setOnline(e.target.checked)}
        />
        <Checkbox
          label={t('events.filter.free')}
          checked={free}
          onChange={(e) => setFree(e.target.checked)}
        />
        <Checkbox
          label={t('events.nearMe')}
          checked={nearMe}
          onChange={(e) => {
            if (e.target.checked && !pos) void share();
            else setNearMe(e.target.checked);
          }}
        />
      </div>
      {nearMe && needsLocation ? (
        <Card padding="md" className="stack-sm">
          <p>{t('events.nearMeNeedsLocation')}</p>
          <Button size="sm" onClick={() => void share()}>
            {t('events.shareLocation')}
          </Button>
        </Card>
      ) : null}
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          icon={<CalendarIcon size={28} />}
          title={t('events.emptyTitle')}
          description={t('events.emptyBody')}
        />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="card-grid">
          {state.items.map((ev) => (
            <EventCard key={ev.id} ev={ev} />
          ))}
        </ul>
      ) : null}
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </div>
  );
}

function MinePanel({ role }: { role: Exclude<Tab, 'upcoming'> }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<EventSummary>(
    (cursor, signal) =>
      api.events.mine(MINE_ROLE[role], { limit: 15, signal, ...(cursor ? { cursor } : {}) }),
    `mine:${role}`,
  );
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={28} />}
        title={t('events.emptyTitle')}
        description={t('events.emptyBody')}
      />
    );
  }
  return (
    <div className="stack">
      <ul className="card-grid">
        {state.items.map((ev) => (
          <EventCard key={ev.id} ev={ev} />
        ))}
      </ul>
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </div>
  );
}

export function EventsListView() {
  const { t } = useI18n();
  usePageTitle(t('events.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('upcoming');

  return (
    <>
      <PageHeader
        title={t('events.title')}
        lead={t('events.lead')}
        actions={
          <Link href="/events/new" className={buttonClass({ variant: 'primary' })}>
            {t('events.create')}
          </Link>
        }
      />
      <FeedTabs
        label={t('events.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={TABS.map((id) => ({ id, label: t(`events.tab.${id}`) }))}
      >
        {tab === 'upcoming' ? <BrowsePanel key="upcoming" /> : <MinePanel key={tab} role={tab} />}
      </FeedTabs>
    </>
  );
}
