'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Avatar, Button, CommunityCard, EmptyState, EventCard, Icon, List, ListItem, Segments, Skeleton } from '@yapilapi/design-system';
import type { Community, EventItem, Post, PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { TrendingTags } from '@/components/TrendingTags';
import { PostList } from '@/components/PostList';
import { useSession } from '../../providers';

type Tab = 'all' | 'people' | 'topics' | 'posts' | 'communities' | 'events';
type Results = Awaited<ReturnType<typeof api.search>>;
const RECENT_KEY = 'yp.search.recent';

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * Search everything as you type: people, tags, posts, communities and events.
 * Results update a moment after you stop typing; Enter keeps the search in the
 * address so it can be shared or revisited. Recent searches stay on this device.
 */
function SearchPage() {
  const { t, locale, toast } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [tab, setTab] = useState<Tab>((params.get('type') as Tab) || 'all');
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRecent(readRecent());
    input.current?.focus();
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let current = true;
    const timer = setTimeout(() => {
      api.search(term, tab).then(
        (r) => current && (setResults(r), setLoading(false)),
        (e) => current && (setLoading(false), toast(errorMessage(e))),
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, tab, toast]);

  const remember = (term: string) => {
    const next = [term, ...readRecent().filter((x) => x !== term)].slice(0, 8);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; fine.
    }
  };

  const submit = (term = q.trim()) => {
    if (!term) return;
    remember(term);
    // A single #tag goes straight to its page.
    if (/^#[\p{L}\p{M}\p{N}_]{2,40}$/u.test(term)) return router.push(`/t/${encodeURIComponent(term.slice(1).toLowerCase())}`);
    router.replace(`/search?q=${encodeURIComponent(term)}${tab !== 'all' ? `&type=${tab}` : ''}`);
  };

  const r = results?.results ?? {};
  const people = (r.people ?? []) as PublicUser[];
  const topics = (r.topics ?? []) as { slug: string; name: string; posts: number }[];
  const posts = (r.posts ?? []) as Post[];
  const communities = (r.communities ?? []) as Community[];
  const events = (r.events ?? []) as EventItem[];
  const nothing = results && ![people, topics, posts, communities, events].some((x) => x.length);
  const show = (k: Tab) => tab === 'all' || tab === k;
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

  return (
    <div className="yp-shell__inner stack">
      <h1 className="yp-visually-hidden">Search</h1>
      <form
        role="search"
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Icon name="search" />
        <label htmlFor="search-q" className="yp-visually-hidden">
          Search YAPILAPI
        </label>
        <input
          ref={input}
          id="search-q"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Search people, #tags, posts, communities"
          value={q}
          maxLength={200}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        {q ? (
          <button type="button" className="search-bar__clear" aria-label="Clear search" onClick={() => (setQ(''), input.current?.focus())}>
            <Icon name="x" size={16} />
          </button>
        ) : null}
        <Button type="submit" size="sm" disabled={!q.trim()}>
          Search
        </Button>
      </form>

      {q.trim() ? (
        <Segments
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'all', label: 'All' },
            { id: 'people', label: 'People' },
            { id: 'topics', label: 'Tags' },
            { id: 'posts', label: 'Posts' },
            { id: 'communities', label: 'Communities' },
            { id: 'events', label: 'Events' },
          ]}
        />
      ) : null}

      {!q.trim() ? (
        <>
          {recent.length ? (
            <section className="stack-sm" aria-labelledby="recent-title">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2 id="recent-title" className="section-title">
                  Recent searches
                </h2>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRecent([]);
                    try {
                      localStorage.removeItem(RECENT_KEY);
                    } catch {
                      // Nothing to clear.
                    }
                  }}
                >
                  Clear
                </Button>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {recent.map((term) => (
                  <button key={term} type="button" className="yp-chip" onClick={() => (setQ(term), submit(term))}>
                    <bdi>{term}</bdi>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <section className="stack-sm" aria-labelledby="trend-title">
            <h2 id="trend-title" className="section-title">
              Trending
            </h2>
            <TrendingTags limit={10} />
          </section>
        </>
      ) : loading && !results ? (
        <Skeleton height={240} />
      ) : nothing ? (
        <EmptyState title={`No results for “${q.trim()}”`} body="Check the spelling, try fewer words, or search for a #tag." />
      ) : results ? (
        <div className="stack" aria-busy={loading}>
          {show('people') && people.length ? (
            <section className="stack-sm" aria-labelledby="res-people">
              <h2 id="res-people" className="section-title">
                {t('discover.people')}
              </h2>
              <List>
                {people.slice(0, tab === 'all' ? 5 : undefined).map((u) => (
                  <ListItem
                    key={u.id}
                    href={`/u/${u.username}`}
                    linkAs={NextLink}
                    start={<Avatar name={u.displayName} src={u.avatarUrl} />}
                    primary={u.displayName}
                    secondary={`@${u.username}`}
                  />
                ))}
              </List>
            </section>
          ) : null}
          {show('topics') && topics.length ? (
            <section className="stack-sm" aria-labelledby="res-tags">
              <h2 id="res-tags" className="section-title">
                Tags
              </h2>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {topics.map((tp) => (
                  <Link key={tp.slug} href={`/t/${encodeURIComponent(tp.slug)}`} className="yp-chip" onClick={() => remember(q.trim())}>
                    <bdi>#{tp.slug}</bdi>
                    {tp.posts ? <span className="muted"> · {n.format(tp.posts)}</span> : null}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
          {show('communities') && communities.length ? (
            <section className="stack-sm" aria-labelledby="res-comm">
              <h2 id="res-comm" className="section-title">
                {t('discover.communities')}
              </h2>
              <div className="yp-grid">
                {communities.map((c) => (
                  <CommunityCard key={c.id} community={c} href={`/c/${c.slug}`} linkAs={NextLink} />
                ))}
              </div>
            </section>
          ) : null}
          {show('events') && events.length ? (
            <section className="stack-sm" aria-labelledby="res-events">
              <h2 id="res-events" className="section-title">
                {t('discover.events')}
              </h2>
              <div className="yp-grid">
                {events.map((e) => (
                  <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
                ))}
              </div>
            </section>
          ) : null}
          {show('posts') && posts.length ? (
            <section className="stack-sm" aria-labelledby="res-posts">
              <h2 id="res-posts" className="section-title">
                {t('discover.posts')}
              </h2>
              <PostList
                load={() => Promise.resolve({ items: posts, nextCursor: null })}
                reloadKey={`${q}-${tab}-${posts.map((p) => p.id).join()}`}
                showEnd={false}
              />
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function Search() {
  return (
    <Suspense fallback={<Skeleton height={240} />}>
      <SearchPage />
    </Suspense>
  );
}
