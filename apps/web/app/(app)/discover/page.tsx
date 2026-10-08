'use client';

import Link from 'next/link';
import { AgentPanel } from '@/components/AgentPanel';
import { MoreResults, SearchFailed, type BusinessResult, type PlaceResult, type ProductResult } from '@/components/SearchMore';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Avatar, Button, CommunityCard, EmptyState, EventCard, Icon, List, ListItem, Skeleton } from '@yapilapi/design-system';
import type { Chain, Community, EventItem, MessageKey, Post, PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { TrendingTags } from '@/components/TrendingTags';
import { ChainCard } from '@/components/PassTheMic';
import { PostList } from '@/components/PostList';
import { normalizeTag } from '@yapilapi/shared';
import { useSession } from '../../providers';

/** What the search understood, as words for "Showing events for tonight". */
const INTENT_TYPE: Record<string, MessageKey> = {
  people: 'discover.intent.type.people',
  posts: 'discover.intent.type.posts',
  communities: 'discover.intent.type.communities',
  events: 'discover.intent.type.events',
  places: 'discover.intent.type.places',
  businesses: 'discover.intent.type.businesses',
  products: 'discover.intent.type.products',
  topics: 'discover.intent.type.topics',
};
const INTENT_WHEN: Record<string, MessageKey> = {
  tonight: 'discover.intent.when.tonight',
  today: 'discover.intent.when.today',
  tomorrow: 'discover.intent.when.tomorrow',
  'this weekend': 'discover.intent.when.thisWeekend',
  'next week': 'discover.intent.when.nextWeek',
};

function Discover() {
  const { t, tp, locale, flags } = useSession();
  const router = useRouter();
  const q = useSearchParams().get('q') ?? '';
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.search>> | null>(null);
  // Why the search didn't go through (shown with Try again instead of loading forever).
  const [searchError, setSearchError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState<Awaited<ReturnType<typeof api.now>> | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  // Pass the Mic: chains with new reels this week.
  const [chains, setChains] = useState<Chain[]>([]);

  useEffect(() => {
    setInput(q);
    setSearchError(null);
    if (!q) return setResults(null);
    setResults(null);
    let current = true;
    api.search(q).then(
      (r) => current && setResults(r),
      (e) => current && setSearchError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [q, attempt]);

  useEffect(() => {
    api
      .now()
      .then(setNow)
      .catch(() => {});
    api.communities
      .list('discover')
      .then((r) => setCommunities(r.items))
      .catch(() => {});
    api.events
      .list('upcoming')
      .then((r) => setEvents(r.items))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!flags.PASS_THE_MIC) return setChains([]);
    let live = true;
    api.chains.active(12).then(
      (r) => live && setChains(r.items),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [flags.PASS_THE_MIC]);

  const r = results?.results ?? {};
  const people = (r.people ?? []) as PublicUser[];
  const posts = (r.posts ?? []) as Post[];
  const foundCommunities = (r.communities ?? []) as Community[];
  const foundEvents = (r.events ?? []) as EventItem[];
  const places = (r.places ?? []) as PlaceResult[];
  const businesses = (r.businesses ?? []) as BusinessResult[];
  const products = (r.products ?? []) as ProductResult[];
  const topics = (r.topics ?? []) as { slug: string; name: string; posts: number }[];
  const nothing = results && ![people, posts, foundCommunities, foundEvents, places, businesses, products, topics].some((x) => x.length);
  const intent = results?.intent;
  let showing = '';
  if (intent && (intent.when || intent.placeCategory || intent.groupSize)) {
    const typeWords = (intent.types as string[]).map((x) => {
      const k = INTENT_TYPE[x];
      return k ? t(k) : x;
    });
    const types = typeWords.length ? new Intl.ListFormat(locale, { type: 'unit', style: 'short' }).format(typeWords) : t('discover.intent.results');
    const whenKey = intent.when ? INTENT_WHEN[intent.when.label] : undefined;
    const when = intent.when ? (whenKey ? t(whenKey) : intent.when.label) : '';
    if (intent.groupSize)
      showing = when
        ? tp('discover.intent.showingWhenGroup', intent.groupSize, { types, when })
        : tp('discover.intent.showingGroup', intent.groupSize, { types });
    else showing = when ? t('discover.intent.showingWhen', { types, when }) : t('discover.intent.showing', { types });
  }

  return (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <div className="yp-topbar">
        <h1 className="topbar__word">{t('discover.title')}</h1>
        <div className="row topbar__actions">
          {flags.LIVE ? (
            <Link href="/live" className="yp-btn yp-btn--ghost yp-btn--sm">
              {t('m.live.title')}
            </Link>
          ) : null}
          <Link href="/assistant" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('m.title.assistant')}
          </Link>
          {flags.YAPS !== false && flags.YAP_RADIO !== false ? (
            <Link href="/radio" className="yp-btn yp-btn--ghost yp-btn--sm" data-testid="wander-radio">
              <Icon name="volume" size={16} /> {t('radio.title')}
            </Link>
          ) : null}
          {flags.CITY_MAP !== false ? (
            <Link href="/map" className="yp-btn yp-btn--ghost yp-btn--sm" title={t('map.hint')}>
              <Icon name="map-pin" size={16} /> {t('map.title')}
            </Link>
          ) : null}
          {flags.ASK_CITY !== false ? (
            <Link href="/ask" className="yp-btn yp-btn--ghost yp-btn--sm" title={t('askCity.hint')}>
              <Icon name="help" size={16} /> {t('askCity.title')}
            </Link>
          ) : null}
          <Link href="/market" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('market.title')}
          </Link>
          <Link href="/communities/new" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('communities.create')}
          </Link>
          <Link href="/events/new" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('events.create')}
          </Link>
        </div>
      </div>

      <form
        role="search"
        aria-label={t('discover.title')}
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim();
          // A single #tag goes straight to its page.
          if (/^#[\p{L}\p{M}\p{N}_]{2,40}$/u.test(v)) return router.push(`/t/${encodeURIComponent(normalizeTag(v))}`);
          router.push(v ? `/discover?q=${encodeURIComponent(v)}` : '/discover');
        }}
      >
        <label htmlFor="q" className="yp-visually-hidden">
          {t('discover.search')}
        </label>
        <input
          id="q"
          className="yp-input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={t('discover.searchPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
        />
        <Button type="submit" icon="search">
          {t('home.search')}
        </Button>
      </form>
      {!q ? <AgentPanel kind="discover" compact /> : null}

      {q ? (
        results === null && searchError ? (
          <SearchFailed message={searchError} onRetry={() => setAttempt((n) => n + 1)} />
        ) : results === null ? (
          <Skeleton height={200} />
        ) : nothing ? (
          <EmptyState title={t('search.noResults', { query: q })} body={t('discover.noResultsBody')} />
        ) : (
          <div className="stack">
            {showing ? <p className="muted">{showing}</p> : null}
            {people.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.people')}</h2>
                <List>
                  {people.map((u) => (
                    <ListItem
                      key={u.id}
                      href={`/u/${u.username}`}
                      linkAs={NextLink}
                      start={<Avatar name={u.displayName} src={u.avatarUrl} />}
                      primary={u.displayName}
                      secondary={`@${u.username} · ${t(`settings.mode.${u.mode}` as MessageKey)}`}
                    />
                  ))}
                </List>
              </section>
            ) : null}
            {foundCommunities.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.communities')}</h2>
                <div className="yp-grid">
                  {foundCommunities.map((c) => (
                    <CommunityCard key={c.id} community={c} href={`/c/${c.slug}`} linkAs={NextLink} locale={locale} />
                  ))}
                </div>
              </section>
            ) : null}
            {foundEvents.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.events')}</h2>
                <div className="yp-grid">
                  {foundEvents.map((e) => (
                    <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
                  ))}
                </div>
              </section>
            ) : null}
            {topics.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('m.wander.tags')}</h2>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {topics.map((tag) => (
                    <Link key={tag.slug} href={`/t/${encodeURIComponent(tag.slug)}`} className="yp-chip">
                      <bdi>#{tag.slug}</bdi>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
            <MoreResults places={places} businesses={businesses} products={products} />
            {posts.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.posts')}</h2>
                <PostList
                  load={() => Promise.resolve({ items: posts, nextCursor: null })}
                  reloadKey={`${q}-${posts.map((p) => p.id).join()}`}
                  showEnd={false}
                  surface="search"
                />
              </section>
            ) : null}
          </div>
        )
      ) : (
        <div className="stack">
          <section className="stack-sm">
            <h2 className="section-title">{t('sidebar.trending')}</h2>
            <TrendingTags />
          </section>
          {flags.PASS_THE_MIC && chains.length ? (
            <section className="stack-sm" aria-labelledby="chains-shelf">
              <h2 id="chains-shelf" className="section-title">
                {t('mic.shelf')}
              </h2>
              <ul className="chain-shelf">
                {chains.map((c) => (
                  <ChainCard key={c.id} chain={c} />
                ))}
              </ul>
            </section>
          ) : null}
          <section className="stack-sm">
            <h2 className="section-title">{t('discover.now')}</h2>
            {now === null ? (
              <Skeleton height={80} />
            ) : now.events.length ? (
              <>
                {now.events.length ? (
                  <div className="yp-grid">
                    {now.events.map((e) => (
                      <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted">{t('discover.quiet')}</p>
            )}
          </section>
          <section className="stack-sm">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 className="section-title">{t('discover.communities')}</h2>
              <Link href="/communities" className="muted">
                {t('m.wander.seeAll')}
              </Link>
            </div>
            <div className="yp-grid">
              {communities.map((c) => (
                <CommunityCard key={c.id} community={c} href={`/c/${c.slug}`} linkAs={NextLink} locale={locale} />
              ))}
            </div>
          </section>
          <section className="stack-sm">
            <h2 className="section-title">{t('discover.events')}</h2>
            {events.length ? (
              <div className="yp-grid">
                {events.map((e) => (
                  <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
                ))}
              </div>
            ) : (
              <p className="muted">{t('discover.noUpcoming')}</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default function DiscoverPage() {
  return (
    <Suspense>
      <Discover />
    </Suspense>
  );
}
