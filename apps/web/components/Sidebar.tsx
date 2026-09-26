'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Button } from '@yapilapi/design-system';
import type { EventItem, PublicUser } from '@yapilapi/shared';
import type { LiveSummary } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type Suggestion = { user: PublicUser; bio: string; reason: string };

/** Desktop right column: search, what's live, who to follow, trending topics. Every panel hides itself when it has nothing real to show. */
export function Sidebar() {
  const { toast, flags, locale } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Suggestion[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<EventItem[]>([]);
  const [topics, setTopics] = useState<{ topic: string; posts: number }[]>([]);
  const [live, setLive] = useState<LiveSummary[]>([]);

  useEffect(() => {
    api.me.suggestions().then(
      (r) => setPeople(r.items.slice(0, 4)),
      () => {},
    );
    api.now().then(
      (r) => {
        setEvents(r.events.slice(0, 3));
        setTopics(r.trendingTopics.slice(0, 6));
      },
      () =>
        api.events.list('upcoming').then(
          (r) => setEvents(r.items.slice(0, 3)),
          () => {},
        ),
    );
    if (flags.LIVE)
      api.live.list().then(
        (r) => setLive(r.items.filter((l) => l.status === 'live').slice(0, 3)),
        () => {},
      );
  }, [flags.LIVE]);

  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  return (
    <aside className="yp-shell__aside" aria-label="Around you">
      <form
        role="search"
        aria-label="Quick search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) router.push(`/discover?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label className="yp-visually-hidden" htmlFor="aside-search">
          Search YAPILAPI
        </label>
        <input
          id="aside-search"
          className="yp-search"
          type="search"
          placeholder="Search people, places, events"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
      </form>

      {live.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-live">
          <h2 id="aside-live">
            <span className="yp-live-dot" aria-hidden /> Live now
          </h2>
          {live.map((l) => (
            <Link key={l.id} href={`/live/${l.id}`} className="yp-aside-row">
              <Avatar name={l.host.displayName} src={l.host.avatarUrl} size="sm" />
              <span className="yp-aside-row__text">
                <span className="yp-aside-row__title">{l.title}</span>
                <span className="yp-aside-row__meta">
                  {l.host.displayName} · {l.viewers} watching
                </span>
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      {events.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-events">
          <h2 id="aside-events" className="row" style={{ justifyContent: 'space-between' }}>
            Happening soon
            <Link href="/events" className="yp-aside-row__meta" style={{ fontFamily: 'var(--font-sans)' }}>
              See all
            </Link>
          </h2>
          {events.map((e) => (
            <Link key={e.id} href={`/events/${e.id}`} className="yp-aside-row">
              <span className="yp-aside-date" aria-hidden>
                <span>{new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(e.startsAt))}</span>
                <strong>{new Date(e.startsAt).getDate()}</strong>
              </span>
              <span className="yp-aside-row__text">
                <span className="yp-aside-row__title">{e.title}</span>
                <span className="yp-aside-row__meta">
                  {day.format(new Date(e.startsAt))}
                  {e.place ? ` · ${e.place.name}` : e.locationText ? ` · ${e.locationText}` : ''}
                </span>
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      {people.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-people">
          <h2 id="aside-people">People to follow</h2>
          {people.map((s) => (
            <div key={s.user.id} className="yp-aside-row">
              <Link href={`/u/${s.user.username}`} aria-hidden tabIndex={-1}>
                <Avatar name={s.user.displayName} src={s.user.avatarUrl} size="sm" />
              </Link>
              <span className="yp-aside-row__text">
                <Link href={`/u/${s.user.username}`} className="yp-aside-row__title" style={{ color: 'inherit', textDecoration: 'none' }}>
                  {s.user.displayName}
                </Link>
                <span className="yp-aside-row__meta">{s.reason || `@${s.user.username}`}</span>
              </span>
              <Button
                size="sm"
                variant={followed.has(s.user.id) ? 'secondary' : 'primary'}
                aria-pressed={followed.has(s.user.id)}
                onClick={async () => {
                  const on = followed.has(s.user.id);
                  try {
                    await (on ? api.users.unfollow(s.user.id) : api.users.follow(s.user.id));
                    setFollowed((prev) => {
                      const next = new Set(prev);
                      if (on) next.delete(s.user.id);
                      else next.add(s.user.id);
                      return next;
                    });
                  } catch (err) {
                    toast(errorMessage(err));
                  }
                }}
              >
                {followed.has(s.user.id) ? 'Following' : 'Follow'}
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {topics.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-topics">
          <h2 id="aside-topics">Trending</h2>
          <div className="row">
            {topics.map((t) => (
              <Link key={t.topic} href={`/discover?q=${encodeURIComponent(t.topic)}`} className="yp-chip">
                #{t.topic}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <p className="yp-aside-foot">
        <Link href="/settings" className="muted">
          Privacy & settings
        </Link>{' '}
        ·{' '}
        <Link href="/assistant" className="muted">
          Assistant
        </Link>{' '}
        ·{' '}
        <Link href="/developers" className="muted">
          Developers
        </Link>{' '}
        · © {new Date().getFullYear()} YAPILAPI
      </p>
    </aside>
  );
}
