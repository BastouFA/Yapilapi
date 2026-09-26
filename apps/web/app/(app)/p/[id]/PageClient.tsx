'use client';

import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import { useSession } from '../../../providers';

/**
 * A single post, with every post action available (link target for notifications and search).
 * Without an account, a public post is readable and its actions lead to sign in; anything
 * else asks the person to sign in, without saying whether it exists.
 */
export default function PostPageClient({ isPublic }: { isPublic: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { me } = useSession();
  const load = useCallback(() => api.posts.get(id).then((r) => ({ items: [r.post], nextCursor: null })), [id]);
  if (!me && !isPublic) return <NeedsAccount title="Sign in to see this post" body="It may be shared only with some people, or it may have been removed." />;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Post</h1>
      </div>
      <PostList load={load} reloadKey={id} empty="This post isn't available. It may have been removed, or it isn't shared with you." />
      {!me ? <JoinNote text="Join YAPILAPI to like, comment and follow the people you care about." /> : null}
    </div>
  );
}
