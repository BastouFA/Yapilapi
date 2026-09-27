'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon, MomentsStrip, Segments } from '@yapilapi/design-system';
import type { StoryGroup } from '@yapilapi/api-client';
import { useRouter } from 'next/navigation';
import { StoryViewer } from '@/components/StoryViewer';
import type { FeedMode } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { StarterRow } from '@/components/StarterRow';
import { SuggestedPeople } from '@/components/SuggestedPeople';
import { useSession } from '../../providers';

export default function Home() {
  const { t, unread, flags, locale } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<FeedMode>('for_you');
  const [moments, setMoments] = useState<StoryGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);

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
        <h1>{t('nav.home')}</h1>
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
              Real
            </Link>
          ) : null}
          {flags.REAL_TOGETHER ? (
            <Link href="/together" className="yp-btn yp-btn--ghost yp-btn--sm">
              Together
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

      <MomentsStrip groups={moments} onOpen={setViewing} onCreate={() => router.push('/camera?mode=story')} locale={locale} />

      <Segments
        label="Feed"
        value={mode}
        onChange={setMode}
        options={(['for_you', 'following', 'friends', 'communities', 'local'] as FeedMode[]).map((m) => ({ id: m, label: t(`feed.${m}`) }))}
      />

      {/* Someone who follows fewer than three people still gets a full Home: reels to start with and trending tags. */}
      <StarterRow />

      {mode === 'for_you' || mode === 'following' ? <SuggestedPeople /> : null}

      <PostList load={load} reloadKey={mode} sponsored={mode === 'for_you'} />

      {viewing !== null && moments[viewing] ? <StoryViewer groups={moments} start={viewing} onClose={() => setViewing(null)} onChange={setMoments} /> : null}
    </div>
  );
}
