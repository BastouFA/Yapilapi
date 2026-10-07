'use client';

import { useCallback } from 'react';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import { ReelsViewer } from '@/components/reels/ReelsViewer';
import { useSession } from '../../providers';

/**
 * Reels for people with an account (the full-screen viewer, components/reels). Without one, a
 * shared public reel (?start=) opens on its own, readable, with its actions leading to sign in;
 * the Reels feed itself needs an account.
 */
export default function ReelsPageClient({ start, isPublic }: { start: string | null; isPublic: boolean }) {
  const { me, t } = useSession();
  if (me) return <ReelsViewer />;
  if (!start || !isPublic) return <NeedsAccount title={t('reel.signIn.title')} body={t('reel.signIn.body')} />;
  return <SharedReel id={start} />;
}

function SharedReel({ id }: { id: string }) {
  const { t } = useSession();
  const load = useCallback(() => api.posts.get(id).then((r) => ({ items: [r.post], nextCursor: null })), [id]);
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('reel.single')}</h1>
      </div>
      <PostList load={load} reloadKey={id} surface="reels" empty={t('reel.unavailable')} />
      <JoinNote text={t('reel.join')} />
    </div>
  );
}
