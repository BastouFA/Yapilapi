'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Button } from '@yapilapi/design-system';
import { suggestionReasonText, type EventItem, type PeopleSuggestion } from '@yapilapi/shared';
import type { LiveSummary } from '@yapilapi/api-client';
import { api, errorMessage, sharedRequest } from '@/lib/api';
import { useSession } from '@/app/providers';

type Suggestion = PeopleSuggestion;

/** Desktop right column: search, what's live, who to follow, trending topics. Every panel hides itself when it has nothing real to show. */
export function Sidebar() {
  const { toast, flags, locale, t, tp } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Suggestion[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<EventItem[]>([]);
  const [topics, setTopics] = useState<{ topic: string; posts: number }[]>([]);
  const [live, setLive] = useState<LiveSummary[]>([]);

  // Once: flags arrive after the first render, and only the live panel depends on them.
  useEffect(() => {
    sharedRequest('suggestions', () => api.me.suggestions()).then(
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
  }, []);

  useEffect(() => {
    if (flags.LIVE)
      api.live.list().then(
        (r) => setLive(r.items.filter((l) => l.status === 'live').slice(0, 3)),
        () => {},
      );
  }, [flags.LIVE]);

  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const month = new Intl.DateTimeFormat(locale, { month: 'short' });
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric' });

  return (
    <aside className="yp-shell__aside" aria-label={t('sidebar.label')}>
      <form
        role="search"
        aria-label={t('sidebar.quickSearch')}
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label className="yp-visually-hidden" htmlFor="aside-search">
          {t('sidebar.searchLabel')}
        </label>
        <input
          id="aside-search"
          className="yp-search"
          type="search"
          placeholder={t('sidebar.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
      </form>

      {live.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-live">
          <h2 id="aside-live">
            <span className="yp-live-dot" aria-hidden /> {t('sidebar.live')}
          </h2>
          {live.map((l) => (
            <Link key={l.id} href={`/live/${l.id}`} className="yp-aside-row">
              <Avatar name={l.host.displayName} src={l.host.avatarUrl} size="sm" />
              <span className="yp-aside-row__text">
                <span className="yp-aside-row__title">{l.title}</span>
                <span className="yp-aside-row__meta">{tp('sidebar.watching', l.viewers, { name: l.host.displayName })}</span>
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      {events.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-events">
          <h2 id="aside-events" className="row" style={{ justifyContent: 'space-between' }}>
            {t('sidebar.events')}
            <Link href="/events" className="yp-aside-row__meta" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('sidebar.seeAll')}
            </Link>
          </h2>
          {events.map((e) => (
            <Link key={e.id} href={`/events/${e.id}`} className="yp-aside-row">
              <span className="yp-aside-date" aria-hidden>
                <span>{month.format(new Date(e.startsAt))}</span>
                <strong>{date.format(new Date(e.startsAt))}</strong>
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
          <h2 id="aside-people">{t('sidebar.people')}</h2>
          {people.map((s) => (
            <div key={s.user.id} className="yp-aside-row">
              <Link href={`/u/${s.user.username}`} aria-hidden tabIndex={-1}>
                <Avatar name={s.user.displayName} src={s.user.avatarUrl} size="sm" />
              </Link>
              <span className="yp-aside-row__text">
                <Link href={`/u/${s.user.username}`} className="yp-aside-row__title" style={{ color: 'inherit', textDecoration: 'none' }}>
                  {s.user.displayName}
                </Link>
                <span className="yp-aside-row__meta">{suggestionReasonText(s, { t, tp }) || `@${s.user.username}`}</span>
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
                {followed.has(s.user.id) ? t('profile.unfollow') : t('profile.follow')}
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {topics.length ? (
        <section className="yp-aside-card" aria-labelledby="aside-topics">
          <h2 id="aside-topics">{t('sidebar.trending')}</h2>
          <div className="row">
            {topics.map((topic) => (
              <Link key={topic.topic} href={`/t/${encodeURIComponent(topic.topic)}`} className="yp-chip">
                <bdi>#{topic.topic}</bdi>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <p className="yp-aside-foot">
        <Link href="/saved" className="muted">
          {t('m.saved.title')}
        </Link>{' '}
        ·{' '}
        <Link href="/settings" className="muted">
          {t('settings.title')}
        </Link>{' '}
        ·{' '}
        <Link href="/assistant" className="muted">
          {t('m.title.assistant')}
        </Link>{' '}
        ·{' '}
        <Link href="/developers" className="muted">
          {t('sidebar.developers')}
        </Link>{' '}
        ·{' '}
        <Link href="/legal" className="muted">
          {t('legal.title')}
        </Link>{' '}
        · © {new Date().getFullYear()} YAPILAPI
      </p>
    </aside>
  );
}
