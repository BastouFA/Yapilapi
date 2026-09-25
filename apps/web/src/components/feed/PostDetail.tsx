'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Comment, Post } from '@yapilapi/api-client';
import {
  PostCard,
  CommentThread,
  ChevronStartIcon,
  useToast,
  type CommentNode,
  type CommentData,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { useCommentLabels, usePostLabels } from '@/lib/labels';
import { usePostActions } from '@/lib/post-actions';
import { describeError } from '@/lib/errors';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';

export function PostDetail({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const labels = usePostLabels();
  const commentLabels = useCommentLabels();
  const post = useAsync((signal) => api.posts.get(id, { signal }), [api, id]);
  const { setData } = post;
  const [toDelete, setToDelete] = useState<CommentData | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [replies, setReplies] = useState<
    Record<string, { items: Comment[]; loading: boolean; cursor: string | null }>
  >({});
  const counted = useRef<string | null>(null);

  usePageTitle(
    post.data ? t('post.pageTitle', { name: post.data.author.displayName }) : t('post.detailTitle'),
    t('app.name'),
  );

  const comments = useInfinite(
    (cursor, signal) =>
      api.comments.list(id, { sort: 'new', ...(cursor ? { cursor } : {}), limit: 20, signal }),
    `comments:${id}`,
  );

  // Count one view per page load of a post that loaded successfully.
  useEffect(() => {
    if (post.data && counted.current !== id) {
      counted.current = id;
      void api.posts.recordView(id).catch(() => undefined);
    }
  }, [post.data, id, api]);

  const setItems = useCallback(
    (fn: (prev: Post[]) => Post[]) => setData((p) => (p ? fn([p])[0] : p)),
    [setData],
  );
  const { propsFor, dialogs } = usePostActions({
    setItems,
    reload: post.reload,
    onDeleted: () => router.replace('/'),
  });

  const bumpCount = (delta: number) =>
    setData((p) =>
      p ? { ...p, counts: { ...p.counts, comments: Math.max(0, p.counts.comments + delta) } } : p,
    );

  const submit = async (body: string, parentId?: string) => {
    try {
      const c = await api.comments.create(id, body, parentId);
      if (parentId) {
        setReplies((r) => ({
          ...r,
          [parentId]: {
            items: [...(r[parentId]?.items ?? []), c],
            loading: false,
            cursor: r[parentId]?.cursor ?? null,
          },
        }));
        comments.setItems((list) =>
          list.map((x) =>
            x.id === parentId
              ? { ...x, counts: { ...x.counts, replies: x.counts.replies + 1 } }
              : x,
          ),
        );
      } else {
        comments.setItems((list) => [c, ...list]);
      }
      if (!c.pendingApproval) bumpCount(1);
    } catch (e) {
      throw new Error(describeError(e, t).message);
    }
  };

  const loadReplies = (commentId: string) => {
    const cur = replies[commentId];
    if (cur?.loading) return;
    setReplies((r) => ({
      ...r,
      [commentId]: {
        items: r[commentId]?.items ?? [],
        loading: true,
        cursor: r[commentId]?.cursor ?? null,
      },
    }));
    const cursor = cur?.cursor ?? undefined;
    api.comments.replies(commentId, { ...(cursor ? { cursor } : {}), limit: 20 }).then(
      (page) =>
        setReplies((r) => ({
          ...r,
          [commentId]: {
            items: [...(cursor ? (r[commentId]?.items ?? []) : []), ...page.items],
            loading: false,
            cursor: page.nextCursor,
          },
        })),
      (e: unknown) => {
        setReplies((r) => ({
          ...r,
          [commentId]: {
            items: r[commentId]?.items ?? [],
            loading: false,
            cursor: r[commentId]?.cursor ?? null,
          },
        }));
        toast.show({
          tone: 'danger',
          title: t('error.actionFailed'),
          description: describeError(e, t).message,
        });
      },
    );
  };

  const react = async (c: CommentData, reacted: boolean) => {
    const apply = (on: boolean) => {
      const fn = (x: Comment): Comment =>
        x.id === c.id
          ? {
              ...x,
              viewer: { ...x.viewer, reaction: on ? 'like' : null },
              counts: { ...x.counts, likes: Math.max(0, x.counts.likes + (on ? 1 : -1)) },
            }
          : x;
      comments.setItems((l) => l.map(fn));
      setReplies((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, { ...v, items: v.items.map(fn) }]),
        ),
      );
    };
    apply(reacted);
    try {
      if (reacted) await api.reactions.reactToComment(c.id, 'like');
      else await api.reactions.removeCommentReaction(c.id);
    } catch (e) {
      apply(!reacted);
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.comments.delete(toDelete.id);
      const gone = toDelete;
      if (gone.parentId) {
        setReplies((r) => ({
          ...r,
          [gone.parentId!]: {
            ...(r[gone.parentId!] ?? { loading: false, cursor: null }),
            items: (r[gone.parentId!]?.items ?? []).filter((x) => x.id !== gone.id),
          },
        }));
        comments.setItems((l) =>
          l.map((x) =>
            x.id === gone.parentId
              ? { ...x, counts: { ...x.counts, replies: Math.max(0, x.counts.replies - 1) } }
              : x,
          ),
        );
      } else {
        comments.setItems((l) => l.filter((x) => x.id !== gone.id));
      }
      bumpCount(-1);
      toast.show({ tone: 'success', title: t('comments.deleted') });
      setToDelete(null);
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setDeleting(false);
    }
  };

  if (post.loading && !post.data) return <PageSpinner />;
  if (post.error && !post.data) return <ErrorView error={post.error} onRetry={post.reload} />;
  if (!post.data) return null;

  const nodes: CommentNode[] = comments.items.map((c) => {
    const r = replies[c.id];
    return r
      ? { ...c, replies: r.items, repliesLoading: r.loading, repliesHasMore: r.cursor !== null }
      : c;
  });

  return (
    <>
      <nav aria-label={t('post.backNav')} className="crumb">
        <Link href="/" className="crumb__link">
          <ChevronStartIcon size={16} /> {t('common.back')}
        </Link>
      </nav>
      <h1 className="yl-sr-only">{t('post.pageTitle', { name: post.data.author.displayName })}</h1>
      <PostCard
        post={post.data}
        labels={labels}
        headingLevel={2}
        {...propsFor(post.data, { detail: true, explain: false })}
      />
      <div className="detail-comments">
        {comments.error ? (
          <ErrorView error={comments.error} onRetry={comments.reload} />
        ) : (
          <CommentThread
            comments={nodes}
            labels={commentLabels}
            hasMore={comments.hasMore}
            loadingMore={comments.loadingMore || comments.loading}
            onLoadMore={comments.loadMore}
            onSubmit={submit}
            onLoadReplies={loadReplies}
            onReact={react}
            onDelete={(c) => setToDelete(c)}
            canModerate={post.data.viewer.isAuthor}
            headingLevel={2}
          />
        )}
      </div>
      {dialogs}
      <ConfirmDialog
        open={toDelete !== null}
        title={t('comments.deleteTitle')}
        description={t('comments.deleteBody')}
        confirmLabel={t('common.delete')}
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
