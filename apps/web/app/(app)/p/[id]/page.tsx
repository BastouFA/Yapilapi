'use client';

import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { PostList } from '@/components/PostList';

/** A single post, with every post action available (link target for notifications and search). */
export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  const load = useCallback(() => api.posts.get(id).then((r) => ({ items: [r.post], nextCursor: null })), [id]);
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Post</h1>
      </div>
      <PostList load={load} reloadKey={id} empty="This post isn't available. It may have been removed, or it isn't shared with you." />
    </div>
  );
}
