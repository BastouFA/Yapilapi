import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import type { TagSummary } from '../../../../packages/api-client/src/index';
import { normalizeTag } from '../../../../packages/shared/src/hashtags';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, Loading, Notice, Segmented, useColors, userText } from '../../lib/ui';
import { router } from 'expo-router';

/** A hashtag: how many people use it, related tags, recent or top posts, and following it. */
export default function TagScreen() {
  const params = useLocalSearchParams<{ tag: string }>();
  const tag = normalizeTag(decodeURIComponent(params.tag));
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const [info, setInfo] = useState<TagSummary | null | undefined>(undefined);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setInfo((await (await client()).tags.get(tag)) as TagSummary))().catch(() => setInfo(null));
  }, [tag]);

  const load = useCallback(
    async (next?: string) => {
      const page = await (await client()).tags.posts(tag, sort, next);
      setPosts((cur) => (next ? [...(cur ?? []), ...page.items] : page.items));
      setCursor(page.nextCursor);
    },
    [tag, sort],
  );
  useEffect(() => {
    setPosts(null);
    void load().catch((e) => (setPosts([]), setError(errorMessage(e))));
  }, [load]);

  if (info === undefined) return <Loading />;
  if (info === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.tag.empty')} />
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
      <Segmented
        label={t('m.title.tag')}
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: t('m.tag.recent') },
          { id: 'top', label: t('m.tag.top') },
        ]}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3] }}
      data={posts ?? []}
      keyExtractor={(p) => p.id}
      ListHeaderComponent={header}
      renderItem={({ item }) => <PostCard post={item} />}
      onEndReached={() => cursor && void load(cursor)}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={posts === null ? <Loading /> : <EmptyState title={t('m.tag.empty')} />}
    />
  );
}
