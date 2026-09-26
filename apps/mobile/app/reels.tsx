import { useAudioPlayer } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, Share, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Post } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl, webUrl } from '../lib/api';
import { useSession } from '../lib/session';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import { Avatar, Button, EmptyState, Icon, Loading, Notice, useColors, userText, type IconName } from '../lib/ui';

const WHITE = '#FFFFFF';
const SCRIM = 'rgba(0,0,0,0.35)';
const VIEWABILITY = { itemVisiblePercentThreshold: 60 };

/**
 * Reels: short vertical videos, one per screen. The one on screen plays (muted until you turn
 * sound on) and loops; swipe up for the next. Like, comment and share from the side; tap the
 * video to pause. `?start=<post id>` opens a particular reel first. Duets play beside their
 * original; reels that use another sound play that sound; the sound's name opens its page.
 */
export default function Reels() {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { start } = useLocalSearchParams<{ start?: string }>();
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { me } = useSession();
  const [muted, setMuted] = useState(true);
  const [active, setActive] = useState(0);
  const [height, setHeight] = useState(0);
  const loading = useRef(false);

  const more = useCallback(async (next?: string | null) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const page = await (await client()).reels(next ?? undefined);
      setItems((cur) => [...(cur ?? []), ...page.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      // Opening a particular reel (from Create or a shared link) puts it first.
      const first = start
        ? await client()
            .then((api) => api.posts.get(start))
            .then(
              (r) => (r.post.format === 'reel' ? [r.post] : []),
              () => [],
            )
        : [];
      setItems(first);
      setActive(0);
      await more();
    })();
  }, [start, more]);

  // Load the next page when the second-to-last reel comes on screen.
  useEffect(() => {
    if (items && cursor && active >= items.length - 2) void more(cursor);
  }, [active, items, cursor, more]);

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<Post>[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setActive(first.index);
  }).current;

  const patch = (id: string, fn: (p: Post) => Post) => setItems((cur) => cur?.map((p) => (p.id === id ? fn(p) : p)) ?? cur);

  async function like(p: Post) {
    const liked = !p.viewer.liked;
    patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, liked }, counts: { ...x.counts, likes: x.counts.likes + (liked ? 1 : -1) } }));
    try {
      const api = await client();
      const r = liked ? await api.posts.like(p.id) : await api.posts.unlike(p.id);
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, liked: r.liked }, counts: { ...x.counts, likes: r.likes } }));
    } catch {
      patch(p.id, () => p);
    }
  }

  async function repost(p: Post) {
    const reposted = !p.viewer.reposted;
    patch(p.id, (x) => ({
      ...x,
      viewer: { ...x.viewer, reposted },
      counts: { ...x.counts, reposts: Math.max(0, (x.counts.reposts ?? 0) + (reposted ? 1 : -1)) },
    }));
    try {
      const api = await client();
      const r = reposted ? await api.posts.repost(p.id) : await api.posts.unrepost(p.id);
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, reposted: r.reposted }, counts: { ...x.counts, reposts: r.reposts } }));
    } catch (e) {
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, reposted: !reposted }, counts: { ...x.counts, reposts: p.counts.reposts } }));
      setError(errorMessage(e));
    }
  }

  async function save(p: Post) {
    const saved = !p.viewer.saved;
    patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, saved } }));
    try {
      const api = await client();
      await (saved ? api.posts.save(p.id) : api.posts.unsave(p.id));
    } catch (e) {
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, saved: !saved } }));
      setError(errorMessage(e));
    }
  }

  async function share(p: Post) {
    const url = `${webUrl}/reels?start=${p.id}`;
    const title = t('m.reels.shareTitle', { name: p.author.displayName });
    try {
      // iOS shares the link as a link; Android only takes a message.
      await Share.share(Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title });
    } catch {
      // The person closed the share sheet.
    }
  }

  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('m.common.back')}
      hitSlop={10}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      style={[s.back, { top: insets.top + space[2] }]}
    >
      <Icon name="chevron-back" size={26} color={WHITE} directional />
    </Pressable>
  );

  if (items === null) return <Loading />;
  if (!items.length)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top + 56, padding: space[4], gap: space[3] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.common.back')}
          hitSlop={10}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={[s.back, { top: insets.top + space[2] }]}
        >
          <Icon name="chevron-back" size={26} color={c.ink} directional />
        </Pressable>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
          {t('m.title.reels')}
        </Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <EmptyState title={t('m.reels.empty.title')} body={t('m.reels.empty.body')} />
        <Button
          label={t('m.reels.make')}
          icon="videocam-outline"
          style={{ alignSelf: 'center' }}
          onPress={() => router.navigate({ pathname: '/create', params: { mode: 'reel' } })}
        />
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {height ? (
        <FlatList
          data={items}
          keyExtractor={(p) => p.id}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          decelerationRate="fast"
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          viewabilityConfig={VIEWABILITY}
          onViewableItemsChanged={onViewable}
          renderItem={({ item, index }) => (
            <Reel
              post={item}
              height={height}
              visible={index === active}
              focused={focused}
              muted={muted}
              onToggleMute={() => setMuted((m) => !m)}
              onLike={() => void like(item)}
              onComments={() => router.push(`/p/${item.id}`)}
              onShare={() => void share(item)}
              onRepost={item.author.id !== me?.id && item.visibility === 'public' ? () => void repost(item) : undefined}
              onSave={() => void save(item)}
            />
          )}
          ListFooterComponent={
            !cursor ? (
              <View style={{ height, alignItems: 'center', justifyContent: 'center', padding: space[6], gap: space[3] }}>
                <Text style={{ color: WHITE, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>{t('m.reels.caughtUp')}</Text>
                <Button label={t('m.reels.make')} icon="videocam-outline" onPress={() => router.navigate({ pathname: '/create', params: { mode: 'reel' } })} />
              </View>
            ) : null
          }
        />
      ) : null}
      {error ? (
        <View style={{ position: 'absolute', top: insets.top + 56, start: space[4], end: space[4] }}>
          <Notice tone="danger">{error}</Notice>
        </View>
      ) : null}
      {back}
    </View>
  );
}

