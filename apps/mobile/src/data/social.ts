import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Community, Post, Profile, UpdateProfileInput } from '@yapilapi/api-client';
import { useApi, useAuth } from '../auth/AuthProvider';
import { qk } from './keys';
import { usePaged } from './paged';
import type { DiscoverCommunity, SearchResponse } from '../api';

// ------------------------------------------------------------------ profiles
export function useProfile(username: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.profile(username),
    queryFn: ({ signal }) => api.profile.get(username, { signal }),
  });
}

export function useUserPosts(username: string, enabled = true) {
  const api = useApi();
  return usePaged<Post>(
    qk.userPosts(username),
    (cursor, signal) =>
      api.posts.byUser(username, { ...(cursor ? { cursor } : {}), limit: 15, signal }),
    { enabled },
  );
}

/** Follow / unfollow (or cancel a request) with an optimistic profile update. */
export function useFollow(username: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: Profile) => {
      if (p.viewer.following !== 'none') {
        await api.graph.unfollow(username);
        return 'none' as const;
      }
      return (await api.graph.follow(username)).status;
    },
    onMutate: (p) => {
      const willFollow = p.viewer.following === 'none';
      qc.setQueryData<Profile>(
        qk.profile(username),
        (old) =>
          old && {
            ...old,
            counts: {
              ...old.counts,
              followers: Math.max(
                0,
                old.counts.followers +
                  (willFollow ? (old.isPrivate ? 0 : 1) : p.viewer.following === 'active' ? -1 : 0),
              ),
            },
            viewer: {
              ...old.viewer,
              following: willFollow ? (old.isPrivate ? 'pending' : 'active') : 'none',
            },
          },
      );
      return { p };
    },
    onError: (_e, _p, ctx) => {
      if (ctx) qc.setQueryData(qk.profile(username), ctx.p);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.profile(username) });
    },
  });
}

export function useUpdateProfile() {
  const api = useApi();
  const { refresh } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) => api.profile.update(input),
    onSuccess: async () => {
      await refresh();
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

// ------------------------------------------------------------------ discover & search
export function useTrending() {
  const api = useApi();
  return usePaged<Post>(
    qk.trending(),
    (cursor, signal) =>
      api.discover.trending({ ...(cursor ? { cursor } : {}), limit: 10, signal }) as never,
  );
}
export function useSuggestedPeople() {
  const api = useApi();
  return useQuery({
    queryKey: qk.people(),
    queryFn: ({ signal }) => api.discover.people({ limit: 10, signal }),
  });
}
export function useDiscoverTopics() {
  const api = useApi();
  return useQuery({
    queryKey: qk.discoverTopics(),
    queryFn: ({ signal }) => api.discover.topics(16, { signal }),
  });
}
export function useDiscoverCommunities() {
  const api = useApi();
  return useQuery({
    queryKey: qk.discoverCommunities(),
    queryFn: ({ signal }) => api.discover.communities({ limit: 8, signal }),
  });
}
export function useSearch(q: string) {
  const api = useApi();
  const term = q.trim();
  return useQuery<SearchResponse>({
    queryKey: qk.search(term),
    queryFn: ({ signal }) =>
      api.search.query(term, { types: ['people', 'communities', 'posts'], limit: 10, signal }),
    enabled: term.length >= 2,
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ communities
export function useCommunities(q: string) {
  const api = useApi();
  return usePaged<Community>(qk.communities(q), (cursor, signal) =>
    api.communities.list({
      ...(cursor ? { cursor } : {}),
      limit: 15,
      ...(q.trim() ? { q: q.trim() } : {}),
      signal,
    }),
  );
}
export function useMyCommunities() {
  const api = useApi();
  return usePaged<Community>(qk.myCommunities(), (cursor, signal) =>
    api.communities.mine({ ...(cursor ? { cursor } : {}), limit: 30, signal }),
  );
}
export function useCommunity(idOrSlug: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.community(idOrSlug),
    queryFn: ({ signal }) => api.communities.get(idOrSlug, { signal }),
  });
}
export function useCommunityFeed(id: string | undefined, enabled: boolean) {
  const api = useApi();
  return usePaged<Post>(
    qk.communityFeed(id ?? ''),
    (cursor, signal) =>
      api.communities.feed(id!, { ...(cursor ? { cursor } : {}), limit: 15, signal }),
    { enabled: enabled && !!id },
  );
}
export function useJoinCommunity(idOrSlug: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: Community) => {
      if (c.viewer && (c.viewer.status === 'active' || c.viewer.status === 'pending'))
        return api.communities.leave(c.id);
      return api.communities.join(c.id);
    },
    onSettled: (_d, _e, c) => {
      void qc.invalidateQueries({ queryKey: qk.community(idOrSlug) });
      void qc.invalidateQueries({ queryKey: qk.community(c.id) });
      void qc.invalidateQueries({ queryKey: qk.communityFeed(c.id) });
      void qc.invalidateQueries({ queryKey: qk.myCommunities() });
      void qc.invalidateQueries({ queryKey: ['feed', 'communities'] });
    },
  });
}
export type { DiscoverCommunity };

// ------------------------------------------------------------------ friends, mute, block
/** Friend request flow driven by the current relationship: none -> send, pending_in -> accept, friends -> remove. */
export function useFriendAction(username: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: Profile) => {
      switch (p.viewer.friendship) {
        case 'none':
          return api.graph.sendFriendRequest(username);
        case 'pending_in':
          return api.graph.acceptFriendRequest(p.id);
        case 'friends':
          return api.graph.removeFriend(p.id);
        default:
          return undefined; // pending_out: the API has no "cancel request" endpoint
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.profile(username) });
    },
  });
}

export function useMuteToggle(username: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: Profile) => {
      if (p.viewer.muted) await api.graph.unmute(username);
      else await api.graph.mute(username);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.profile(username) });
      void qc.invalidateQueries({ queryKey: ['feed'] });
    },
  });
}

export function useBlockUser(username: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.graph.block(username),
    onSuccess: () => {
      // Everything of theirs must disappear from what this device has cached.
      qc.removeQueries({ queryKey: qk.profile(username) });
      qc.removeQueries({ queryKey: qk.userPosts(username) });
      void qc.invalidateQueries({ queryKey: ['feed'] });
      void qc.invalidateQueries({ queryKey: qk.conversations() });
      void qc.invalidateQueries({ queryKey: ['blocks'] });
    },
  });
}

export function useInvitations() {
  const api = useApi();
  return useQuery({
    queryKey: ['communityInvitations'],
    queryFn: ({ signal }) => api.communities.invitations({ limit: 20, signal }),
  });
}
export function useAnswerInvitation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      if (accept) await api.communities.acceptInvitation(id);
      else await api.communities.declineInvitation(id);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['communityInvitations'] });
      void qc.invalidateQueries({ queryKey: qk.myCommunities() });
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });
}
