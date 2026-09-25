'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Avatar, Button, CommunityCard, EmptyState, EventCard, List, ListItem, PostCard, ProductCard, Skeleton } from '@yapilapi/design-system';
import type { Community, EventItem, Post, PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

function Discover() {
  const { t, locale, toast } = useSession();
  const router = useRouter();
  const q = useSearchParams().get('q') ?? '';
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.search>> | null>(null);
  const [now, setNow] = useState<Awaited<ReturnType<typeof api.now>> | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);

  useEffect(() => {
    setInput(q);
    if (!q) return setResults(null);
    setResults(null);
    api.search(q).then(setResults, (e) => toast(errorMessage(e)));
  }, [q, toast]);

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

  const r = results?.results ?? {};
  const people = (r.people ?? []) as PublicUser[];
  const posts = (r.posts ?? []) as Post[];
  const foundCommunities = (r.communities ?? []) as Community[];
  const foundEvents = (r.events ?? []) as EventItem[];
  const places = (r.places ?? []) as { id: string; name: string; category: string; city: string | null }[];
  const products = (r.products ?? []) as { id: string; kind: string; title: string; priceCents: number; currency: string }[];
  const nothing = results && ![people, posts, foundCommunities, foundEvents, places, products].some((x) => x.length);

  return (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <div className="yp-topbar">
        <h1>{t('discover.title')}</h1>
        <div className="row">
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
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(input.trim() ? `/discover?q=${encodeURIComponent(input.trim())}` : '/discover');
        }}
      >
        <label htmlFor="q" className="yp-visually-hidden">
          {t('discover.search')}
        </label>
        <input
          id="q"
          className="yp-input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={`${t('discover.search')}. Try "something to do tonight"`}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
        />
        <Button type="submit" icon="search">
          Search
        </Button>
      </form>

      {q ? (
        results === null ? (
          <Skeleton height={200} />
        ) : nothing ? (
          <EmptyState title={`No results for “${q}”`} body="Try fewer words, or search for a person, community, event or place." />
        ) : (
          <div className="stack">
            {results.intent.when || results.intent.placeCategory || results.intent.groupSize ? (
              <p className="muted">
                Showing {results.intent.types.join(', ') || 'results'}
                {results.intent.when ? ` for ${results.intent.when.label}` : ''}
                {results.intent.groupSize ? ` for ${results.intent.groupSize} people` : ''}.
              </p>
            ) : null}
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
                      secondary={`@${u.username} · ${u.mode}`}
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
                    <CommunityCard key={c.id} community={c} href={`/c/${c.slug}`} linkAs={NextLink} />
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
            {places.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.places')}</h2>
                <List>
                  {places.map((p) => (
                    <ListItem
                      key={p.id}
                      href={`/places/${p.id}`}
                      linkAs={NextLink}
                      primary={p.name}
                      secondary={[p.category, p.city].filter(Boolean).join(' · ')}
                    />
                  ))}
                </List>
              </section>
            ) : null}
            {products.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.products')}</h2>
                <div className="yp-grid">
                  {products.map((p) => (
                    <ProductCard key={p.id} product={{ ...p, inventory: null }} locale={locale} />
                  ))}
                </div>
              </section>
            ) : null}
            {posts.length ? (
              <section className="stack-sm">
                <h2 className="section-title">{t('discover.posts')}</h2>
                {posts.map((p) => (
                  <PostCard key={p.id} post={p} locale={locale} linkAs={NextLink} />
                ))}
              </section>
            ) : null}
          </div>
        )
      ) : (
        <div className="stack">
          <section className="stack-sm">
            <h2 className="section-title">{t('discover.now')}</h2>
            {now === null ? (
              <Skeleton height={80} />
            ) : now.events.length || now.trendingTopics.length ? (
              <>
                {now.events.length ? (
                  <div className="yp-grid">
                    {now.events.map((e) => (
                      <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
                    ))}
                  </div>
                ) : null}
                <div className="row">
                  {now.trendingTopics.map((tp) => (
                    <Link key={tp.topic} href={`/discover?q=${encodeURIComponent(tp.topic)}`} className="yp-chip">
                      #{tp.topic} · {tp.posts}
                    </Link>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">It's quiet right now. Check upcoming events below.</p>
            )}
          </section>
          <section className="stack-sm">
            <h2 className="section-title">{t('discover.communities')}</h2>
            <div className="yp-grid">
              {communities.map((c) => (
                <CommunityCard key={c.id} community={c} href={`/c/${c.slug}`} linkAs={NextLink} />
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
              <p className="muted">No upcoming events yet.</p>
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
