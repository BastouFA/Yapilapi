import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { ApiError, type StoryGroup, type TagSummary } from '../../../../packages/api-client/src/index';
import { normalizeTag } from '../../../../packages/shared/src/hashtags';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { RadioButton } from '../../lib/radio';
import { FeedSurfaceContext, useFeedViewability } from '../../lib/feed-events';
import { StoriesStrip, StoryViewer } from '../../lib/stories';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, ScreenError, feedListProps, Loading, Segmented, useColors, useRefresh, userText } from '../../lib/ui';
import { router } from 'expo-router';

/** The tag as given in the link; one that isn't validly encoded is used as it is. */
const decoded = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** A hashtag: how many people use it, related tags, public stories with it now, recent or top posts, and following it. */
export default function TagScreen() {
  // What people look at here teaches the recommender (POST /v1/feed/events).
  const viewability = useFeedViewability('tag');
  const params = useLocalSearchParams<{ tag: string }>();
  const tag = normalizeTag(decoded(params.tag));
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const [info, setInfo] = useState<TagSummary | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because the tag is invalid; a tag already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Stories now": active public stories with the tag (never followers-only or close friends ones).
  const [stories, setStories] = useState<StoryGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);

  const loadInfo = useCallback(async () => {
    void client()
      .then((api) => api.tags.stories(tag))
      .then(
        (r) => setStories(r.items),
        () => setStories((cur) => cur),
      );
    try {
      setInfo((await (await client()).tags.get(tag)) as TagSummary);
      setLoadError(null);
    } catch (e) {
      // An invalid tag is a 400.
      if (isGone(e) || (e instanceof ApiError && e.status === 400)) setInfo(null);
      else setLoadError(errorMessage(e));
    }
  }, [tag]);
  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  // Answers for a sort you've already left (or a first page asked for again) are dropped.
  const seq = useRef(0);
  const load = useCallback(
    async (next?: string) => {
      const run = next ? seq.current : ++seq.current;
      const page = await (await client()).tags.posts(tag, sort, next);
      if (run !== seq.current) return;
      setPosts((cur) => (next ? [...(cur ?? []), ...page.items.filter((x) => !cur?.some((y) => y.id === x.id))] : page.items));
      setCursor(page.nextCursor);
    },
    [tag, sort],
  );
  const loadPosts = useCallback(async () => {
    setError(null);
    try {
      await load();
    } catch (e) {
      setPosts((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [load]);
  useEffect(() => {
    setPosts(null);
    setCursor(null);
    void loadPosts();
  }, [loadPosts]);
  // The end of the list can be reached more than once before the next page arrives: ask once.
  const fetching = useRef<string | null>(null);
  const loadMore = () => {
    if (!cursor || fetching.current === cursor) return;
    fetching.current = cursor;
    void load(cursor)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        fetching.current = null;
      });
  };
  const [following, setFollowing] = useState(false);
  const refresh = useRefresh(() => Promise.all([loadInfo(), loadPosts()]));

  if (info === undefined) return loadError ? <ScreenError message={loadError} onRetry={loadInfo} /> : <Loading />;
  if (info === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.tag.empty')} action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void loadInfo() }} />
      </View>
    );

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <View style={{ backgroundColor: c.yapi, borderRadius: radius.lg, padding: space[6], gap: space[2] }}>
        <Text style={[{ color: c.onYapi, fontSize: 30, fontWeight: '800' }, userText]}>#{tag}</Text>
        <Text style={{ color: c.onYapi, fontSize: 14, fontWeight: '600' }}>
          {tp('m.tag.posts', info.posts)} · {tp('m.tag.people', info.people)}
        </Text>
        {me ? (
          <Button
            label={info.following ? t('m.tag.following') : t('m.tag.follow')}
            variant="secondary"
            size="sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={following}
            onPress={async () => {
              setFollowing(true);
              try {
                const api = await client();
                const r = info.following ? await api.tags.unfollow(tag) : await api.tags.follow(tag);
                setInfo({ ...info, following: r.following });
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setFollowing(false);
              }
            }}
          />
        ) : null}
        {/* The tag's Yaps, one after another. */}
        <View style={{ alignSelf: 'flex-start' }}>
          <RadioButton station={{ kind: 'topics', key: tag }} />
        </View>
      </View>
      {info.related.length ? (
        // Wrapped rows sit space[4] apart so each 30pt chip's slop (8 up and down) reaches 44 without overlapping the next row.
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: space[4], columnGap: space[2] }}>
          {info.related.map((r) => (
            <Pressable
              key={r}
              accessibilityRole="link"
              onPress={() => router.push(`/t/${encodeURIComponent(r)}`)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              style={{ backgroundColor: c.surfaceSunken, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 13, lineHeight: 18 }, userText]}>#{r}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {stories.length ? (
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.tag.storiesNow')}
          </Text>
          <StoriesStrip groups={stories} onOpen={setViewing} />
        </View>
      ) : null}
      <Segmented
        label={t('m.title.tag')}
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: t('m.tag.recent') },
          { id: 'top', label: t('m.tag.top') },
        ]}
      />
      {error ? <ErrorState message={error} onRetry={loadPosts} /> : null}
    </View>
  );

  return (
    <FeedSurfaceContext.Provider value="tag">
      <FlatList
        keyboardShouldPersistTaps="handled"
        {...feedListProps}
        {...viewability}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3] }}
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        refreshControl={refresh}
        ListHeaderComponent={header}
        renderItem={({ item }) => <PostCard post={item} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={posts === null ? <Loading /> : error ? null : <EmptyState title={t('m.tag.empty')} />}
      />
      <StoryViewer groups={stories} start={viewing} onClose={() => setViewing(null)} onChange={setStories} />
    </FeedSurfaceContext.Provider>
  );
}
