import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedMode, FeedSignal, Post } from '@yapilapi/api-client';
import { useApi } from '../auth/AuthProvider';
import { removePost } from './cache';
import { qk } from './keys';
import { usePaged } from './paged';

export const FEED_MODES: readonly FeedMode[] = [
  'for_you',
  'following',
  'friends',
  'communities',
  'local',
];
export interface Geo {
  lat: number;
  lng: number;
}
export const geoKey = (g: Geo | null | undefined) =>
  g ? `${g.lat.toFixed(2)},${g.lng.toFixed(2)}` : '';

export function useFeed(mode: FeedMode, geo: Geo | null = null, opts: { limit?: number } = {}) {
  const api = useApi();
  const paged = usePaged<Post & { reasons?: string[] }>(
    qk.feed(mode, geoKey(geo)),
    (cursor, signal) =>
      api.feed.get(
        {
          mode,
          ...(cursor ? { cursor } : {}),
          limit: opts.limit ?? 15,
          ...(geo ? { lat: geo.lat, lng: geo.lng } : {}),
        },
        { signal },
      ) as never,
    { enabled: mode !== 'local' || geo !== null },
  );
  const qc = useQueryClient();
  /** Pull-to-refresh: restart from the newest page (old cursors would splice stale and fresh items together). */
  const refresh = async () => {
    qc.setQueryData<{ pages: unknown[]; pageParams: unknown[] }>(qk.feed(mode, geoKey(geo)), (d) =>
      d ? { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) } : d,
    );
    await paged.refetch();
  };
  return { ...paged, refresh };
}

export function useFeedExplain(postId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk.explain(postId ?? ''),
    queryFn: ({ signal }) => api.feed.explain(postId!, { signal }),
    enabled: postId !== null,
    staleTime: 5 * 60_000,
  });
}

export function useTopicList() {
  const api = useApi();
  return useQuery({
    queryKey: qk.topics(),
    queryFn: ({ signal }) => api.topics.list({ signal }),
    staleTime: 60 * 60_000,
  });
}

export type FeedControl =
  | 'more_like_this'
  | 'less_like_this'
  | 'not_interested'
  | 'hide_creator'
  | 'mute_creator'
  | 'mute_topic';

/** "Why am I seeing this?" controls. Signals that mean "hide it" also drop the post from every cached list right away. */
export function useFeedControl() {
  const api = useApi();
  const qc = useQueryClient();
  const topics = useTopicList();
  return useMutation({
    mutationFn: async ({ post, control }: { post: Post; control: FeedControl }) => {
      switch (control) {
        case 'more_like_this':
        case 'less_like_this':
        case 'not_interested':
        case 'hide_creator':
          await api.feed.feedback(post.id, control as FeedSignal);
          return;
        case 'mute_creator':
          await api.graph.mute(post.author.username);
          return;
        case 'mute_topic': {
          // Posts carry topic display names, the mute endpoint wants the slug.
          const list = topics.data?.items ?? (await api.topics.list()).items;
          for (const name of post.topics) {
            const slug = list.find((t) => t.name === name)?.slug;
            if (slug) await api.topics.mute(slug);
          }
        }
      }
    },
    onSuccess: (_d, { post, control }) => {
      if (
        control === 'not_interested' ||
        control === 'hide_creator' ||
        control === 'mute_creator' ||
        control === 'mute_topic'
      )
        removePost(qc, post.id);
    },
  });
}
