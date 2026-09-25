'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BottomSheet, Button, MomentsStrip, Segments } from '@yapilapi/design-system';
import { formatRelativeTime, type FeedMode, type PublicUser } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { useSession } from '../../providers';

type MomentGroup = { author: PublicUser; moments: { id: string; body: string; mediaUrl: string | null; mediaKind: string | null; createdAt: string }[] };

export default function Home() {
  const { t, locale, unread } = useSession();
  const [mode, setMode] = useState<FeedMode>('for_you');
  const [moments, setMoments] = useState<MomentGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    api.moments
      .list()
      .then((r) => setMoments(r.items as MomentGroup[]))
      .catch(() => {});
  }, []);

  const load = useCallback((cursor?: string) => api.feed(mode, cursor), [mode]);
  const group = viewing !== null ? moments[viewing] : null;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('nav.home')}</h1>
        <Link href="/notifications" className="yp-btn yp-btn--ghost" aria-label={`${t('notifications.title')}, ${unread.notifications} unread`}>
          {t('notifications.title')}
          {unread.notifications ? <span className="yp-unread">{unread.notifications}</span> : null}
        </Link>
      </div>

      <MomentsStrip groups={moments} onOpen={setViewing} onCreate={() => (location.href = '/create?moment=1')} />

      <Segments
        label="Feed"
        value={mode}
        onChange={setMode}
        options={(['for_you', 'following', 'friends', 'communities', 'local'] as FeedMode[]).map((m) => ({ id: m, label: t(`feed.${m}`) }))}
      />

      <PostList load={load} reloadKey={mode} />

      <BottomSheet open={!!group} onClose={() => setViewing(null)} title={group ? `${group.author.displayName}'s moments` : ''}>
        <div className="stack">
          {group?.moments.map((m) => (
            <figure key={m.id} className="stack-sm" style={{ margin: 0 }}>
              {m.mediaUrl && m.mediaKind === 'image' ? <img src={m.mediaUrl} alt="" style={{ borderRadius: 8 }} /> : null}
              {m.mediaUrl && m.mediaKind === 'video' ? <video src={m.mediaUrl} controls playsInline style={{ borderRadius: 8 }} /> : null}
              {m.body ? <figcaption>{m.body}</figcaption> : null}
              <span className="muted" style={{ fontSize: 12 }}>
                {formatRelativeTime(m.createdAt, locale)}
              </span>
            </figure>
          ))}
          {viewing !== null && viewing < moments.length - 1 ? (
            <Button variant="secondary" onClick={() => setViewing(viewing + 1)}>
              Next
            </Button>
          ) : null}
        </div>
      </BottomSheet>
    </div>
  );
}
