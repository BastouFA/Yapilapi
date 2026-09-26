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
import { SuggestedPeople } from '@/components/SuggestedPeople';
import { useSession } from '../../providers';

export default function Home() {
  const { t, unread, flags } = useSession();
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
        <div className="row">
          <Link href="/search" className="yp-action home__search" aria-label="Search">
            <Icon name="search" />
          </Link>
          <Link href="/reels" className="yp-btn yp-btn--secondary yp-btn--sm">
            Reels
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
        </div>
        <Link href="/notifications" className="yp-btn yp-btn--ghost" aria-label={`${t('notifications.title')}, ${unread.notifications} unread`}>
          {t('notifications.title')}
          {unread.notifications ? <span className="yp-unread">{unread.notifications}</span> : null}
        </Link>
      </div>

      <MomentsStrip groups={moments} onOpen={setViewing} onCreate={() => router.push('/create?mode=story')} />

      <Segments
        label="Feed"
        value={mode}
        onChange={setMode}
        options={(['for_you', 'following', 'friends', 'communities', 'local'] as FeedMode[]).map((m) => ({ id: m, label: t(`feed.${m}`) }))}
      />

      {mode === 'for_you' || mode === 'following' ? <SuggestedPeople /> : null}

      <PostList load={load} reloadKey={mode} sponsored={mode === 'for_you'} />

      {viewing !== null && moments[viewing] ? <StoryViewer groups={moments} start={viewing} onClose={() => setViewing(null)} onChange={setMoments} /> : null}
    </div>
  );
}
