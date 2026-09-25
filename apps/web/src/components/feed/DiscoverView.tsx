'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { DiscoverTopicItem, Post, TrendingResponse } from '@yapilapi/api-client';
import {
  Button,
  Card,
  CompassIcon,
  EmptyState,
  SparkIcon,
  UsersIcon,
  cx,
  Tabs,
  TabList,
  Tab,
  TabPanel,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PostList } from '@/components/PostList';
import { ErrorView, LiveText, PageSpinner } from '@/components/common';
import { UserRow } from '@/components/profile/UserRow';
import { FollowToggle } from '@/components/FollowToggle';
import { hasLocationOptIn, requestCoarsePosition, setLocationOptIn } from '@/lib/geo';

const WINDOWS: NonNullable<TrendingResponse['window']>[] = ['1h', '6h', '24h', '7d'];

function ForYouPanel() {
  const api = useApi();
  const { t } = useI18n();
  const topics = useAsync((signal) => api.topics.list({ signal }), [api]);
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (slug: string) =>
    setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));

  const key = picked.length ? `custom:${[...picked].sort().join(',')}` : 'for_you';
  const state = useInfinite(
    (cursor, signal) =>
      api.feed.get(
        picked.length
          ? { mode: 'custom', topics: picked, ...(cursor ? { cursor } : {}), limit: 15 }
          : { mode: 'for_you', ...(cursor ? { cursor } : {}), limit: 15 },
        { signal },
      ),
    key,
  );

  return (
    <div className="stack">
      <section aria-labelledby="topics-h" className="stack-sm">
        <h2 id="topics-h" className="section-title">
          {t('discover.topics')}
        </h2>
        {topics.loading ? (
          <p className="muted" role="status">
            {t('common.loading')}
          </p>
        ) : null}
        {topics.error ? <ErrorView error={topics.error} onRetry={topics.reload} /> : null}
        {topics.data && topics.data.items.length === 0 ? (
          <p className="muted">{t('discover.noTopics')}</p>
        ) : null}
        {topics.data && topics.data.items.length > 0 ? (
          <ul className="chips" aria-label={t('discover.topics')}>
            {topics.data.items.map((tp) => {
              const on = picked.includes(tp.slug);
              return (
                <li key={tp.slug}>
                  <button
                    type="button"
                    className={cx('chip', on && 'is-on')}
                    aria-pressed={on}
                    onClick={() => toggle(tp.slug)}
                    data-testid={`topic-${tp.slug}`}
                  >
                    {tp.name}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {picked.length ? (
          <button type="button" className="link-btn" onClick={() => setPicked([])}>
            {t('discover.clear')}
          </button>
        ) : null}
        <LiveText>{t('discover.showing', { count: picked.length })}</LiveText>
      </section>
      <section aria-labelledby="results-h" className="stack">
        <h2 id="results-h" className="section-title">
          {picked.length ? t('discover.resultsTopics') : t('discover.resultsForYou')}
        </h2>
        <PostList
          state={state}
          label={t('nav.discover')}
          explain={picked.length === 0}
          empty={
            <EmptyState
              icon={<CompassIcon size={28} />}
              title={t('discover.emptyTitle')}
              description={picked.length ? t('discover.emptyTopics') : t('discover.emptyForYou')}
            />
          }
        />
      </section>
    </div>
  );
}

function TrendingPanel() {
  const api = useApi();
  const { t } = useI18n();
  const [window_, setWindow] = useState<NonNullable<TrendingResponse['window']>>('24h');
  const [topics, setTopics] = useState<TrendingResponse['topics']>([]);
  const state = useInfinite<Post>(async (cursor, signal) => {
    const r = await api.discover.trending({
      window: window_,
      limit: 15,
      signal,
      ...(cursor ? { cursor } : {}),
    });
    if (!cursor) setTopics(r.topics);
    return { items: r.items, nextCursor: r.nextCursor };
  }, window_);
  return (
    <div className="stack">
      <fieldset className="yl-composer__topics">
        <legend className="yl-sr-only">{t('discover.trending.window')}</legend>
        <ul className="chips" aria-label={t('discover.trending.window')}>
          {WINDOWS.map((w) => (
            <li key={w}>
              <button
                type="button"
                className={cx('chip', window_ === w && 'is-on')}
                aria-pressed={window_ === w}
                onClick={() => setWindow(w)}
              >
                {t(`discover.trending.window.${w}`)}
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      {topics.length > 0 ? (
        <section aria-labelledby="trending-topics-h" className="stack-sm">
          <h2 id="trending-topics-h" className="section-title">
            {t('discover.trending.topicsTitle')}
          </h2>
          <ul className="chips" aria-label={t('discover.trending.topicsTitle')}>
            {topics.map((tp) => (
              <li key={tp.slug}>
                <span className="chip">{tp.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <PostList
        state={state}
        label={t('discover.trending.title')}
        explain={false}
        empty={<EmptyState icon={<SparkIcon size={28} />} title={t('discover.trending.empty')} />}
      />
    </div>
  );
}

function PeoplePanel() {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite(
    (cursor, signal) => api.discover.people({ limit: 20, ...(cursor ? { cursor } : {}), signal }),
    'people',
  );
  return (
    <div className="stack">
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState icon={<UsersIcon size={28} />} title={t('discover.people.empty')} />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm" aria-label={t('discover.people.title')}>
          {state.items.map((sp) => (
            <UserRow
              key={sp.user.id}
              user={sp.user}
              actions={
                <FollowToggle username={sp.user.username} initial={sp.user.viewer.following} />
              }
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NowPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const [optIn, setOptIn] = useState(hasLocationOptIn());
  const [pos, setPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const now = useAsync(
    (signal) => api.discover.now({ lat: pos?.latitude, lng: pos?.longitude, limit: 10, signal }),
    [api, pos],
  );

  const share = async () => {
    const r = await requestCoarsePosition();
    if (r.ok) {
      setOptIn(true);
      setLocationOptIn(true);
      setPos(r.position);
    }
  };

  if (now.loading) return <PageSpinner />;
  if (now.error) return <ErrorView error={now.error} onRetry={now.reload} />;
  if (!now.data) return null;
  if (!now.data.live.enabled) {
    return <EmptyState icon={<CompassIcon size={28} />} title={t('discover.now.disabled')} />;
  }
  const nothing =
    now.data.events.length === 0 &&
    now.data.activeCommunities.length === 0 &&
    (!now.data.nearby || (!now.data.nearby.people && now.data.nearby.places.length === 0));

  return (
    <div className="stack">
      {now.data.needsLocation && !optIn ? (
        <Card padding="md" className="stack-sm">
          <p>{t('discover.now.needsLocation')}</p>
          <Button size="sm" onClick={() => void share()}>
            {t('discover.now.shareLocation')}
          </Button>
        </Card>
      ) : null}
      {nothing ? (
        <EmptyState icon={<CompassIcon size={28} />} title={t('discover.now.empty')} />
      ) : null}
      {now.data.events.length > 0 ? (
        <section aria-labelledby="now-events-h" className="stack-sm">
          <h2 id="now-events-h" className="section-title">
            {t('discover.now.eventsTitle')}
          </h2>
          <ul className="card-grid">
            {now.data.events.map((ev) => (
              <li key={ev.id}>
                <Card as="div" padding="md" className="entity-card">
                  <Link
                    href={`/events/${encodeURIComponent(ev.id)}`}
                    className="entity-card__title"
                  >
                    {ev.title}
                  </Link>
                  <span className="entity-card__meta">{fmt.dateTime(ev.startsAt)}</span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {now.data.activeCommunities.length > 0 ? (
        <section aria-labelledby="now-communities-h" className="stack-sm">
          <h2 id="now-communities-h" className="section-title">
            {t('discover.now.communitiesTitle')}
          </h2>
          <ul className="card-grid">
            {now.data.activeCommunities.map((c) => (
              <li key={c.id}>
                <Card as="div" padding="md" className="entity-card">
                  <Link
                    href={`/communities/${encodeURIComponent(c.slug)}`}
                    className="entity-card__title"
                  >
                    {c.name}
                  </Link>
                  <span className="entity-card__meta">
                    {t('discover.now.peopleActive', { count: c.activePeople })}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {now.data.nearby ? (
        <section aria-labelledby="now-nearby-h" className="stack-sm">
          <h2 id="now-nearby-h" className="section-title">
            {t('discover.now.nearbyTitle')}
          </h2>
          {now.data.nearby.people ? (
            <p>{t('discover.now.peopleActive', { count: now.data.nearby.people.count })}</p>
          ) : null}
          {now.data.nearby.places.length > 0 ? (
            <ul className="card-grid">
              {now.data.nearby.places.map((p) => (
                <li key={p.id}>
                  <Card as="div" padding="md" className="entity-card">
                    <span className="entity-card__title">{p.name}</span>
                    <span className="entity-card__meta">
                      {t('discover.now.peopleActive', { count: p.activePeople })}
                    </span>
                  </Card>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <p className="muted">{t('discover.now.approxNote')}</p>
    </div>
  );
}

function ExplorePanel() {
  const api = useApi();
  const { t } = useI18n();
  const topics = useAsync((signal) => api.discover.topics({ limit: 30, signal }), [api]);
  if (topics.loading) return <PageSpinner />;
  if (topics.error) return <ErrorView error={topics.error} onRetry={topics.reload} />;
  if (!topics.data) return null;
  if (topics.data.items.length === 0) {
    return <EmptyState icon={<CompassIcon size={28} />} title={t('discover.explore.empty')} />;
  }
  const row = (tp: DiscoverTopicItem) => (
    <Card key={tp.slug} as="li" padding="md" className="search-row">
      <div className="search-row__text">
        <span className="search-row__title">#{tp.name}</span>
        <span className="muted">
          {t('discover.explore.postsThisWeek', { count: tp.postsThisWeek })}
        </span>
      </div>
    </Card>
  );
  return (
    <ul className="stack-sm search-list" aria-label={t('discover.explore.title')}>
      {topics.data.items.map(row)}
    </ul>
  );
}

/** Browse by topic, trending posts, people to follow, NOW, and explorable topics. */
export function DiscoverView() {
  const { t } = useI18n();
  usePageTitle(t('nav.discover'), t('app.name'));
  return (
    <>
      <PageHeader title={t('discover.title')} lead={t('discover.lead')} />
      <Tabs defaultValue="forYou">
        <TabList label={t('discover.title')} className="yl-tablist--scroll">
          <Tab value="forYou">{t('discover.tab.forYou')}</Tab>
          <Tab value="trending" icon={<SparkIcon size={16} />}>
            {t('discover.tab.trending')}
          </Tab>
          <Tab value="people" icon={<UsersIcon size={16} />}>
            {t('discover.tab.people')}
          </Tab>
          <Tab value="now" icon={<CompassIcon size={16} />}>
            {t('discover.tab.now')}
          </Tab>
          <Tab value="explore">{t('discover.tab.explore')}</Tab>
        </TabList>
        <TabPanel value="forYou">
          <ForYouPanel />
        </TabPanel>
        <TabPanel value="trending">
          <TrendingPanel />
        </TabPanel>
        <TabPanel value="people">
          <PeoplePanel />
        </TabPanel>
        <TabPanel value="now">
          <NowPanel />
        </TabPanel>
        <TabPanel value="explore">
          <ExplorePanel />
        </TabPanel>
      </Tabs>
    </>
  );
}
