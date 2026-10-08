'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { boostChoicesFrom, type BoostChoices } from '@/components/Boost';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import { FairStartCard } from '@/components/PassTheMic';
import { useSession } from '../../../providers';

/**
 * A single post, with every post action available (link target for notifications and search).
 * Without an account, a public post is readable and its actions lead to sign in; anything
 * else asks the person to sign in, without saying whether it exists.
 */
export default function PostPageClient({ isPublic }: { isPublic: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { me, t } = useSession();
  // Your own reel or Yap shows its fair start (how many new people it reached) above it.
  const [fairOf, setFairOf] = useState<{ author: string; format: 'reel' | 'yap' } | null>(null);
  const load = useCallback(
    () =>
      api.posts.get(id).then((r) => {
        setFairOf(r.post.format === 'reel' || r.post.format === 'yap' ? { author: r.post.author.id, format: r.post.format } : null);
        return { items: [r.post], nextCursor: null };
      }),
    [id],
  );
  const ownReel = !!me && fairOf?.author === me.id;
  // ?boost=1 (from the phone app's boost screen) opens the boost sheet on your own post, with its choices filled in.
  const [boost, setBoost] = useState<{ postId: string; choices?: BoostChoices } | undefined>(undefined);
  // ?comments=1 (a notification about a comment) opens the comments.
  const [comments, setComments] = useState<string | undefined>(undefined);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has('boost')) setBoost({ postId: id, choices: boostChoicesFrom(q) });
    if (q.has('comments')) setComments(id);
  }, [id]);
  if (!me && !isPublic) return <NeedsAccount title={t('postPage.signInTitle')} body={t('postPage.signInBody')} />;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.title.post')}</h1>
      </div>
      {ownReel ? <FairStartCard postId={id} format={fairOf?.format} /> : null}
      {/* One post: no "You're all caught up" under it. */}
      <PostList load={load} reloadKey={id} boost={boost} openComments={comments} showEnd={false} detail empty={t('postPage.unavailable')} />
      {!me ? <JoinNote text={t('postPage.join')} /> : null}
    </div>
  );
}
