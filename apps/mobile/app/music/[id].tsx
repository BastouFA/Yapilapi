import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Linking, Pressable, Text, View } from 'react-native';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import type { MusicTrack } from '../../../../packages/shared/src/music';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { clock } from '../../lib/media';
import { useMusicCredit, useMusicLoop } from '../../lib/music';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, Icon, Loading, Notice, useColors, userText } from '../../lib/ui';

/**
 * A song from the music catalogue: play the preview, its licence and the credit it asks for, save it,
 * use it in a post, reel or story (when its licence allows it for you), and the posts you can see
 * that play it.
 */
export default function MusicTrackScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const credit = useMusicCredit();
  const [track, setTrack] = useState<MusicTrack | null | undefined>(undefined);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  useMusicLoop(track?.previewUrl ? { sound: { audioUrl: track.previewUrl }, startMs: 0, durationMs: track.maxClipMs } : null, playing);

  useEffect(() => {
    setTrack(undefined);
    client()
      .then((api) => api.music.track(id))
      .then(
        (r) => setTrack(r.track),
        () => setTrack(null),
      );
  }, [id]);

  const load = useCallback(
    async (next?: string) => {
      const page = await (await client()).music.posts(id, next);
      setPosts((cur) => (next ? [...(cur ?? []), ...page.items.filter((x) => !cur?.some((y) => y.id === x.id))] : page.items));
      setCursor(page.nextCursor);
    },
    [id],
  );
  useEffect(() => {
    setPosts(null);
    void load().catch((e) => (setPosts([]), setError(errorMessage(e))));
  }, [load]);

  if (track === undefined) return <Loading />;
  if (track === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('music.track.missing')} />
      </View>
    );

  async function toggleSave() {
    if (!track) return;
    const next = !track.saved;
    setTrack({ ...track, saved: next });
    try {
      await (await client()).music.save(track, next);
    } catch (e) {
      setTrack({ ...track, saved: !next });
      setError(errorMessage(e));
    }
  }

  const use = (mode: 'post' | 'reel' | 'story') => router.navigate({ pathname: '/create', params: { mode, track: track.id } });

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'center' }}>
        <View
          style={{
            width: 112,
            height: 112,
            borderRadius: radius.lg,
            overflow: 'hidden',
            backgroundColor: c.surfaceSunken,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {track.coverUrl ? (
            <Image source={{ uri: mediaUrl(track.coverUrl) }} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" />
          ) : null}
          {track.previewUrl ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playing ? t('sounds.pause', { title: track.title }) : t('sounds.play', { title: track.title })}
              onPress={() => setPlaying((p) => !p)}
              style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: c.yapi, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={playing ? 'pause' : 'play'} size={26} color={c.onYapi} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flex: 1, gap: space[1] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="musical-notes" size={18} color={c.ink} />
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 20, fontWeight: '800', flexShrink: 1 }, userText]} numberOfLines={3}>
              {track.title}
            </Text>
          </View>
          <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
            {track.artist}
            {track.album ? ` · ${t('music.track.album', { album: track.album })}` : ''}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>
            {tp('music.track.uses', track.uses)}
            {track.durationMs ? ` · ${clock(track.durationMs / 1000)}` : ''}
          </Text>
        </View>
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 12 }}>{credit({ ...track, licenceName: track.licence.name })}</Text>
      {track.licence.url ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(track.licence.url!)} style={{ alignSelf: 'flex-start' }}>
          <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 13 }}>{t('music.track.licence')}</Text>
        </Pressable>
      ) : null}
      {track.source === 'dev' ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('music.track.devNote')}</Text> : null}
      {track.blocked ? <Text style={{ color: c.danger, fontWeight: '600', fontSize: 13 }}>{t(`music.blocked.${track.blocked}` as MessageKey)}</Text> : null}
      {me && track.canUse ? (
        <View style={{ gap: space[2] }}>
          <Button label={t('music.track.inPost')} icon="image-outline" onPress={() => use('post')} />
          <Button label={t('music.track.inReel')} icon="videocam-outline" variant="secondary" onPress={() => use('reel')} />
          <Button label={t('music.track.inStory')} icon="add-circle-outline" variant="secondary" onPress={() => use('story')} />
          <Button
            label={track.saved ? t('music.unsave', { title: track.title }) : t('music.save', { title: track.title })}
            icon={track.saved ? 'bookmark' : 'bookmark-outline'}
            variant="ghost"
            onPress={() => void toggleSave()}
          />
        </View>
      ) : null}
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
      ListEmptyComponent={posts === null ? <Loading /> : <EmptyState title={t('music.track.empty')} />}
    />
  );
}
