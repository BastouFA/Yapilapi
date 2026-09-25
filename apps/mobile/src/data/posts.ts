import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Comment, Post, ReactionKind } from '@yapilapi/api-client';
import { useApi } from '../auth/AuthProvider';
import { patchPost, removePost } from './cache';
import { qk } from './keys';
import { usePaged } from './paged';

export function usePost(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.post(id),
    queryFn: ({ signal }) => api.posts.get(id, { signal }),
  });
}

/** Like / unlike with an optimistic update everywhere the post is cached; rolls back on failure. */
export function useReactPost() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ post, kind }: { post: Post; kind?: ReactionKind }) => {
      if (post.viewer.reaction && (!kind || kind === post.viewer.reaction)) {
        await api.reactions.removePostReaction(post.id);
        return null;
      }
      return (await api.reactions.reactToPost(post.id, kind ?? 'like')).reaction;
    },
    onMutate: async ({ post, kind }) => {
      const removing = Boolean(post.viewer.reaction && (!kind || kind === post.viewer.reaction));
      const next: ReactionKind | null = removing ? null : (kind ?? 'like');
      const delta = removing ? -1 : post.viewer.reaction ? 0 : 1;
      patchPost(qc, post.id, (p) => ({
        ...p,
        counts: { ...p.counts, likes: Math.max(0, p.counts.likes + delta) },
        viewer: { ...p.viewer, reaction: next },
      }));
      return { post };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) patchPost(qc, ctx.post.id, () => ctx.post);
    },
  });
}

export function useSavePost() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (post: Post) => {
      if (post.viewer.saved) await api.saves.unsave(post.id);
      else await api.saves.save(post.id);
    },
    onMutate: (post) => {
      patchPost(qc, post.id, (p) => ({
        ...p,
        viewer: { ...p.viewer, saved: !post.viewer.saved },
        counts: { ...p.counts, saves: Math.max(0, p.counts.saves + (post.viewer.saved ? -1 : 1)) },
      }));
      return { post };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) patchPost(qc, ctx.post.id, () => ctx.post);
    },
  });
}

export function useDeletePost() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.posts.delete(id),
    onSuccess: (_d, id) => removePost(qc, id),
  });
}

export function useVotePoll() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, optionIds }: { postId: string; optionIds: string[] }) =>
      api.polls.vote(postId, optionIds),
    onSuccess: (poll, { postId }) => patchPost(qc, postId, (p) => ({ ...p, poll })),
  });
}

export function useComments(postId: string, sort: 'new' | 'old' = 'new') {
  const api = useApi();
  return usePaged<Comment>(qk.comments(postId), (cursor, signal) =>
    api.comments.list(postId, { ...(cursor ? { cursor } : {}), limit: 20, sort, signal }),
  );
}

export function useReplies(commentId: string, enabled: boolean) {
  const api = useApi();
  return usePaged<Comment>(
    qk.replies(commentId),
    (cursor, signal) =>
      api.comments.replies(commentId, { ...(cursor ? { cursor } : {}), limit: 20, signal }),
    { enabled },
  );
}

export function useCreateComment(postId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, parentId }: { body: string; parentId?: string }) =>
      api.comments.create(postId, body, parentId),
    onSuccess: (c, { parentId }) => {
      patchPost(qc, postId, (p) => ({
        ...p,
        counts: { ...p.counts, comments: p.counts.comments + 1 },
      }));
      void qc.invalidateQueries({
        queryKey: parentId ? qk.replies(parentId) : qk.comments(postId),
      });
      if (parentId) void qc.invalidateQueries({ queryKey: qk.comments(postId) });
      return c;
    },
  });
}

export function useReactComment(postId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: Comment) => {
      if (c.viewer.reaction) await api.reactions.removeCommentReaction(c.id);
      else await api.reactions.reactToComment(c.id, 'like');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.comments(postId) });
      void qc.invalidateQueries({ queryKey: ['replies'] });
    },
  });
}
