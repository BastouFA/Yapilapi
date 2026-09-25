'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type Post, type ReactionKind } from '@yapilapi/api-client';
import {
  TrashIcon,
  useToast,
  type FeedbackAction,
  type MenuItemDef,
  type PostCardProps,
} from '@yapilapi/ui';
import { useApi } from './api';
import { describeError } from './errors';
import { localizeReason } from './labels';
import { useI18n } from '@/i18n';
import { ConfirmDialog } from '@/components/common';

type SetItems = (fn: (prev: Post[]) => Post[]) => void;

/**
 * Real, optimistic post interactions shared by every list of posts (feeds, profile, saved, detail).
 * Every mutation hits the API; on failure the UI rolls back and a toast explains why.
 */
export function usePostActions({
  setItems,
  reload,
  onDeleted,
}: {
  setItems: SetItems;
  reload?: () => void;
  onDeleted?: (id: string) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState<Post | null>(null);
  const [deleting, setDeleting] = useState(false);

  const patch = useCallback(
    (id: string, fn: (p: Post) => Post) =>
      setItems((list) => list.map((p) => (p.id === id ? fn(p) : p))),
    [setItems],
  );
  const fail = useCallback(
    (err: unknown) => {
      const d = describeError(err, t);
      toast.show({ tone: 'danger', title: t('error.actionFailed'), description: d.message });
    },
    [t, toast],
  );

  const react = useCallback(
    async (post: Post, kind: ReactionKind | null) => {
      const before = post;
      const had = post.viewer.reaction !== null;
      patch(post.id, (p) => ({
        ...p,
        viewer: { ...p.viewer, reaction: kind },
        counts: {
          ...p.counts,
          likes: Math.max(0, p.counts.likes + (kind && !had ? 1 : !kind && had ? -1 : 0)),
        },
      }));
      try {
        if (kind) {
          const r = await api.reactions.reactToPost(post.id, kind);
          patch(post.id, (p) => ({ ...p, counts: { ...p.counts, likes: r.likes } }));
        } else await api.reactions.removePostReaction(post.id);
      } catch (e) {
        patch(post.id, () => before);
        fail(e);
      }
    },
    [api, patch, fail],
  );

  const save = useCallback(
    async (post: Post, saved: boolean) => {
      const before = post;
      patch(post.id, (p) => ({
        ...p,
        viewer: { ...p.viewer, saved },
        counts: { ...p.counts, saves: Math.max(0, p.counts.saves + (saved ? 1 : -1)) },
      }));
      try {
        if (saved) await api.saves.save(post.id);
        else await api.saves.unsave(post.id);
        toast.show({ tone: 'success', title: saved ? t('post.saved') : t('post.unsaved') });
      } catch (e) {
        patch(post.id, () => before);
        fail(e);
      }
    },
    [api, patch, fail, t, toast],
  );

  const share = useCallback(
    async (post: Post) => {
      const url = `${window.location.origin}/post/${post.id}`;
      try {
        await navigator.clipboard.writeText(url);
        await api.posts.share(post.id, { channel: 'external' }).catch(() => undefined);
        patch(post.id, (p) => ({ ...p, counts: { ...p.counts, shares: p.counts.shares + 1 } }));
        toast.show({ tone: 'success', title: t('post.linkCopied') });
      } catch {
        toast.show({ tone: 'danger', title: t('post.copyFailed'), description: url });
      }
    },
    [api, patch, t, toast],
  );

  const vote = useCallback(
    async (post: Post, optionIds: string[]) => {
      try {
        const poll = await api.polls.vote(post.id, optionIds);
        patch(post.id, (p) => ({ ...p, poll }));
      } catch (e) {
        fail(e);
        if (e instanceof ApiError && e.code === 'conflict') reload?.();
      }
    },
    [api, patch, fail, reload],
  );

  const feedback = useCallback(
    async (post: Post, a: FeedbackAction) => {
      try {
        switch (a.type) {
          case 'more_like_this':
          case 'less_like_this':
            await api.feed.feedback(post.id, a.type);
            toast.show({
              tone: 'success',
              title:
                a.type === 'more_like_this' ? t('feedback.thanksMore') : t('feedback.thanksLess'),
            });
            break;
          case 'not_interested':
            await api.feed.feedback(post.id, 'not_interested');
            setItems((l) => l.filter((p) => p.id !== post.id));
            toast.show({ tone: 'success', title: t('feedback.hidden') });
            break;
          case 'mute_creator':
            await api.graph.mute(post.author.username);
            setItems((l) => l.filter((p) => p.author.id !== post.author.id));
            toast.show({
              tone: 'success',
              title: t('feedback.mutedCreator', { username: post.author.username }),
              action: {
                label: t('common.undo'),
                onClick: () => {
                  void api.graph
                    .unmute(post.author.username)
                    .then(() => reload?.())
                    .catch(fail);
                },
              },
            });
            break;
          case 'mute_topic': {
            const { items } = await api.topics.list();
            const slug = items.find((x) => x.name === a.topic)?.slug;
            if (!slug) throw new ApiError('not_found', t('feedback.topicMissing'), 404);
            await api.topics.mute(slug);
            setItems((l) => l.filter((p) => !p.topics.includes(a.topic)));
            toast.show({
              tone: 'success',
              title: t('feedback.mutedTopic', { topic: a.topic }),
              action: {
                label: t('common.undo'),
                onClick: () => {
                  void api.topics
                    .unmute(slug)
                    .then(() => reload?.())
                    .catch(fail);
                },
              },
            });
            break;
          }
        }
      } catch (e) {
        fail(e);
      }
    },
    [api, setItems, toast, t, reload, fail],
  );

  const loadReasons = useCallback(
    async (post: Post) => {
      const r = await api.feed.explain(post.id);
      return r.reasons.map((x) => localizeReason(x, t));
    },
    [api, t],
  );

  const confirmAndDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.posts.delete(confirmDelete.id);
      setItems((l) => l.filter((p) => p.id !== confirmDelete.id));
      onDeleted?.(confirmDelete.id);
      toast.show({ tone: 'success', title: t('post.deleted') });
      setConfirmDelete(null);
    } catch (e) {
      fail(e);
    } finally {
      setDeleting(false);
    }
  };

  const propsFor = useCallback(
    (
      post: Post,
      opts: { detail?: boolean; explain?: boolean } = {},
    ): Omit<PostCardProps, 'labels' | 'post'> => {
      const menuItems: MenuItemDef[] = post.viewer.isAuthor
        ? [
            {
              id: 'delete',
              label: t('post.delete'),
              icon: <TrashIcon size={16} />,
              danger: true,
              onSelect: () => setConfirmDelete(post),
            },
          ]
        : [];
      return {
        href: `/post/${post.id}`,
        onReact: (k) => react(post, k),
        onSave: (s) => save(post, s),
        onShare: () => share(post),
        onVote: (ids) => vote(post, ids),
        onFeedback: (a) => feedback(post, a),
        ...(opts.explain === false ? {} : { loadReasons: () => loadReasons(post) }),
        menuItems,
        ...(opts.detail ? { detail: true } : {}),
      };
    },
    [react, save, share, vote, feedback, loadReasons, t],
  );

  const dialogs: ReactNode = useMemo(
    () => (
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('post.deleteTitle')}
        description={t('post.deleteBody')}
        confirmLabel={t('common.delete')}
        danger
        busy={deleting}
        onConfirm={() => void confirmAndDelete()}
        onClose={() => setConfirmDelete(null)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirmDelete, deleting, t],
  );

  void router;
  return { propsFor, dialogs };
}
