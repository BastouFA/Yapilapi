import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import type { Post, Sound } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { clock } from '../../lib/media';
import { useSession } from '../../lib/session';
import { gradient, radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Icon, Loading, ScreenError, Segmented, useColors, useRefresh, userText } from '../../lib/ui';
import { LinearGradient } from 'expo-linear-gradient';

/** A sound: play it, who made it, the reels that use it (most recent or top), and "Use this sound". */
export default function SoundScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const [sound, setSound] = useState<Sound | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone; a sound already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const [reels, setReels] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOne = useCallback(async () => {
    try {
      const r = await (await client()).sounds.get(id);
      setSound(r.sound);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setSound(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    setSound(undefined);
    void loadOne();
  }, [loadOne]);

  const load = useCallback(
    async (next?: string) => {
      const page = await (await client()).sounds.reels(id, sort, next);
      setReels((cur) => (next ? [...(cur ?? []), ...page.items.filter((x) => !cur?.some((y) => y.id === x.id))] : page.items));
      setCursor(page.nextCursor);
    },
    [id, sort],
  );
  const loadList = useCallback(async () => {
    setError(null);
    try {
      await load();
    } catch (e) {
      setReels((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [load]);
  useEffect(() => {
    setReels(null);
    void loadList();
  }, [loadList]);
  const refresh = useRefresh(() => Promise.all([loadOne(), loadList()]));

  if (sound === undefined) return loadError ? <ScreenError message={loadError} onRetry={loadOne} /> : <Loading />;
  if (sound === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.sound.missing')} action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void loadOne() }} />
      </View>
    );

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'center' }}>
        <View style={{ width: 112, height: 112, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surfaceSunken }}>
          {sound.coverUrl ? <Image source={{ uri: mediaUrl(sound.coverUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
          <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' }}>
            {sound.audioUrl ? <PlayButton url={mediaUrl(sound.audioUrl)} /> : null}
          </View>
        </View>
        <View style={{ flex: 1, gap: space[1] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="musical-notes" size={18} color={c.ink} />
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 20, fontWeight: '800', flexShrink: 1 }, userText]} numberOfLines={3}>
              {sound.title}
            </Text>
          </View>
          <Pressable
            accessibilityRole="link"
            hitSlop={{ top: 10, bottom: 10 }}
            onPress={() => router.push(`/u/${sound.owner.username}`)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
          >
            <Avatar name={sound.owner.displayName} url={sound.owner.avatarUrl} size={24} />
            <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
              {t('m.sound.by', { name: sound.owner.displayName })}
            </Text>
          </Pressable>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>
            {tp('m.sound.reelCount', sound.reels)}
            {sound.stories ? ` · ${tp('m.sound.storyCount', sound.stories)}` : ''}
            {sound.posts ? ` · ${tp('m.sound.postCount', sound.posts)}` : ''}
            {sound.durationMs ? ` · ${clock(sound.durationMs / 1000)}` : ''}
          </Text>
          {sound.sourcePostId ? (
            // One text line: 44 tall, meeting the owner link's touch area above without overlapping it.
            <Pressable
              accessibilityRole="link"
              hitSlop={{ top: 15, bottom: 13, left: 8, right: 8 }}
              onPress={() => router.push({ pathname: '/reels', params: { start: sound.sourcePostId! } })}
            >
              <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 13 }}>{t('m.sound.original')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {me && sound.canUse ? (
        <View style={{ gap: space[2] }}>
          <Button
            label={t('m.sound.use')}
            icon="musical-notes"
            onPress={() => router.navigate({ pathname: '/create', params: { mode: 'reel', sound: sound.id } })}
          />
          <Button
            label={t('m.sound.useInStory')}
            icon="add-circle-outline"
            variant="secondary"
            onPress={() => router.navigate({ pathname: '/create', params: { mode: 'story', sound: sound.id } })}
          />
          <Button
            label={t('music.track.inPost')}
            icon="image-outline"
            variant="secondary"
            onPress={() => router.navigate({ pathname: '/create', params: { mode: 'post', sound: sound.id } })}
          />
        </View>
      ) : me ? (
        <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('m.sound.cantUse')}</Text>
      ) : null}
      <Segmented
        label={t('m.sound.title')}
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: t('m.sound.recent') },
          { id: 'top', label: t('m.sound.top') },
        ]}
      />
      {error ? <ErrorState message={error} onRetry={loadList} /> : null}
    </View>
  );

  return (
    <FlatList
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4] }}
      columnWrapperStyle={{ gap: 4 }}
      data={reels ?? []}
      numColumns={3}
      keyExtractor={(p) => p.id}
      refreshControl={refresh}
      ListHeaderComponent={header}
      ItemSeparatorComponent={() => <View style={{ height: 4 }} />}
      renderItem={({ item }) => <ReelTile post={item} />}
      onEndReached={() => cursor && void load(cursor).catch((e: unknown) => setError(errorMessage(e)))}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={reels === null ? <Loading /> : error ? null : <EmptyState title={t('m.sound.empty')} />}
    />
  );
}

/** One reel in the grid: its poster frame; opens in Reels. */
function ReelTile({ post }: { post: Post }) {
  const c = useColors();
  const { t, number } = useT();
  const m = post.media[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('m.reels.by', { name: post.author.displayName })}
      onPress={() => router.push({ pathname: '/reels', params: { start: post.id } })}
      style={{ flex: 1 / 3, aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#05060B' }}
    >
      {m?.posterUrl ? <Image source={{ uri: mediaUrl(m.posterUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
      <View style={{ position: 'absolute', bottom: 6, start: 6, end: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="heart" size={12} color="#FFFFFF" />
        <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700' }}>{number(post.counts.likes)}</Text>
      </View>
      {post.remixOf ? (
        <View style={{ position: 'absolute', top: 6, start: 6, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radius.full, padding: 4 }}>
          <Icon name="copy-outline" size={12} color={c.onYapi} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Play or pause the sound (the source reel's audio). */
function PlayButton({ url }: { url: string }) {
  const c = useColors();
  const { t } = useT();
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  useEffect(() => {
    if (status.didJustFinish) void player.seekTo(0);
  }, [status.didJustFinish, player]);
  // Opening a reel made with it (or anything else on top) pauses it, so the two don't play at once.
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) return;
    try {
      player.pause();
    } catch {
      // Already released.
    }
  }, [focused, player]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status.playing ? t('m.sound.pause') : t('m.sound.play')}
      accessibilityState={{ selected: status.playing }}
      onPress={() => (status.playing ? player.pause() : player.play())}
    >
      <LinearGradient {...gradient(c)} style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={status.playing ? 'pause' : 'play'} size={26} color={c.onYapi} />
      </LinearGradient>
    </Pressable>
  );
}
