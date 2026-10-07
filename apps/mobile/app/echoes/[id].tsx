import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import type { Post } from '../../../../packages/shared/src/types';
import { compactCount } from '../../../../packages/shared/src/post-stats';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, Icon, Loading, ScreenError, useColors, useRefresh, userText } from '../../lib/ui';

/** Echoes of one reel that you can see, newest first, with a way to add yours. */
export default function EchoesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, number, locale } = useT();
  const [original, setOriginal] = useState<Post | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone or private; a reel already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOriginal = useCallback(async () => {
    try {
      setOriginal((await (await client()).posts.get(id)).post);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setOriginal(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  const load = useCallback(
    async (next?: string) => {
      setError(null);
      try {
        const page = await (await client()).posts.echoes(id, next);
        setItems((cur) => (next ? [...(cur ?? []), ...page.items.filter((x) => !cur?.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setItems((cur) => cur ?? []);
        setError(errorMessage(e));
      }
    },
    [id],
  );
  useEffect(() => {
    void loadOriginal();
    void load();
  }, [loadOriginal, load]);
  const refresh = useRefresh(() => Promise.all([loadOriginal(), load()]));

  if (original === undefined) return loadError ? <ScreenError message={loadError} onRetry={loadOriginal} /> : <Loading />;
  if (original === null)
    return <EmptyState title={t('echo.block.unavailable')} action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void loadOriginal() }} />;
  const count = original.counts.echoes ?? 0;

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      {/* One line of text, about 20pt: the touch area reaches 44. */}
      <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/reels', params: { start: original.id } })} hitSlop={{ top: 12, bottom: 12 }}>
        <Text style={[{ color: c.yapi, fontWeight: '700', fontSize: 15 }, userText]}>{t('echo.list.intro', { name: original.author.displayName })}</Text>
      </Pressable>
      {count ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{tp('echo.count', count, { count: number(count) })}</Text> : null}
      {original.viewer.canEcho ? (
        <Button label={t('echo.action')} icon="git-compare-outline" onPress={() => router.push({ pathname: '/echo/[id]', params: { id: original.id } })} />
      ) : null}
      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4] }}
      columnWrapperStyle={{ gap: 4 }}
      data={items ?? []}
      numColumns={3}
      keyExtractor={(p) => p.id}
      refreshControl={refresh}
      ListHeaderComponent={header}
      ItemSeparatorComponent={() => <View style={{ height: 4 }} />}
      renderItem={({ item }) => {
        const m = item.media[0];
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.reels.by', { name: item.author.displayName })}
            onPress={() => router.push({ pathname: '/reels', params: { start: item.id } })}
            style={{ flex: 1 / 3, aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#05060B' }}
          >
            {m?.posterUrl ? <Image source={{ uri: mediaUrl(m.posterUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
            <View style={{ position: 'absolute', bottom: 6, start: 6, end: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {/* No number when the author hid their like counts. */}
              {item.counts.likes !== undefined ? (
                <>
                  <Icon name="heart" size={12} color="#FFFFFF" />
                  <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700' }}>{compactCount(item.counts.likes, locale)}</Text>
                </>
              ) : null}
              <Text style={[{ color: '#FFFFFF', fontSize: 12, flexShrink: 1 }, userText]} numberOfLines={1}>
                @{item.author.username}
              </Text>
            </View>
          </Pressable>
        );
      }}
      onEndReached={() => cursor && void load(cursor)}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={items === null ? <Loading /> : error ? null : <EmptyState title={t('echo.list.empty')} />}
    />
  );
}