function Reel({
  post,
  height,
  visible,
  focused,
  muted,
  onToggleMute,
  onLike,
  onComments,
  onShare,
  onRepost,
  onSave,
}: {
  post: Post;
  height: number;
  /** The reel on screen. */
  visible: boolean;
  /** False while another screen (the comments) is on top. */
  focused: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onLike: () => void;
  onComments: () => void;
  onShare: () => void;
  /** Absent for your own reels and ones that aren't public. */
  onRepost?: () => void;
  onSave: () => void;
}) {
  const c = useColors();
  const { t, tp, number } = useT();
  const insets = useSafeAreaInsets();
  const media = post.media.find((m) => m.kind === 'video') ?? post.media[0];
  const src = media ? mediaUrl(media.variants?.mp4 ?? media.url) : null;
  const [paused, setPaused] = useState(false);
  const player = useVideoPlayer(src, (p) => {
    p.loop = true;
    p.muted = true;
  });
  // A duet plays beside the original (on the left); a reel using another sound plays that sound.
  const original = post.remixOf?.mode === 'duet' ? (post.remixOf.post?.media ?? null) : null;
  const originalSrc = original ? mediaUrl(original.variants?.mp4 ?? original.url) : null;
  const borrowed = !original && post.sound && !post.sound.original && post.sound.audioUrl ? mediaUrl(post.sound.audioUrl) : null;
  const originalPlayer = useVideoPlayer(originalSrc, (p) => {
    p.loop = true;
    p.muted = true;
  });
  const sound = useAudioPlayer(visible ? borrowed : null);

  // Only the reel on screen plays; scrolling away rewinds it and clears a tap-to-pause.
  const playing = visible && focused && !paused;
  useEffect(() => {
    for (const p of [player, originalSrc ? originalPlayer : null]) {
      if (!p) continue;
      if (playing) p.play();
      else p.pause();
    }
    if (borrowed) {
      if (playing) sound.play();
      else sound.pause();
    }
  }, [playing, player, originalPlayer, originalSrc, borrowed, sound]);
  useEffect(() => {
    if (visible) return;
    player.currentTime = 0;
    if (originalSrc) originalPlayer.currentTime = 0;
    setPaused(false);
  }, [visible, player, originalPlayer, originalSrc]);
  useEffect(() => {
    // With a borrowed sound the reel's own audio stays off.
    player.muted = muted || !!borrowed;
    if (originalSrc) originalPlayer.muted = muted;
    if (borrowed) {
      sound.muted = muted;
      sound.loop = true;
    }
  }, [muted, player, originalPlayer, originalSrc, borrowed, sound]);

  return (
    <View style={{ height, backgroundColor: '#000' }} accessibilityLabel={t('m.reels.by', { name: post.author.displayName })}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={paused ? t('m.common.play') : t('m.common.pause')}
        accessibilityHint={media?.altText || post.body || undefined}
        onPress={() => setPaused((p) => !p)}
        style={StyleSheet.absoluteFill}
      >
        {originalSrc ? (
          <View style={[StyleSheet.absoluteFill, { flexDirection: 'row', gap: 2 }]} pointerEvents="none">
            <VideoView player={originalPlayer} style={{ flex: 1 }} contentFit="cover" nativeControls={false} />
            {src ? <VideoView player={player} style={{ flex: 1 }} contentFit="cover" nativeControls={false} /> : <View style={{ flex: 1 }} />}
          </View>
        ) : src ? (
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} pointerEvents="none" />
        ) : null}
        {paused ? (
          <View style={s.center} pointerEvents="none">
            <View style={s.playBadge}>
              <Icon name="play" size={40} color={WHITE} />
            </View>
          </View>
        ) : null}
      </Pressable>

      <View style={[s.info, { bottom: insets.bottom + space[6] }]} pointerEvents="box-none">
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(`/p/${post.id}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], alignSelf: 'flex-start' }}
        >
          <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={36} />
          <Text style={[s.author, userText]} numberOfLines={1}>
            {post.author.displayName}
          </Text>
        </Pressable>
        {post.remixOf ? (
          post.remixOf.post ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={6}
              onPress={() => router.push({ pathname: '/reels', params: { start: post.remixOf!.post!.id } })}
              style={s.chip}
            >
              <Icon name="copy-outline" size={14} color={WHITE} />
              <Text style={[s.chipText, userText]} numberOfLines={1}>
                {t(post.remixOf.mode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf', { name: post.remixOf.post.author.username })}
              </Text>
            </Pressable>
          ) : (
            <View style={s.chip}>
              <Icon name="copy-outline" size={14} color={WHITE} />
              <Text style={s.chipText} numberOfLines={1}>
                {t('m.reels.remixUnavailable')}
              </Text>
            </View>
          )
        ) : null}
        {post.body ? (
          <Text style={[s.caption, userText]} numberOfLines={3}>
            {post.body}
          </Text>
        ) : null}
        {post.sound ? (
          <Pressable accessibilityRole="link" hitSlop={6} onPress={() => router.push(`/sounds/${post.sound!.id}`)} style={s.chip}>
            <Icon name="musical-notes" size={14} color={WHITE} />
            <Text style={[s.chipText, userText]} numberOfLines={1}>
              {post.sound.title}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[s.actions, { bottom: insets.bottom + space[6] }]}>
        <Action
          icon={post.viewer.liked ? 'heart' : 'heart-outline'}
          color={post.viewer.liked ? c.yapi : WHITE}
          label={post.viewer.liked ? t('post.unlike') : t('post.like')}
          count={post.counts.likes ? number(post.counts.likes) : ''}
          selected={post.viewer.liked}
          onPress={onLike}
        />
        <Action
          icon="chatbubble-outline"
          label={tp('m.post.commentCount', post.counts.comments)}
          count={post.counts.comments ? number(post.counts.comments) : ''}
          onPress={onComments}
        />
        {onRepost ? (
          <Action
            icon="repeat"
            color={post.viewer.reposted ? '#2dd4bf' : WHITE}
            label={post.viewer.reposted ? t('m.reels.undoRepost') : t('m.reels.repost')}
            count={post.counts.reposts ? number(post.counts.reposts) : ''}
            selected={post.viewer.reposted}
            onPress={onRepost}
          />
        ) : null}
        <Action
          icon={post.viewer.saved ? 'bookmark' : 'bookmark-outline'}
          color={post.viewer.saved ? '#facc15' : WHITE}
          label={post.viewer.saved ? t('m.reels.unsave') : t('post.save')}
          selected={post.viewer.saved}
          onPress={onSave}
        />
        <Action icon="paper-plane-outline" label={t('m.common.share')} onPress={onShare} />
        <Action
          icon={muted ? 'volume-mute' : 'volume-high'}
          label={muted ? t('m.reels.soundOn') : t('m.reels.soundOff')}
          selected={!muted}
          onPress={onToggleMute}
        />
      </View>
    </View>
  );
}

function Action({
  icon,
  label,
  count,
  color = WHITE,
  selected,
  onPress,
}: {
  icon: IconName;
  label: string;
  count?: string;
  color?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [{ alignItems: 'center', gap: 2, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={s.actionIcon}>
        <Icon name={icon} size={28} color={color} />
      </View>
      {count ? <Text style={s.count}>{count}</Text> : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  back: {
    position: 'absolute',
    start: space[3],
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SCRIM,
  },
  center: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' },
  playBadge: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: SCRIM },
  info: { position: 'absolute', start: space[4], end: 84, gap: space[2] },
  author: { color: WHITE, fontWeight: '800', fontSize: 15, flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  caption: { color: WHITE, fontSize: 14, lineHeight: 20, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  actions: { position: 'absolute', end: space[3], alignItems: 'center', gap: space[4] },
  actionIcon: { width: 48, height: 48, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: SCRIM },
  count: { color: WHITE, fontSize: 12, fontWeight: '700' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%' },
  chipText: { color: WHITE, fontSize: 13, fontWeight: '700', flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
});
