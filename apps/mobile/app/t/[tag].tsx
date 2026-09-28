import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { ApiError, type StoryGroup, type TagSummary } from '../../../../packages/api-client/src/index';
import { normalizeTag } from '../../../../packages/shared/src/hashtags';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { StoriesStrip, StoryViewer } from '../../lib/stories';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, ScreenError, feedListProps, Loading, Segmented, useColors, useRefresh, userText } from '../../lib/ui';
import { router } from 'expo-router';

/** A hashtag: how many people use it, related tags, public stories with it now, recent or top posts, and following it. */
export default function TagScreen() {
  const params = useLocalSearchParams<{ tag: string }>();
  const tag = normalizeTag(decodeURIComponent(params.tag));
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

  const load = useCallback(
    async (next?: string) => {
      const page = await (await client()).tags.posts(tag, sort, next);
      setPosts((cur) => (next ? [...(cur ?? []), ...page.items] : page.items));
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
    void loadPosts();
  }, [loadPosts]);
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
            onPress={async () => {
              try {
                const api = await client();
                const r = info.following ? await api.tags.unfollow(tag) : await api.tags.follow(tag);
                setInfo({ ...info, following: r.following });
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        ) : null}
      </View>
      {info.related.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {info.related.map((r) => (
            <Pressable
              key={r}
              accessibilityRole="link"
              onPress={() => router.push(`/t/${encodeURIComponent(r)}`)}
              style={{ backgroundColor: c.surfaceSunken, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 13 }, userText]}>#{r}</Text>
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
    <>
      <FlatList
        keyboardShouldPersistTaps="handled"
        {...feedListProps}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3] }}
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        refreshControl={refresh}
        ListHeaderComponent={header}
        renderItem={({ item }) => <PostCard post={item} />}
        onEndReached={() => cursor && void load(cursor)}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={posts === null ? <Loading /> : error ? null : <EmptyState title={t('m.tag.empty')} />}
      />
      <StoryViewer groups={stories} start={viewing} onClose={() => setViewing(null)} onChange={setStories} />
    </>
  );
}
