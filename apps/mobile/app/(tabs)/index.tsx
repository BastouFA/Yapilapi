import { Redirect, router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import type { StoryGroup } from '../../../../packages/api-client/src/index';
import type { FeedMode } from '../../../../packages/shared/src/constants';
import type { Post } from '../../../../packages/shared/src/types';
import type { MessageKey } from '../../../../packages/shared/src/i18n-core';
import { client, errorMessage } from '../../lib/api';
import { AnnouncementCard } from '../../lib/announcement';
import { feedSurface, FeedSurfaceContext, useFeedViewability } from '../../lib/feed-events';
import { onBackOnline } from '../../lib/network';
import { PulseEmpty } from '../../lib/empty';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { orderStories, StoriesStrip, StoryViewer } from '../../lib/stories';
import { useSession } from '../../lib/session';
import { StarterRow } from '../../lib/starter';
import { CatchUpCard } from '../../lib/ai-helpers';
import { PulseCards } from '../../lib/wrap';
import { TodayCard } from '../../lib/today';
import { FollowingDrops } from '../../lib/drops';
import { space } from '../../lib/theme';
import { useFlag } from '../../lib/flags';
import { ErrorState, feedListProps, Icon, Loading, Segmented, SkeletonList, slop, useColors, useTabBarSpace } from '../../lib/ui';

const MODES = [
  { id: 'for_you', label: 'feed.for_you' },
  { id: 'following', label: 'feed.following' },
  { id: 'friends', label: 'feed.friends' },
  { id: 'communities', label: 'feed.communities' },
  { id: 'local', label: 'feed.local' },
  // Yaps only (voice posts); not shown while the YAPS flag is off.
  { id: 'yaps', label: 'feed.yaps' },
] as const satisfies readonly { id: FeedMode; label: MessageKey }[];

/** Home: the welcome screen if signed out, then stories and the feed with cursor pagination. */
export default function Home() {
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me) return <Redirect href="/welcome" />;
  // New accounts go through the three onboarding steps first, so Home starts full.
  if (!me.onboarded) return <Redirect href="/onboarding" />;
  return <Feed />;
}

/** Outside the component, so it's the same function on every render and the list leaves its rows alone. */
const renderPost = ({ item }: { item: Post }) => <PostCard post={item} />;

