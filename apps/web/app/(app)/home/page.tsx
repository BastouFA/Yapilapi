'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon, MomentsStrip, Segments } from '@yapilapi/design-system';
import type { StoryGroup } from '@yapilapi/api-client';
import { useRouter } from 'next/navigation';
import type { FeedMode } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { StarterRow } from '@/components/StarterRow';
import { CatchUpCard } from '@/components/AiHelpers';
import { SuggestedPeople } from '@/components/SuggestedPeople';
import { PulseCards } from '@/components/WeeklyWrap';
import { FollowingDrops } from '@/components/Drops';
import { ScreenLoading } from '@/components/Loading';
import { useSession } from '../../providers';

// The story viewer opens full screen when a story is tapped, so it downloads then.
const StoryViewer = dynamic(() => import('@/components/StoryViewer').then((m) => m.StoryViewer), {
  ssr: false,
  loading: () => <ScreenLoading className="story" />,
});

export default function Home() {
  const { t, unread, flags, locale } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<FeedMode>('for_you');
  const [moments, setMoments] = useState<StoryGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  // Yaps (voice posts) have their own feed while the feature is on.
  const yapsOn = flags.YAPS !== false;
  // Yaps come first after For you: YAPILAPI is the social network you speak.
  const modes: FeedMode[] = ['for_you', ...(yapsOn ? (['yaps'] as const) : []), 'following', 'friends', 'communities', 'local'];
  // ?mode=yaps (after posting a Yap) opens that feed.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('mode') === 'yaps') setMode('yaps');
  }, []);
  useEffect(() => {
    if (!yapsOn) setMode((m) => (m === 'yaps' ? 'for_you' : m));
  }, [yapsOn]);

  useEffect(() => {
    api.moments
      .list()
      .then((r) => setMoments(r.items))
      .catch(() => {});
  }, []);

  const load = useCallback((cursor?: string) => api.feed(mode, cursor), [mode]);

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1 className="topbar__word">{t('nav.home')}</h1>
        {/* Icons on the right keep the title on one line at phone widths. */}
        <div className="row home__actions">
          <Link href="/search" className="yp-action home__search" aria-label={t('home.search')}>
            <Icon name="search" />
          </Link>
          <Link href="/reels" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('m.title.reels')}
          </Link>
          {flags.REAL ? (
            <Link href="/real" className="yp-btn yp-btn--ghost yp-btn--sm">
              {t('m.title.real')}
            </Link>
          ) : null}
          {flags.REAL_TOGETHER ? (
            <Link href="/together" className="yp-btn yp-btn--ghost yp-btn--sm">
              {t('together.title')}
            </Link>
          ) : null}
          <Link
            href="/notifications"
            className="yp-action home__bell"
            aria-label={unread.notifications ? t('home.notificationsUnread', { count: unread.notifications }) : t('notifications.title')}
          >
            <Icon name="bell" />
            {unread.notifications ? (
              <span className="home__bell-count" aria-hidden>
                {unread.notifications > 99 ? '99+' : unread.notifications}
              </span>
            ) : null}
          </Link>
        </div>
      </div>

      {/* This week's wrap and "On this day", when there are any: gentle, and easy to put away. */}
      <PulseCards />

      <MomentsStrip groups={moments} onOpen={setViewing} onCreate={() => router.push('/camera?mode=story')} locale={locale} />

      {/* After 12 hours or more away: a summary of what your people shared, on request. */}
      <CatchUpCard />

      {/* Launches from people you follow: when they open, and a Notify me on each drop's page. */}
      <FollowingDrops />

      <Segments label={t('m.feed.label')} value={mode} onChange={setMode} options={modes.map((m) => ({ id: m, label: t(`feed.${m}`) }))} />

      {/* Someone who follows fewer than three people still gets a full Home: reels to start with and trending tags. */}
      <StarterRow />

      {mode === 'for_you' || mode === 'following' ? <SuggestedPeople /> : null}

      <PostList
        load={load}
        reloadKey={mode}
        sponsored={mode === 'for_you'}
        surface={mode === 'local' ? 'other' : mode}
        // Communities, Local and Yaps fill up in their own ways: say how.
        {...(mode === 'communities'
          ? { emptyTitle: t('feed.empty.communities.title'), empty: t('feed.empty.communities.body') }
          : mode === 'local'
            ? { emptyTitle: t('feed.empty.local.title'), empty: t('feed.empty.local.body') }
            : mode === 'yaps'
              ? {
                  emptyTitle: t('feed.empty.yaps.title'),
                  empty: t('feed.empty.yaps.body'),
                  emptyAction: (
                    <Link href="/create?mode=yap" className="yp-btn yp-btn--primary">
                      <Icon name="mic" />
                      {t('voice.recordYap')}
                    </Link>
                  ),
                }
              : {})}
      />

      {viewing !== null && moments[viewing] ? <StoryViewer groups={moments} start={viewing} onClose={() => setViewing(null)} onChange={setMoments} /> : null}
    </div>
  );
}
