'use client';

import type { ReactNode } from 'react';
import type { Post } from '@yapilapi/api-client';
import { PostCard } from '@yapilapi/ui';
import { usePostLabels } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { usePostActions } from '@/lib/post-actions';
import type { InfiniteState } from '@/lib/hooks';
import { ErrorView, FeedSkeleton, InfiniteFooter } from './common';
import { useI18n } from '@/i18n';

/** Renders an infinite list of real posts with skeleton / error / empty states and all interactions wired to the API. */
export function PostList({
  state,
  empty,
  label,
  explain = true,
}: {
  state: InfiniteState<Post>;
  empty: ReactNode;
  label: string;
  explain?: boolean;
}) {
  const labels = usePostLabels();
  const { t } = useI18n();
  const { user } = useSession();
  const { propsFor, dialogs } = usePostActions({ setItems: state.setItems, reload: state.reload });
  void user;

  if (state.loading) return <FeedSkeleton />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0) return <>{empty}</>;
  return (
    <>
      <ul className="stack post-list" aria-label={label}>
        {state.items.map((post) => (
          <li key={post.id}>
            <PostCard
              post={post}
              labels={labels}
              headingLevel={2}
              {...propsFor(post, { explain })}
            />
          </li>
        ))}
      </ul>
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
      <p className="yl-sr-only" role="status" aria-live="polite">
        {state.loadingMore ? t('common.loading') : ''}
      </p>
      {dialogs}
    </>
  );
}