function Feed() {
  const c = useColors();
  const { t } = useT();
  const bottom = useTabBarSpace();
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>('for_you');
  const yapsOn = useFlag('YAPS') !== false;
  const modes = yapsOn ? MODES : MODES.filter((m) => m.id !== 'yaps');
  // Yaps turned off while showing them: back to For you.
  useEffect(() => {
    if (!yapsOn && mode === 'yaps') setMode('for_you');
  }, [yapsOn, mode]);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stories, setStories] = useState<StoryGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const navigation = useNavigation();
  // What's seen and for how long, for the recommender, under the mode on screen.
  const surface = feedSurface(mode);
  const viewability = useFeedViewability(surface);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        // 16pt apart: the bell's touch area reaches 44 wide mostly away from Reels, so the two don't overlap.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[4], marginEnd: space[4] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('notifications.title')}
            hitSlop={slop({ top: 11, bottom: 11, start: 14, end: 8 })}
            onPress={() => router.push('/notifications')}
          >
            <Icon name="notifications-outline" size={22} color={c.yapi} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.title.reels')}
            hitSlop={slop({ top: 11, bottom: 11, start: 8, end: 10 })}
            onPress={() => router.push('/reels')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <Icon name="film-outline" size={22} color={c.yapi} />
            <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 15 }}>{t('m.title.reels')}</Text>
          </Pressable>
        </View>
      ),
    });
  }, [navigation, c.yapi, t]);

  const loadStories = useCallback(async () => {
    try {
      setStories(orderStories((await (await client()).moments.list()).items));
    } catch {
      // Stories are a bonus on Home: the feed still works without them.
    }
  }, []);
  // Refresh when coming back (after adding a story in Create, for example), not while one is open.
  useFocusEffect(
    useCallback(() => {
      if (viewing === null) void loadStories();
    }, [loadStories, viewing]),
  );

  // Answers for a mode you've already left (or a first page asked for again) are dropped.
  const seq = useRef(0);
  const load = useCallback(
    async (next?: string) => {
      const run = next ? seq.current : ++seq.current;
      try {
        const page = await (await client()).feed(mode, next);
        if (run !== seq.current) return;
        // A post can move down between pages (a repost, a new ranking): it shows once.
        setPosts((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        if (run !== seq.current) return;
        setError(errorMessage(e));
        setPosts((cur) => cur ?? []);
      }
    },
    [mode],
  );

  useEffect(() => {
    setPosts(null);
    setCursor(null);
    void load();
  }, [load]);

  // The end of the list can be reached more than once before a page arrives: ask for each page once.
  const fetching = useRef<string | null>(null);
  const loadMore = useCallback(() => {
    if (!cursor || fetching.current === cursor) return;
    fetching.current = cursor;
    void load(cursor).finally(() => {
      fetching.current = null;
    });
  }, [cursor, load]);

  // Offline, then back: fetch again, so the feed isn't left with an error.
  useEffect(() => onBackOnline(() => void Promise.all([load(), loadStories()])), [load, loadStories]);

  // Just published from Create: put it at the top, as people expect to see what they posted.
  const { posted } = useLocalSearchParams<{ posted?: string }>();
  useEffect(() => {
    if (!posted) return;
    void (async () => {
      try {
        const { post } = await (await client()).posts.get(posted);
        setPosts((cur) => [post, ...(cur ?? []).filter((p) => p.id !== post.id)]);
      } catch {
        // Not visible (e.g. waiting for review): the feed stays as it is.
      }
    })();
  }, [posted]);

  return (
    <FeedSurfaceContext.Provider value={surface}>
      <FlatList
        keyboardShouldPersistTaps="handled"
        {...feedListProps}
        {...viewability}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          <View style={{ gap: space[3] }}>
            {/* A note from the team to everyone, until it ends or you close it. */}
            <AnnouncementCard />
            {/* In the morning: Yapilapi Today, a short briefing of what your people and your city are talking about. */}
            <TodayCard />
            <StoriesStrip groups={stories} onOpen={setViewing} onCreate={() => router.push({ pathname: '/camera', params: { mode: 'story' } })} />
            {/* After 12 hours or more away: a summary of what your people shared, on request. */}
            <CatchUpCard />
            {/* Your weekly wrap and "On this day", when there are any: quiet, and easy to put away. */}
            <PulseCards />
            {/* Launches from people you follow: when they open, and a Notify me on each drop. */}
            <FollowingDrops />
            {/* With nothing in the feed, the empty state below does the starter row's job. */}
            {posts?.length ? <StarterRow /> : null}
            <Segmented label={t('m.feed.label')} options={modes.map((m) => ({ id: m.id, label: t(m.label) }))} value={mode} onChange={setMode} />
            {error ? <ErrorState message={error} onRetry={() => Promise.all([load(), loadStories()])} /> : null}
          </View>
        }
        refreshControl={
          <RefreshControl
            tintColor={c.yapi}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([load(), loadStories()]);
              setRefreshing(false);
            }}
          />
        }
        onEndReached={loadMore}
        ListEmptyComponent={
          posts === null ? (
            <SkeletonList kind="post" />
          ) : error ? null : (
            <PulseEmpty mode={mode} onFollowed={() => void load()} onShowForYou={mode === 'for_you' ? undefined : () => setMode('for_you')} />
          )
        }
        ListFooterComponent={
          posts?.length ? (
            <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>{cursor ? t('m.common.loadingMore') : t('feed.end')}</Text>
          ) : null
        }
        renderItem={renderPost}
      />
      <StoryViewer groups={stories} start={viewing} onClose={() => setViewing(null)} onChange={setStories} />
    </FeedSurfaceContext.Provider>
  );
}
