import { useEventListener } from 'expo';
import { useAudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  AccessibilityInfo,
  Alert,
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  I18nManager,
  Image,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MediaItem, Post } from '../../../packages/shared/src/types';
import { hls360 } from '../../../packages/shared/src/data-saver';
import {
  formatReelTime,
  REEL_HIGHLIGHT_GAP_MS,
  REEL_HIGHLIGHT_LABEL_MAX,
  REEL_HIGHLIGHTS_MAX,
  REEL_SPEEDS,
  resumeWorthKeeping,
  type ReelHighlight,
  type ReelMoment,
  type ReelSpeed,
} from '../../../packages/shared/src/reels';
import { client, errorMessage, mediaUrl, webUrl } from '../lib/api';
import { useDataSaver } from '../lib/data-saver';
import { useSession } from '../lib/session';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import {
  Avatar,
  BottomSheet,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  type IconName,
  Loading,
  Notice,
  Segmented,
  SwitchRow,
  useColors,
  userText,
} from '../lib/ui';
import { LockedPanel } from '../lib/money';
import { useBoards, type SaveChange } from '../lib/boards';
import { AuthorNames, RichText } from '../lib/post';
import { useReport } from '../lib/report';
import { SensitiveCover } from '../lib/safety';
import { TranslatableText } from '../lib/translation';
import { openMusic, useMusicCredit, useMusicLoop } from '../lib/music';
import { CaptionOverlay, useCaptionCues } from '../lib/captions';
import { canWatch, useWatchStart } from '../lib/watch';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { ECHO_PERMISSIONS, type EchoPermission } from '../../../packages/shared/src/echoes';

/** What a reel plays: on Data saver the lowest MP4, or the 360p stream for videos processed before it existed. */
const reelSource = (m: MediaItem, saver: boolean) =>
  mediaUrl(saver ? (m.variants?.mp4_360 ?? hls360(m) ?? m.variants?.mp4 ?? m.url) : (m.variants?.mp4 ?? m.url));

const WHITE = '#FFFFFF';
const SCRIM = 'rgba(5,6,11,0.42)';
const ACCENT = '#FF5C7A';
const SUN = '#FFBE3D';
const MINT = '#3DDBC2';
const VIEWABILITY = { itemVisiblePercentThreshold: 60 };
const TAP_MS = 260;
const FADE_MS = 3000;
const SOUND_HINT_KEY = 'yp.reels.soundHint';
/** How this person likes to watch reels (speed, captions), kept on this phone only. */
const PREFS_KEY = 'yp.reels.prefs';
/** iOS can't show a sheet while another one is still sliding away. */
const SHEET_SWAP_MS = 420;

/** What the reel on screen lets the sheets do: read where it is, and go to a moment. */
type ReelControls = { currentMs: () => number; seek: (ms: number) => void };
/** What a reel's buttons do; the screen keeps the latest ones in a ref (see ReelRow). */
type ReelActions = {
  toggleMute: () => void;
  soundHintSeen: () => void;
  toggleClear: () => void;
  like: (p: Post, force?: boolean) => void;
  follow: (p: Post) => void;
  comments: (p: Post, atMs: number | null) => void;
  share: (p: Post) => void;
  options: (p: Post) => void;
  save: (p: Post) => void;
  saveTo: (p: Post) => void;
  go: (index: number) => void;
  resumeSaved: (p: Post, ms: number | null) => void;
  keepEchoPrivate: (p: Post) => void;
  deleteEcho: (p: Post) => void;
};
const NO_MOMENTS: ReelMoment[] = [];

function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/**
 * Reels: short vertical videos, one per screen. The one on screen plays (muted until you turn
 * sound on) and loops; swipe up for the next. Tap to pause, double tap to like, press and hold
 * for clear view (the video alone), hold the right edge for 2×. The info stays low and fades while
 * it plays; "more" shows everything. `?start=<post id>` opens a reel first and `&at=<ms>` a moment in it.
 */
export default function Reels() {
  const c = useColors();
  const { t, number } = useT();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { start, at } = useLocalSearchParams<{ start?: string; at?: string }>();
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const { me } = useSession();
  const [muted, setMuted] = useState(true);
  const [clear, setClear] = useState(false);
  const [speed, setSpeedState] = useState<ReelSpeed>(1);
  const [big, setBigState] = useState(false);
  const [captions, setCaptionsState] = useState(true);
  const [soundHint, setSoundHint] = useState(false);
  const [active, setActive] = useState(0);
  const [height, setHeight] = useState(0);
  const [moments, setMoments] = useState<Record<string, ReelMoment[]>>({});
  const [sheet, setSheet] = useState<{ kind: 'share' | 'options' | 'highlights'; post: Post } | null>(null);
  // The reel on screen registers what the highlights editor needs from it.
  const controls = useRef<Record<string, ReelControls>>({});
  const loading = useRef(false);
  const list = useRef<FlatList<Post>>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  // Leaving Reels while a video is being prepared stops waiting for it, so a share sheet never pops up later over another screen.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  useEffect(() => {
    void SecureStore.getItemAsync(SOUND_HINT_KEY).then(
      (v) => setSoundHint(v !== 'seen'),
      () => setSoundHint(true),
    );
  }, []);
  // Speed and captions: remembered on this phone (a convenience, never sent).
  useEffect(() => {
    void SecureStore.getItemAsync(PREFS_KEY).then(
      (v) => {
        try {
          const p = JSON.parse(v ?? '{}') as { speed?: number; captions?: boolean; big?: boolean };
          if ((REEL_SPEEDS as readonly number[]).includes(p.speed as number)) setSpeedState(p.speed as ReelSpeed);
          setCaptionsState(p.captions !== false);
          setBigState(p.big === true);
        } catch {
          // Unreadable: keep the defaults.
        }
      },
      () => {},
    );
  }, []);
  const prefs = useRef({ speed: 1 as number, captions: true, big: false });
  prefs.current = { speed, captions, big };
  const savePrefs = (change: Partial<{ speed: number; captions: boolean; big: boolean }>) => {
    void SecureStore.setItemAsync(PREFS_KEY, JSON.stringify({ ...prefs.current, ...change })).catch(() => {});
  };
  const setSpeed = (v: ReelSpeed) => {
    setSpeedState(v);
    savePrefs({ speed: v });
  };
  const setBig = (v: boolean) => {
    setBigState(v);
    savePrefs({ big: v });
  };
  const setCaptions = (v: boolean) => {
    setCaptionsState(v);
    savePrefs({ captions: v });
  };

  const hintSeen = useCallback(() => {
    setSoundHint(false);
    void SecureStore.setItemAsync(SOUND_HINT_KEY, 'seen').catch(() => {});
  }, []);

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
      // Opening a particular reel (from a post, a grid or a shared link) puts it first.
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

  const current = items?.[active];
  // Load the next page near the end; fetch the moment comments of the reel on screen.
  useEffect(() => {
    if (items && cursor && active >= items.length - 2) void more(cursor);
  }, [active, items, cursor, more]);
  useEffect(() => {
    if (!current || !current.counts.comments || moments[current.id]) return;
    void client()
      .then((api) => api.posts.momentComments(current.id))
      .then(
        (r) => setMoments((m) => ({ ...m, [current.id]: r.items })),
        () => setMoments((m) => ({ ...m, [current.id]: [] })),
      );
  }, [current, moments]);

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<Post>[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setActive(first.index);
  }).current;

  const patch = (id: string, fn: (p: Post) => Post) => setItems((cur) => cur?.map((p) => (p.id === id ? fn(p) : p)) ?? cur);
  const boards = useBoards();
  const syncSaved = (id: string) => (ch: SaveChange) => patch(id, (x) => ({ ...x, viewer: { ...x.viewer, saved: ch.saved } }));

  async function like(p: Post, force?: boolean) {
    const liked = force ?? !p.viewer.liked;
    if (liked === p.viewer.liked) return;
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
      setStatus(t(reposted ? 'reel.share.reposted' : 'reel.share.repostRemoved'));
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
      if (saved) boards.confirmSaved(p, syncSaved(p.id));
    } catch (e) {
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, saved: !saved } }));
      setError(errorMessage(e));
    }
  }

  async function follow(p: Post) {
    try {
      await (await client()).users.follow(p.author.id);
      setFollowed((f) => ({ ...f, [p.author.id]: true }));
      setStatus(t('reel.followed', { name: p.author.displayName }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const [followed, setFollowed] = useState<Record<string, boolean>>({});

  /**
   * "Copy link": the phone has no clipboard module here, so the share sheet opens with the link
   * alone, where Copy is the first choice.
   */
  async function copyLink(p: Post) {
    const url = `${webUrl}/reels?start=${p.id}`;
    try {
      await Share.share(Platform.OS === 'ios' ? { url } : { message: url });
    } catch {
      // The person closed the share sheet.
    }
  }

  async function saveHighlights(p: Post, list: ReelHighlight[]) {
    const r = await (await client()).posts.setHighlights(p.id, list);
    patch(p.id, (x) => ({ ...x, highlights: r.highlights }));
    setStatus(t('reel.highlights.saved'));
  }

  /** Close the sheet on screen and open another once it has slid away. */
  const swapSheet = (next: { kind: 'share' | 'options' | 'highlights'; post: Post }) => {
    setSheet(null);
    setTimeout(() => setSheet(next), SHEET_SWAP_MS);
  };

  async function shareLink(p: Post) {
    const url = `${webUrl}/reels?start=${p.id}`;
    const title = t('m.reels.shareTitle', { name: p.author.displayName });
    try {
      // iOS shares the link as a link; Android only takes a message.
      await Share.share(Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title });
    } catch {
      // The person closed the share sheet.
    }
  }

  /**
   * Save the reel as a video (with a small YAPILAPI watermark and an end card) and open the
   * share sheet, so it can go straight to WhatsApp status and other apps. The server renders
   * it once per reel; we wait for it, download it to the cache, then share the file.
   */
  async function shareVideo(p: Post) {
    if (preparing) return;
    setPreparing(p.id);
    setError(null);
    try {
      const api = await client();
      let state = await api.posts.shareVideo(p.id);
      for (let i = 0; i < 90 && (state.status === 'queued' || state.status === 'processing'); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        state = await api.posts.shareVideoStatus(p.id);
      }
      if (state.status !== 'ready' || !state.url) throw new Error(t('share.video.failed'));
      const file = await File.downloadFileAsync(mediaUrl(state.url), new File(Paths.cache, state.fileName), { idempotent: true });
      if (!alive.current) return;
      if (!(await Sharing.isAvailableAsync())) throw new Error(t('share.video.failed'));
      await Sharing.shareAsync(file.uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4', dialogTitle: t('share.video') });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreparing(null);
    }
  }

  async function notInterested(p: Post) {
    await (await client()).feedback({ signal: 'not_interested', postId: p.id }).catch(() => {});
    setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
    setStatus(t('reel.notInterested.done'));
  }

  // Report a reel from the options sheet; blocking its creator from there too hides their reels.
  // Watch together: pick a chat, then watch this reel there at the same time.
  const watchTogether = useWatchStart();
  const reporter = useReport({ onBlocked: (userId) => setItems((cur) => cur?.filter((x) => x.author.id !== userId) ?? cur) });
  const report = (p: Post) => {
    setSheet(null);
    setTimeout(() => reporter.open({ type: 'post', id: p.id, authorId: p.author.id, authorName: p.author.displayName }), SHEET_SWAP_MS);
  };

  async function setAllowEchoes(p: Post, allowEchoes: EchoPermission) {
    const before = p.allowEchoes;
    patch(p.id, (x) => ({ ...x, allowEchoes }));
    try {
      await (await client()).posts.setAllowEchoes(p.id, allowEchoes);
      setStatus(t('echo.settings.saved'));
    } catch (e) {
      patch(p.id, (x) => ({ ...x, allowEchoes: before }));
      setError(errorMessage(e));
    }
  }

  /** An echo whose original is gone: its author keeps it to themselves, or deletes it. */
  async function keepEchoPrivate(p: Post) {
    try {
      const r = await (await client()).posts.edit(p.id, { visibility: 'private' });
      patch(p.id, () => r.post);
      setStatus(t('echo.keptPrivate'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function deleteEcho(p: Post) {
    Alert.alert(t('echo.deleteConfirm'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('echo.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await (await client()).posts.remove(p.id);
            setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
            setStatus(t('echo.deleted'));
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  async function setAllowRemix(p: Post, allowRemix: boolean) {
    patch(p.id, (x) => ({ ...x, allowRemix }));
    try {
      await (await client()).posts.setAllowRemix(p.id, allowRemix);
      setStatus(t(allowRemix ? 'reel.remixes.on' : 'reel.remixes.off'));
    } catch (e) {
      patch(p.id, (x) => ({ ...x, allowRemix: !allowRemix }));
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(id);
  }, [status]);

  const go = (i: number) => {
    if (!items) return;
    const to = Math.max(0, Math.min(items.length - 1, i));
    list.current?.scrollToIndex({ index: to, animated: true });
  };

  // What a reel's buttons do, kept in a ref: the rows' props stay the same between renders, so a
  // reel (with its players) renders again only when something about it changes.
  const rowActions: ReelActions = {
    toggleMute: () => {
      setMuted((m) => !m);
      hintSeen();
    },
    soundHintSeen: hintSeen,
    toggleClear: () => setClear((v) => !v),
    like: (p, force) => void like(p, force),
    follow: (p) => void follow(p),
    comments: (p, atMs) => router.push({ pathname: '/p/[id]', params: { id: p.id, ...(atMs !== null ? { atMs: String(atMs) } : {}) } }),
    share: (p) => setSheet({ kind: 'share', post: p }),
    options: (p) => setSheet({ kind: 'options', post: p }),
    save: (p) => void save(p),
    saveTo: (p) => boards.openSaveSheet(p, syncSaved(p.id)),
    go,
    resumeSaved: (p, ms) => patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, resumeMs: ms ?? undefined } })),
    keepEchoPrivate: (p) => void keepEchoPrivate(p),
    deleteEcho: (p) => deleteEcho(p),
  };
  const actions = useRef(rowActions);
  actions.current = rowActions;
  const holdId = sheet?.kind === 'highlights' ? sheet.post.id : null;
  const signedIn = !!me;
  const renderReel = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <ReelRow
        post={item}
        index={index}
        height={height}
        visible={index === active}
        focused={focused}
        muted={muted}
        clear={clear}
        speed={speed}
        big={big}
        captions={captions}
        hold={holdId === item.id}
        controls={controls.current}
        moments={moments[item.id] ?? NO_MOMENTS}
        startAt={index === 0 && item.id === start && at ? Number(at) : undefined}
        showSoundHint={soundHint}
        following={!!followed[item.author.id]}
        mine={item.author.id === me?.id}
        signedIn={signedIn}
        actions={actions}
      />
    ),
    [height, active, focused, muted, clear, speed, big, captions, holdId, moments, start, at, soundHint, followed, me?.id, signedIn],
  );

  const back = (color: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('m.common.back')}
      hitSlop={6}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      style={[s.back, { top: insets.top + space[2] }]}
    >
      <Icon name="chevron-back" size={26} color={color} directional />
    </Pressable>
  );

  if (items === null) return <Loading />;
  if (!items.length)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top + 56, padding: space[4], gap: space[3] }}>
        {back(c.ink)}
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
          {t('m.title.reels')}
        </Text>
        {/* Reels that could not load aren't "no reels": say why, with Try again. */}
        {error ? <ErrorState message={error} onRetry={() => more()} /> : <EmptyState title={t('m.reels.empty.title')} body={t('m.reels.empty.body')} />}
        <Button
          label={t('m.reels.make')}
          icon="videocam-outline"
          style={{ alignSelf: 'center' }}
          onPress={() => router.navigate({ pathname: '/create', params: { mode: 'reel' } })}
        />
        {reporter.sheet}
      </View>
    );

  const sheetPost = sheet ? (items.find((p) => p.id === sheet.post.id) ?? sheet.post) : null;
  return (
    <View style={{ flex: 1, backgroundColor: '#05060B' }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {height ? (
        <FlatList
          keyboardShouldPersistTaps="handled"
          ref={list}
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
          renderItem={renderReel}
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
      {error || status ? (
        <View style={{ position: 'absolute', top: insets.top + 60, start: space[4], end: space[4] }} accessibilityLiveRegion="polite">
          <Notice tone={error ? 'danger' : 'info'}>{error ?? status}</Notice>
        </View>
      ) : null}
      {preparing ? (
        <View accessibilityLiveRegion="polite" style={[s.preparing, { top: insets.top + (error ? 124 : 60), backgroundColor: c.surface }]}>
          <ActivityIndicator color={c.yapi} />
          <Text style={{ color: c.ink, fontWeight: '600' }}>{t('share.video.preparing')}</Text>
        </View>
      ) : null}
      <BottomSheet done gap={space[2]} visible={sheet?.kind === 'share'} title={t('reel.share.title')} onClose={() => setSheet(null)}>
        {sheetPost ? (
          <>
            <SheetItem icon="share-outline" label={t('reel.share.link')} onPress={() => (setSheet(null), void shareLink(sheetPost))} />
            {me && canWatch(sheetPost) ? (
              <SheetItem
                icon="tv-outline"
                label={t('watch.start')}
                onPress={() => {
                  const postId = sheetPost.id;
                  setSheet(null);
                  // iOS can't show the chat picker while this sheet is still sliding away.
                  setTimeout(() => watchTogether.open([postId]), SHEET_SWAP_MS);
                }}
              />
            ) : null}
            {sheetPost.author.id !== me?.id && sheetPost.visibility === 'public' ? (
              <SheetItem
                icon="repeat"
                label={sheetPost.viewer.reposted ? t('reel.share.undoRepost') : t('reel.share.repost')}
                selected={sheetPost.viewer.reposted}
                onPress={() => (setSheet(null), void repost(sheetPost))}
              />
            ) : null}
            {me && sheetPost.viewer.canEcho ? (
              <SheetItem
                icon="git-compare-outline"
                label={t('echo.action')}
                onPress={() => (setSheet(null), router.push({ pathname: '/echo/[id]', params: { id: sheetPost.id } }))}
              />
            ) : null}
            {sheetPost.counts.echoes ? (
              <SheetItem
                icon="albums-outline"
                label={`${t('echo.see')} (${number(sheetPost.counts.echoes)})`}
                onPress={() => (setSheet(null), router.push({ pathname: '/echoes/[id]', params: { id: sheetPost.id } }))}
              />
            ) : null}
            {me && sheetPost.allowRemix && sheetPost.visibility === 'public' ? (
              <>
                <SheetItem
                  icon="albums-outline"
                  label={t('reel.share.duet')}
                  onPress={() => (setSheet(null), router.navigate({ pathname: '/create', params: { mode: 'reel', remixOf: sheetPost.id, remixMode: 'duet' } }))}
                />
                <SheetItem
                  icon="musical-notes-outline"
                  label={t('reel.share.remix')}
                  onPress={() => (
                    setSheet(null),
                    router.navigate({ pathname: '/create', params: { mode: 'reel', remixOf: sheetPost.id, remixMode: 'remix' } })
                  )}
                />
              </>
            ) : null}
            {sheetPost.downloadable ? (
              <SheetItem icon="download-outline" label={t('share.video.download')} onPress={() => (setSheet(null), void shareVideo(sheetPost))} />
            ) : null}
            {me ? (
              <SheetItem
                icon="bookmark-outline"
                label={t('m.boards.saveTo')}
                onPress={() => (setSheet(null), boards.openSaveSheet(sheetPost, syncSaved(sheetPost.id)))}
              />
            ) : null}
          </>
        ) : null}
      </BottomSheet>
      <OptionsSheet
        post={sheet?.kind === 'options' ? sheetPost : null}
        mine={sheetPost?.author.id === me?.id}
        speed={speed}
        big={big}
        captions={captions}
        onSpeed={setSpeed}
        onBig={setBig}
        onCaptions={setCaptions}
        onClose={() => setSheet(null)}
        onCopy={(p) => void copyLink(p)}
        onHighlights={(p) => swapSheet({ kind: 'highlights', post: p })}
        onNotInterested={(p) => void notInterested(p)}
        onReport={report}
        onDownload={(p) => void shareVideo(p)}
        onAllowRemix={(p, v) => void setAllowRemix(p, v)}
        onAllowEchoes={(p, v) => void setAllowEchoes(p, v)}
      />
      {reporter.sheet}
      {watchTogether.sheet}
      {sheet?.kind === 'highlights' && sheetPost ? (
        <HighlightsSheet
          post={sheetPost}
          currentMs={() => controls.current[sheetPost.id]?.currentMs() ?? 0}
          onSeek={(ms) => controls.current[sheetPost.id]?.seek(ms)}
          onSave={(list) => saveHighlights(sheetPost, list)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </View>
  );
}

type ReelRowProps = Omit<ComponentProps<typeof Reel>, `on${string}`> & {
  index: number;
  signedIn: boolean;
  actions: { current: ReelActions };
};

/**
 * A reel in the list. Memoised, with its buttons reading the screen's latest actions when pressed,
 * so scrolling, a status line or a sheet opening doesn't render the reels around it again.
 */
const ReelRow = memo(function ReelRow({ index, signedIn, actions, ...props }: ReelRowProps) {
  const { post } = props;
  return (
    <Reel
      {...props}
      onToggleMute={() => actions.current.toggleMute()}
      onSoundHintSeen={() => actions.current.soundHintSeen()}
      onToggleClear={() => actions.current.toggleClear()}
      onLike={(force) => actions.current.like(post, force)}
      onFollow={() => actions.current.follow(post)}
      onComments={(atMs) => actions.current.comments(post, atMs)}
      onShare={() => actions.current.share(post)}
      onOptions={() => actions.current.options(post)}
      onSave={() => actions.current.save(post)}
      onSaveTo={signedIn ? () => actions.current.saveTo(post) : undefined}
      onNext={() => actions.current.go(index + 1)}
      onPrevious={() => actions.current.go(index - 1)}
      onResumeSaved={(ms) => actions.current.resumeSaved(post, ms)}
      onKeepEchoPrivate={() => actions.current.keepEchoPrivate(post)}
      onDeleteEcho={() => actions.current.deleteEcho(post)}
    />
  );
});

function Reel({
  post,
  height,
  visible,
  focused,
  muted,
  clear,
  speed,
  big,
  captions,
  hold,
  controls,
  moments,
  startAt,
  showSoundHint,
  following,
  mine,
  onToggleMute,
  onSoundHintSeen,
  onToggleClear,
  onLike,
  onFollow,
  onComments,
  onShare,
  onOptions,
  onSave,
  onSaveTo,
  onNext,
  onPrevious,
  onResumeSaved,
  onKeepEchoPrivate,
  onDeleteEcho,
}: {
  post: Post;
  height: number;
  /** The reel on screen. */
  visible: boolean;
  /** False while another screen (the comments) is on top. */
  focused: boolean;
  muted: boolean;
  clear: boolean;
  speed: ReelSpeed;
  big: boolean;
  /** Subtitles on, when the reel has them. */
  captions: boolean;
  /** Held still while a sheet about this reel is open (the highlights editor). */
  hold: boolean;
  /** Where the reel on screen registers what the sheets need from it. */
  controls: Record<string, ReelControls>;
  moments: ReelMoment[];
  /** Open at this moment (a moment comment tapped in the comments). */
  startAt?: number;
  showSoundHint: boolean;
  following: boolean;
  mine: boolean;
  onToggleMute: () => void;
  onSoundHintSeen: () => void;
  onToggleClear: () => void;
  onLike: (force?: boolean) => void;
  onFollow: () => void;
  onComments: (atMs: number | null) => void;
  onShare: () => void;
  onOptions: () => void;
  onSave: () => void;
  /** "Save to…" (press and hold the bookmark); absent when signed out. */
  onSaveTo?: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onResumeSaved: (ms: number | null) => void;
  /** Your echo whose original is gone: keep it to yourself, or delete it. */
  onKeepEchoPrivate: () => void;
  onDeleteEcho: () => void;
}) {
  const c = useColors();
  const { t, tp, number } = useT();
  const credit = useMusicCredit();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const media = post.media.find((m) => m.kind === 'video') ?? post.media[0];
  // Data saver: nothing loads or plays until the reel is tapped; then the smallest version plays.
  const saver = useDataSaver().active;
  const [started, setStarted] = useState(false);
  const waiting = saver && !started && !post.locked;
  const src = media && !waiting ? reelSource(media, saver) : null;
  const [paused, setPaused] = useState(false);
  const [fast, setFast] = useState(false);
  const [details, setDetails] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [natural, setNatural] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [sign, setSign] = useState<'play' | 'pause' | null>(null);
  const [pop, setPop] = useState<ReelMoment | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);
  // A sensitive reel shows a blurred still until the viewer chooses to watch it.
  const [revealed, setRevealed] = useState(false);
  const covered = !!media?.sensitive && !revealed;
  const player = useVideoPlayer(src, (p) => {
    p.loop = true;
    p.muted = true;
    p.timeUpdateEventInterval = 0.25;
  });
  // A duet plays beside the original (on the left); a reel using another sound plays that sound.
  const original = post.remixOf?.mode === 'duet' ? (post.remixOf.post?.media ?? null) : null;
  const originalSrc = original && !waiting ? reelSource(original, saver) : null;
  const borrowed = !original && post.sound && !post.sound.original && post.sound.audioUrl ? mediaUrl(post.sound.audioUrl) : null;
  const originalPlayer = useVideoPlayer(originalSrc, (p) => {
    p.loop = true;
    p.muted = true;
  });
  const sound = useAudioPlayer(visible && !waiting ? borrowed : null);
  // A catalogue song plays its part in a loop instead of the reel's own sound (only with sound on, so nothing loads before).
  const song = !original && !borrowed && post.music?.audioUrl ? post.music : null;
  // An echo keeping the original's song plays it with the echo's own sound (their voice and yours).
  const songWithVideo = !!song && !!post.echoOf;
  const echoGone = !!post.echoOf && !post.echoOf.post;
  const highlights = post.highlights ?? [];

  // Only the reel on screen plays; scrolling away clears a tap-to-pause (it continues from where it was next time).
  const playing = visible && focused && !paused && !covered && !waiting && !hold;
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
    player.playbackRate = fast ? 2 : speed;
    if (originalSrc) originalPlayer.playbackRate = fast ? 2 : speed;
  }, [speed, fast, player, originalPlayer, originalSrc]);
  useEffect(() => {
    // With a borrowed sound the reel's own audio stays off.
    player.muted = muted || !!borrowed || (!!song && !songWithVideo);
    if (originalSrc) originalPlayer.muted = muted;
    if (borrowed) {
      sound.muted = muted;
      sound.loop = true;
    }
  }, [muted, player, originalPlayer, originalSrc, borrowed, sound, song, songWithVideo]);
  useMusicLoop(song ? { sound: { audioUrl: song.audioUrl }, startMs: song.startMs, durationMs: song.durationMs } : null, playing && !muted);

  // Where the viewer stopped: sent when they leave the reel and every 10 seconds while it plays.
  const lastSent = useRef<number | null>(post.viewer.resumeMs ?? null);
  const sendResume = useCallback(() => {
    const dur = player.duration;
    if (!dur || !Number.isFinite(dur)) return;
    const ms = Math.round(player.currentTime * 1000);
    if (lastSent.current !== null && Math.abs(lastSent.current - ms) < 1000) return;
    if (lastSent.current === null && !resumeWorthKeeping(ms, dur * 1000)) return;
    lastSent.current = ms;
    void client()
      .then((api) => api.posts.resume(post.id, ms, Math.round(dur * 1000)))
      .then(
        (r) => onResumeSaved(r.resumeMs),
        () => {},
      );
  }, [player, post.id, onResumeSaved]);
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current && !visible) {
      sendResume();
      setPaused(false);
      setDetails(false);
      setFast(false);
    }
    wasVisible.current = visible;
  }, [visible, sendResume]);
  // Android's back button closes the details first, as their close button does, before leaving Reels.
  useEffect(() => {
    if (!details || !visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setDetails(false);
      return true;
    });
    return () => sub.remove();
  }, [details, visible]);
  // A ref, so the reel re-rendering with its time doesn't restart the 10-second timer.
  const sendResumeRef = useRef(sendResume);
  sendResumeRef.current = sendResume;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => sendResumeRef.current(), 10_000);
    return () => clearInterval(id);
  }, [playing]);

  // Continue where I left off (or the moment asked for): once, when the video is ready.
  const resumeApplied = useRef(false);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay') return;
    const size = player.videoTrack?.size;
    if (size?.width && size.height) setNatural(size.width / size.height);
    if (resumeApplied.current) return;
    resumeApplied.current = true;
    const target = startAt ?? post.viewer.resumeMs;
    if (target && target / 1000 < player.duration - 1) {
      player.currentTime = target / 1000;
      if (startAt === undefined) setResumed(target);
    }
  });
  useEffect(() => {
    if (resumed === null) return;
    const id = setTimeout(() => setResumed(null), 6000);
    return () => clearTimeout(id);
  }, [resumed]);

  // Time, and moment comments popping up as the video passes them.
  const prevTime = useRef(0);
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    const dur = Number.isFinite(player.duration) ? player.duration : 0;
    setTime({ current: currentTime, duration: dur });
    if (visible && !clear && moments.length) {
      const prev = prevTime.current;
      const hit = moments.find((m) => m.atMs / 1000 > prev && m.atMs / 1000 <= currentTime && currentTime - prev < 1.5);
      if (hit) setPop(hit);
    }
    prevTime.current = currentTime;
  });
  useEffect(() => {
    if (!pop) return;
    const id = setTimeout(() => setPop(null), 3200);
    return () => clearTimeout(id);
  }, [pop]);

  // The UI fades to a faint strip while it plays untouched; a tap, a pause or the details wake it.
  const fade = useRef(new Animated.Value(1)).current;
  const [awake, setAwake] = useState(true);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    setAwake(true);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => setAwake(false), FADE_MS);
  }, []);
  useEffect(() => {
    if (visible) wake();
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [visible, wake]);
  const faint = !awake && playing && !details;
  useEffect(() => {
    const to = clear ? 0 : faint ? 0.32 : 1;
    if (reduce) fade.setValue(to);
    else Animated.timing(fade, { toValue: to, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [faint, clear, reduce, fade]);

  // "Tap for sound" shows once, for a few seconds.
  const hint = showSoundHint && visible && muted && playing && !clear;
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(onSoundHintSeen, 8000);
    return () => clearTimeout(id);
  }, [hint, onSoundHintSeen]);

  const flash = (kind: 'play' | 'pause') => {
    setSign(kind);
    AccessibilityInfo.announceForAccessibility(t(kind === 'pause' ? 'reel.paused' : 'reel.playing'));
  };
  useEffect(() => {
    if (!sign) return;
    const id = setTimeout(() => setSign(null), 700);
    return () => clearTimeout(id);
  }, [sign]);

  const togglePlay = () => {
    if (covered) return;
    if (waiting) return setStarted(true);
    const pausing = !paused;
    setPaused(pausing);
    flash(pausing ? 'pause' : 'play');
    if (pausing) sendResume();
    wake();
  };

  // Double tap: the three YAPILAPI blocks come together where it was tapped, then rise apart.
  const [burst, setBurst] = useState<{ x: number; y: number; key: number } | null>(null);
  const burstAnim = useRef(new Animated.Value(0)).current;
  const doBurst = (x: number, y: number) => {
    if (reduce) return;
    setBurst({ x, y, key: Date.now() });
    burstAnim.setValue(0);
    Animated.timing(burstAnim, { toValue: 1, duration: 760, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(() => setBurst(null));
  };

  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
    },
    [],
  );
  const onTap = (e: GestureResponderEvent) => {
    if (clear) return onToggleClear();
    const now = Date.now();
    const { locationX, locationY } = e.nativeEvent;
    if (now - lastTap.current < TAP_MS + 60) {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      lastTap.current = 0;
      doBurst(locationX, locationY);
      if (!post.viewer.liked) AccessibilityInfo.announceForAccessibility(t('reel.liked'));
      onLike(true);
      wake();
      return;
    }
    lastTap.current = now;
    tapTimer.current = setTimeout(togglePlay, TAP_MS);
  };
  // Press and hold: 2× on the far edge (the end side), clear view anywhere else.
  const onHold = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    const edge = I18nManager.isRTL ? x < width * 0.22 : x > width * 0.78;
    if (edge && playing) setFast(true);
    else onToggleClear();
  };

  const seek = (seconds: number) => {
    player.currentTime = Math.max(0, seconds);
    prevTime.current = seconds;
    setTime((x) => ({ ...x, current: seconds }));
    wake();
  };
  const seekRef = useRef(seek);
  seekRef.current = seek;
  useEffect(() => {
    if (!visible) return;
    controls[post.id] = { currentMs: () => Math.round(player.currentTime * 1000), seek: (ms) => seekRef.current(ms / 1000) };
    return () => {
      delete controls[post.id];
    };
  }, [visible, controls, post.id, player]);

  // Subtitles: drawn over the video from the reel's caption track (loaded when it's on screen).
  const cues = useCaptionCues(media, visible && captions && !waiting && !covered);

  const ratio = media?.width && media?.height ? media.width / media.height : natural;
  const frameRatio = width && height ? width / height : 9 / 16;
  const fit: 'cover' | 'contain' = !originalSrc && ratio && ratio > frameRatio * 1.25 ? 'contain' : 'cover';
  const poster = media ? (saver ? (media.variants?.thumb ?? media.posterUrl) : media.posterUrl) : null;
  const canFollow = !mine && !following;
  const bottom = insets.bottom + space[1];

  return (
    <View
      style={{ height, backgroundColor: '#05060B', overflow: 'hidden' }}
      accessibilityLabel={t('m.reels.by', { name: post.author.displayName })}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={waiting ? t('dataSaver.play') : paused ? t('m.common.play') : t('m.common.pause')}
        accessibilityHint={t('reel.gestures')}
        accessibilityActions={[{ name: 'activate' }, { name: 'like', label: t('post.like') }, { name: 'clearView', label: t('reel.clearView') }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') togglePlay();
          else if (e.nativeEvent.actionName === 'like') onLike(true);
          else if (e.nativeEvent.actionName === 'clearView') onToggleClear();
        }}
        onPress={onTap}
        onLongPress={onHold}
        delayLongPress={380}
        onPressOut={() => fast && setFast(false)}
        style={StyleSheet.absoluteFill}
      >
        {fit === 'contain' && poster && !covered ? (
          <Image source={{ uri: mediaUrl(poster) }} blurRadius={40} style={[StyleSheet.absoluteFill, { opacity: 0.6 }]} resizeMode="cover" />
        ) : null}
        {waiting && !covered && media && (media.variants?.thumb || media.posterUrl) ? (
          <Image
            source={{ uri: mediaUrl(media.variants?.thumb ?? media.posterUrl!) }}
            style={StyleSheet.absoluteFill}
            resizeMode={fit}
            accessibilityIgnoresInvertColors
          />
        ) : null}
        {originalSrc && !covered ? (
          <View style={[StyleSheet.absoluteFill, { flexDirection: 'row', gap: 2 }]} pointerEvents="none">
            <VideoView player={originalPlayer} style={{ flex: 1 }} contentFit="cover" nativeControls={false} />
            {src ? <VideoView player={player} style={{ flex: 1 }} contentFit="cover" nativeControls={false} /> : <View style={{ flex: 1 }} />}
          </View>
        ) : src && !covered ? (
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={fit} nativeControls={false} pointerEvents="none" />
        ) : null}
        {covered && media?.posterUrl ? (
          <Image source={{ uri: mediaUrl(media.posterUrl) }} blurRadius={50} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : null}
        {covered ? <SensitiveCover onReveal={() => setRevealed(true)} /> : null}
        {post.locked ? (
          <View style={StyleSheet.absoluteFill}>
            <LockedPanel post={post} dark />
          </View>
        ) : null}
        {waiting && !covered && !post.locked ? (
          <View style={s.center} pointerEvents="none">
            <View style={s.bigSign}>
              <Icon name="play" size={36} color={WHITE} />
            </View>
          </View>
        ) : sign ? (
          <View style={s.center} pointerEvents="none">
            <View style={s.sign}>
              <Icon name={sign} size={30} color={WHITE} />
            </View>
          </View>
        ) : paused && !covered ? (
          <View style={s.center} pointerEvents="none">
            <View style={[s.sign, { width: 52, height: 52, borderRadius: 18, opacity: 0.85 }]}>
              <Icon name="play" size={24} color={WHITE} />
            </View>
          </View>
        ) : null}
        {burst ? <Burst x={burst.x} y={burst.y} progress={burstAnim} /> : null}
      </Pressable>

      {/* Top: back, sound and clear view. The rail starts well below. */}
      <Animated.View
        style={[s.top, { top: insets.top + space[2], opacity: clear ? 0 : fade.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }]}
        pointerEvents={clear ? 'none' : 'box-none'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.common.back')}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={s.iconButton}
        >
          <Icon name="chevron-back" size={26} color={WHITE} directional />
        </Pressable>
        <Text style={s.title} accessibilityRole="header" numberOfLines={1}>
          {t('m.title.reels')}
        </Text>
        <TopButton icon={muted ? 'volume-mute' : 'volume-high'} label={t('m.reels.sound')} selected={!muted} onPress={onToggleMute} />
        <TopButton icon={clear ? 'eye-off-outline' : 'scan-outline'} label={t('reel.clearView')} selected={clear} onPress={onToggleClear} />
      </Animated.View>
      {hint ? (
        <Pressable accessibilityRole="button" onPress={onToggleMute} style={[s.pill, { top: insets.top + 60, backgroundColor: WHITE }]}>
          <Icon name="volume-mute" size={16} color="#0B0C14" />
          <Text style={{ color: '#0B0C14', fontWeight: '700', fontSize: 13 }}>{t('reel.tapForSound')}</Text>
        </Pressable>
      ) : null}
      {resumed !== null && visible && !clear ? (
        <View style={[s.pill, { top: insets.top + 104, backgroundColor: 'rgba(5,6,11,0.8)' }]} accessibilityLiveRegion="polite">
          <Text style={{ color: WHITE, fontWeight: '700', fontSize: 13 }}>{t('reel.resume.from', { time: formatReelTime(resumed) })}</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => {
              seek(0);
              setResumed(null);
              lastSent.current = null;
              void client()
                .then((api) => api.posts.clearResume(post.id))
                .catch(() => {});
            }}
          >
            <Text style={{ color: SUN, fontWeight: '700', fontSize: 13, textDecorationLine: 'underline' }}>{t('reel.resume.startOver')}</Text>
          </Pressable>
        </View>
      ) : null}
      {fast ? (
        <View style={[s.pill, { top: insets.top + 60, backgroundColor: 'rgba(5,6,11,0.8)' }]} pointerEvents="none">
          <Text style={{ color: WHITE, fontWeight: '700', fontSize: 13 }}>{t('reel.speed.hold')}</Text>
        </View>
      ) : null}

      {!details ? <CaptionOverlay cues={cues} seconds={time.current} big={big} bottom={clear ? bottom + 56 : bottom + 150} /> : null}

      {/* The info strip: name, Follow, one caption line with "more", the sound. */}
      {!details ? (
        <Animated.View style={[s.info, { bottom: bottom + 48, opacity: fade }]} pointerEvents={clear ? 'none' : 'box-none'}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Pressable accessibilityRole="link" onPress={() => router.push(`/u/${post.author.username}`)} hitSlop={8} style={{ flexShrink: 1 }}>
              <AuthorNames author={post.author} collaborators={post.collaborators} numberOfLines={1} style={s.author} />
            </Pressable>
            {canFollow ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('reel.followName', { name: post.author.displayName })}
                onPress={onFollow}
                hitSlop={10}
                style={s.follow}
              >
                <Text style={{ color: WHITE, fontWeight: '700', fontSize: 12 }}>{t('reel.follow')}</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space[2] }}>
            {post.body ? (
              <View style={{ flex: 1 }}>
                <RichText text={post.body} style={[s.caption, big && s.captionBig]} linkStyle={s.captionLink} numberOfLines={1} />
              </View>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('reel.moreLabel')}
              accessibilityState={{ expanded: false }}
              hitSlop={12}
              onPress={() => {
                setDetails(true);
                wake();
              }}
            >
              <Text style={s.more}>{t('reel.more')}</Text>
            </Pressable>
          </View>
          {post.echoOf?.post ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('echo.ofLabel', { name: post.echoOf.post.author.displayName })}
              hitSlop={6}
              onPress={() => router.push({ pathname: '/reels', params: { start: post.echoOf!.post!.id } })}
              style={s.chip}
            >
              <Icon name="git-compare-outline" size={13} color={WHITE} />
              <Text style={[s.chipText, userText]} numberOfLines={1}>
                {t('echo.of', { name: post.echoOf.post.author.username })}
              </Text>
            </Pressable>
          ) : echoGone && mine ? (
            <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setDetails(true)} style={s.chip}>
              <Icon name="git-compare-outline" size={13} color={WHITE} />
              <Text style={s.chipText}>{t('echo.title')}</Text>
            </Pressable>
          ) : null}
          {post.sound || post.music ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={post.music ? t('music.open', { title: post.music.title }) : undefined}
              hitSlop={6}
              onPress={() => (post.music ? openMusic(post.music) : router.push(`/sounds/${post.sound!.id}`))}
              style={s.chip}
            >
              <Icon name="musical-notes" size={13} color={WHITE} />
              <Text style={[s.chipText, userText]} numberOfLines={1}>
                {post.music ? `${post.music.title} · ${post.music.artist}` : post.sound!.title}
              </Text>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : (
        <View style={[s.details, { bottom: bottom + 44, maxHeight: height * 0.62 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push(`/u/${post.author.username}`)}
              style={{ flex: 1, flexDirection: 'row', gap: space[2], alignItems: 'center' }}
            >
              <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={32} />
              <View style={{ flexShrink: 1 }}>
                <Text style={[s.author, userText]} numberOfLines={1}>
                  {post.author.displayName}
                </Text>
                <Text style={{ color: '#C9CDE0', fontSize: 12 }} numberOfLines={1}>
                  @{post.author.username}
                  {post.counts.views ? ` · ${tp('reel.views', post.counts.views, { count: number(post.counts.views) })}` : ''}
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('reel.details.close')}
              hitSlop={6}
              onPress={() => {
                setDetails(false);
                wake();
              }}
              style={s.iconButton}
            >
              <Icon name="close" size={22} color={WHITE} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space[3], paddingTop: space[2] }}>
            {post.body ? (
              <TranslatableText
                kind="post"
                id={post.id}
                text={post.body}
                lang={post.lang}
                own={mine}
                tint={WHITE}
                linkTint={WHITE}
                style={[s.caption, { fontSize: big ? 17 : 15, lineHeight: big ? 25 : 22 }]}
              />
            ) : null}
            {post.remixOf?.post ? (
              <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/reels', params: { start: post.remixOf!.post!.id } })} style={s.chip}>
                <Icon name="copy-outline" size={14} color={WHITE} />
                <Text style={[s.chipText, userText]} numberOfLines={1}>
                  {t(post.remixOf.mode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf', { name: post.remixOf.post.author.username })}
                </Text>
              </Pressable>
            ) : post.remixOf ? (
              <Text style={{ color: '#C9CDE0', fontSize: 12 }}>{t('m.reels.remixUnavailable')}</Text>
            ) : null}
            {echoGone && mine ? (
              <View accessibilityRole="summary" style={s.echoGone}>
                <Text style={{ color: WHITE, fontSize: 14, lineHeight: 20 }}>{t('echo.unavailable')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  {post.visibility !== 'private' ? <Button size="sm" variant="secondary" label={t('echo.keepPrivate')} onPress={onKeepEchoPrivate} /> : null}
                  <Button size="sm" variant="danger" label={t('echo.delete')} onPress={onDeleteEcho} />
                </View>
              </View>
            ) : null}
            {post.echoOf?.theirAudio === 'dropped' ? <Text style={{ color: '#C9CDE0', fontSize: 12 }}>{t('echo.audioDropped')}</Text> : null}
            {post.counts.echoes ? (
              <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/echoes/[id]', params: { id: post.id } })} style={s.chip}>
                <Icon name="git-compare-outline" size={14} color={WHITE} />
                <Text style={s.chipText}>{tp('echo.count', post.counts.echoes, { count: number(post.counts.echoes) })}</Text>
              </Pressable>
            ) : null}
            {post.topics.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                {post.topics.map((tag) => (
                  <Pressable key={tag} accessibilityRole="link" hitSlop={6} onPress={() => router.push(`/t/${encodeURIComponent(tag)}`)}>
                    <Text style={{ color: WHITE, fontWeight: '700', fontSize: 13 }}>#{tag}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {post.music ? (
              <Text style={{ color: '#C9CDE0', fontSize: 12 }}>
                {post.music.unavailable ? t(`music.unavailable.${post.music.unavailable}` as MessageKey) : credit(post.music)}
              </Text>
            ) : null}
            {highlights.length ? (
              <View style={{ gap: space[1] }}>
                <Text accessibilityRole="header" style={{ color: '#C9CDE0', fontWeight: '700', fontSize: 13 }}>
                  {t('reel.highlights')}
                </Text>
                {highlights.map((h) => (
                  <Pressable
                    key={h.atMs}
                    accessibilityRole="button"
                    accessibilityLabel={t('reel.highlights.jump', { label: h.label, time: formatReelTime(h.atMs) })}
                    onPress={() => {
                      seek(h.atMs / 1000);
                      setPaused(false);
                    }}
                    style={s.mark}
                  >
                    <Text style={{ color: SUN, fontWeight: '700', fontSize: 13, minWidth: 40, fontVariant: ['tabular-nums'] }}>{formatReelTime(h.atMs)}</Text>
                    <Text style={[{ color: WHITE, fontWeight: '600', fontSize: 14, flexShrink: 1 }, userText]}>{h.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {moments.length ? (
              <Pressable accessibilityRole="button" onPress={() => onComments(null)} style={[s.chip, { backgroundColor: 'rgba(61,219,194,0.18)' }]}>
                <Icon name="chatbubble-outline" size={14} color={MINT} />
                <Text style={{ color: MINT, fontWeight: '700', fontSize: 13 }}>{tp('reel.moments', moments.length)}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      )}

      {pop && !details && !clear ? (
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => onComments(null)}
          style={[s.pop, { bottom: bottom + 50 }]}
        >
          <Avatar name={pop.author.displayName} url={pop.author.avatarUrl} size={22} />
          <Text numberOfLines={2} style={[{ color: '#0B0C14', fontSize: 12, flexShrink: 1 }, userText]}>
            <Text style={{ fontWeight: '800' }}>{pop.author.displayName}</Text> {pop.body}
          </Text>
        </Pressable>
      ) : null}

      {/* The rail: the author (with a follow badge), like, comments, share, save, more. */}
      {!details ? (
        <Animated.View
          style={[s.actions, { bottom: bottom + 52, opacity: clear ? 0 : Animated.add(Animated.multiply(fade, 0.5), 0.5) }]}
          pointerEvents={clear ? 'none' : 'box-none'}
        >
          <View style={{ marginBottom: space[2] }}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('reel.profile', { name: post.author.displayName })}
              onPress={() => router.push(`/u/${post.author.username}`)}
              style={{ borderRadius: 24, borderWidth: 2, borderColor: WHITE }}
            >
              <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={42} />
            </Pressable>
            {canFollow ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('reel.followName', { name: post.author.displayName })}
                hitSlop={14}
                onPress={onFollow}
                style={s.badge}
              >
                <Icon name="add" size={14} color={WHITE} />
              </Pressable>
            ) : null}
          </View>
          <Action
            icon={post.viewer.liked ? 'heart' : 'heart-outline'}
            tint={post.viewer.liked ? ACCENT : undefined}
            label={post.viewer.liked ? t('post.unlike') : t('post.like')}
            count={post.counts.likes ? number(post.counts.likes) : ''}
            selected={post.viewer.liked}
            onPress={() => onLike()}
          />
          <Action
            icon="chatbubble-outline"
            label={tp('m.post.commentCount', post.counts.comments)}
            count={post.counts.comments ? number(post.counts.comments) : ''}
            onPress={() => onComments(Math.round(time.current * 1000))}
          />
          <Action icon="paper-plane-outline" label={t('m.common.share')} count={post.counts.reposts ? number(post.counts.reposts) : ''} onPress={onShare} />
          <Action
            icon={post.viewer.saved ? 'bookmark' : 'bookmark-outline'}
            tint={post.viewer.saved ? SUN : undefined}
            dark={post.viewer.saved}
            label={post.viewer.saved ? t('m.reels.unsave') : t('post.save')}
            selected={post.viewer.saved}
            onPress={onSave}
            onLongPress={onSaveTo}
            longPressLabel={t('m.boards.saveTo')}
          />
          <Action icon="ellipsis-horizontal" label={t('reel.options')} onPress={onOptions} />
          {/* Previous and next, for screen readers (people swipe). */}
          <Pressable accessibilityRole="button" accessibilityLabel={t('reel.previous')} onPress={onPrevious} style={s.srOnly} />
          <Pressable accessibilityRole="button" accessibilityLabel={t('reel.next')} onPress={onNext} style={s.srOnly} />
        </Animated.View>
      ) : null}

      {/* Bottom: play or pause, the scrubber, the time. */}
      <View style={[s.controls, { bottom }]}>
        <Animated.View style={{ opacity: clear ? 0 : fade }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={paused || !playing ? t('m.common.play') : t('m.common.pause')}
            onPress={togglePlay}
            style={s.iconButton}
          >
            <Icon name={paused || !playing ? 'play' : 'pause'} size={18} color={WHITE} />
          </Pressable>
        </Animated.View>
        <Scrubber
          current={time.current}
          duration={time.duration}
          highlights={highlights}
          moments={moments}
          dim={clear}
          onSeek={seek}
          onScrubbing={(on) => {
            if (on) {
              player.pause();
              wake();
            } else if (playing) player.play();
          }}
        />
        <Animated.Text style={[s.time, { opacity: clear ? 0 : fade }]} accessibilityElementsHidden importantForAccessibility="no">
          {formatReelTime(time.current * 1000)} / {formatReelTime(time.duration * 1000)}
        </Animated.Text>
      </View>
    </View>
  );
}

/** The progress bar: drag to scrub (with the time above your finger), ticks for highlights, bubbles for moment comments. */
function Scrubber({
  current,
  duration,
  highlights,
  moments,
  dim,
  onSeek,
  onScrubbing,
}: {
  current: number;
  duration: number;
  highlights: { atMs: number; label: string }[];
  moments: ReelMoment[];
  dim: boolean;
  onSeek: (seconds: number) => void;
  onScrubbing: (on: boolean) => void;
}) {
  const { t } = useT();
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const state = useRef({ width: 0, duration: 0 });
  state.current = { width, duration };
  // The pan responder is made once: it calls the latest handlers (whether the reel is playing changes).
  const handlers = useRef({ onSeek, onScrubbing });
  handlers.current = { onSeek, onScrubbing };
  const at = (x: number) => {
    const w = state.current.width || 1;
    const f = Math.max(0, Math.min(1, x / w));
    return I18nManager.isRTL ? 1 - f : f;
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        handlers.current.onScrubbing(true);
        setDrag(at(e.nativeEvent.locationX));
      },
      onPanResponderMove: (e) => setDrag(at(e.nativeEvent.locationX)),
      onPanResponderRelease: (e) => {
        const f = at(e.nativeEvent.locationX);
        setDrag(null);
        handlers.current.onSeek(f * state.current.duration);
        handlers.current.onScrubbing(false);
      },
      onPanResponderTerminate: () => {
        setDrag(null);
        handlers.current.onScrubbing(false);
      },
    }),
  ).current;
  const p = drag ?? (duration ? current / duration : 0);
  const pos = (ms: number) => `${duration ? Math.min(100, (ms / 1000 / duration) * 100) : 0}%` as const;
  return (
    <View
      style={[s.scrub, dim && { opacity: 0.55 }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('reel.seek')}
      accessibilityValue={{
        min: 0,
        max: Math.round(duration),
        now: Math.round(current),
        text: t('reel.seek.value', { current: formatReelTime(current * 1000), total: formatReelTime(duration * 1000) }),
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (!duration) return;
        const step = e.nativeEvent.actionName === 'increment' ? 5 : -5;
        onSeek(Math.max(0, Math.min(duration - 0.1, current + step)));
      }}
      {...pan.panHandlers}
    >
      <View style={[s.track, drag !== null && { height: 6 }]}>
        <View style={[s.fill, { width: `${p * 100}%` }]} />
      </View>
      {highlights.map((h) => (
        <View key={h.atMs} style={[s.tick, { start: pos(h.atMs) }]} pointerEvents="none" />
      ))}
      {moments.map((m) => (
        <View key={m.id} style={[s.bubble, { start: pos(m.atMs) }]} pointerEvents="none" />
      ))}
      {drag !== null ? (
        <>
          <View style={[s.thumb, { start: `${drag * 100}%` }]} pointerEvents="none" />
          <View style={[s.tip, { start: `${drag * 100}%` }]} pointerEvents="none">
            <Text style={{ color: WHITE, fontWeight: '700', fontSize: 12, fontVariant: ['tabular-nums'] }}>{formatReelTime(drag * duration * 1000)}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

function Burst({ x, y, progress }: { x: number; y: number; progress: Animated.Value }) {
  const block = (dx: number, dy: number, fx: number, fy: number, rot: number, color: string, h = 40) => {
    const tx = progress.interpolate({ inputRange: [0, 0.3, 0.55, 1], outputRange: [0, dx, dx, fx] });
    const ty = progress.interpolate({ inputRange: [0, 0.3, 0.55, 1], outputRange: [0, dy, dy, fy] });
    const scale = progress.interpolate({ inputRange: [0, 0.3, 0.55, 1], outputRange: [0.2, 1.12, 1, 0.6] });
    const opacity = progress.interpolate({ inputRange: [0, 0.2, 0.7, 1], outputRange: [0, 1, 1, 0] });
    const rotate = progress.interpolate({ inputRange: [0, 0.3, 1], outputRange: ['0deg', `${rot}deg`, `${rot * 3}deg`] });
    return (
      <Animated.View
        style={{
          position: 'absolute',
          left: x - 20,
          top: y - h / 2,
          width: 40,
          height: h,
          borderRadius: 13,
          borderWidth: 2,
          borderColor: WHITE,
          backgroundColor: color,
          opacity,
          transform: [{ translateX: tx }, { translateY: ty }, { scale }, { rotate }],
        }}
      />
    );
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {block(-23, -24, -62, -118, -12, ACCENT)}
      {block(23, -24, 62, -118, 12, SUN)}
      {block(0, 26, 0, -150, 0, MINT, 46)}
    </View>
  );
}

function TopButton({ icon, label, selected, onPress }: { icon: IconName; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.iconButton, { backgroundColor: selected ? WHITE : SCRIM }]}
    >
      <Icon name={icon} size={22} color={selected ? '#0B0C14' : WHITE} />
    </Pressable>
  );
}

function Action({
  icon,
  label,
  count,
  tint,
  dark,
  selected,
  onPress,
  onLongPress,
  longPressLabel,
}: {
  icon: IconName;
  label: string;
  count?: string;
  /** Filled background when on (like, save). */
  tint?: string;
  /** Dark icon on a light tint. */
  dark?: boolean;
  selected?: boolean;
  onPress: () => void;
  /** Press and hold; screen readers get it as a named action (`longPressLabel`). */
  onLongPress?: () => void;
  longPressLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityActions={onLongPress && longPressLabel ? [{ name: 'longAction', label: longPressLabel }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'longAction') onLongPress?.();
      }}
      hitSlop={4}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [{ alignItems: 'center', gap: 2, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[s.actionIcon, tint ? { backgroundColor: tint, borderColor: 'transparent' } : null]}>
        <Icon name={icon} size={24} color={tint ? (dark ? '#0B0C14' : WHITE) : WHITE} />
      </View>
      <Text style={s.count}>{count ?? ''}</Text>
    </Pressable>
  );
}

function SheetItem({ icon, label, onPress, danger, selected }: { icon: IconName; label: string; onPress: () => void; danger?: boolean; selected?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [s.sheetItem, pressed && { backgroundColor: c.surfaceSunken }]}
    >
      <View style={[s.sheetIcon, { backgroundColor: selected ? c.yapiSoft : c.surfaceSunken }]}>
        <Icon name={icon} size={20} color={danger ? c.danger : selected ? c.yapi : c.ink} />
      </View>
      <Text style={{ color: danger ? c.danger : c.ink, fontSize: 15, fontWeight: '600', flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The "…" sheet: how to watch (speed, captions) and what to do with the reel (copy link,
 * download, highlights, remix and echo settings for the creator, not interested, report).
 */
function OptionsSheet({
  post,
  mine,
  speed,
  big,
  captions,
  onSpeed,
  onBig,
  onCaptions,
  onClose,
  onCopy,
  onHighlights,
  onNotInterested,
  onReport,
  onDownload,
  onAllowRemix,
  onAllowEchoes,
}: {
  post: Post | null;
  mine: boolean;
  speed: ReelSpeed;
  big: boolean;
  captions: boolean;
  onSpeed: (s: ReelSpeed) => void;
  onBig: (v: boolean) => void;
  onCaptions: (v: boolean) => void;
  onClose: () => void;
  onCopy: (p: Post) => void;
  onHighlights: (p: Post) => void;
  onNotInterested: (p: Post) => void;
  onReport: (p: Post) => void;
  onDownload: (p: Post) => void;
  onAllowRemix: (p: Post, allow: boolean) => void;
  onAllowEchoes: (p: Post, allow: EchoPermission) => void;
}) {
  const c = useColors();
  const { t, number } = useT();
  const done = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <BottomSheet done gap={space[2]} visible={!!post} title={t('reel.options')} onClose={onClose}>
      {post ? (
        <>
          <Text style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13 }}>{t('reel.speed')}</Text>
          <Segmented
            label={t('reel.speed')}
            value={String(speed)}
            onChange={(v) => onSpeed(Number(v) as ReelSpeed)}
            options={REEL_SPEEDS.map((sp) => ({ id: String(sp), label: `${number(sp)}×` }))}
          />
          <Text style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13, marginTop: space[2] }}>{t('reel.captions')}</Text>
          {post.media.find((m) => m.kind === 'video')?.captions?.length ? (
            <SwitchRow label={t('reel.captions.show')} value={captions} onValueChange={onCaptions} />
          ) : (
            <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('reel.captions.none')}</Text>
          )}
          <SwitchRow label={t('reel.captions.bigger')} value={big} onValueChange={onBig} />
          {mine && post.allowEchoes && !post.echoOf ? (
            <>
              <Text style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13, marginTop: space[2] }}>{t('echo.settings')}</Text>
              <Segmented
                label={t('echo.settings')}
                value={post.allowEchoes}
                onChange={(v) => onAllowEchoes(post, v)}
                options={ECHO_PERMISSIONS.map((p) => ({ id: p, label: t(`echo.settings.${p}`) }))}
              />
              <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('echo.settings.hint')}</Text>
            </>
          ) : null}
          <View style={{ height: space[2] }} />
          {post.visibility !== 'private' ? <SheetItem icon="link-outline" label={t('reel.share.copy')} onPress={done(() => onCopy(post))} /> : null}
          {post.downloadable ? <SheetItem icon="download-outline" label={t('share.video.download')} onPress={done(() => onDownload(post))} /> : null}
          {mine ? (
            <>
              <SheetItem icon="star-outline" label={t('reel.highlights.edit')} onPress={() => onHighlights(post)} />
              <SheetItem
                icon="copy-outline"
                label={post.allowRemix ? t('reel.remixes.stop') : t('reel.remixes.allow')}
                onPress={done(() => onAllowRemix(post, !post.allowRemix))}
              />
            </>
          ) : (
            <>
              <SheetItem icon="eye-off-outline" label={t('reel.notInterested')} onPress={done(() => onNotInterested(post))} />
              {post.viewer.collab === 'accepted' ? null : <SheetItem icon="flag-outline" label={t('reel.report')} danger onPress={() => onReport(post)} />}
            </>
          )}
        </>
      ) : null}
    </BottomSheet>
  );
}

/**
 * The creator's highlights: up to five named points people can jump to. The reel holds still
 * while this is open: "Add at" uses where it stopped. Rename or remove the others, then save.
 */
function HighlightsSheet({
  post,
  currentMs,
  onSeek,
  onSave,
  onClose,
}: {
  post: Post;
  currentMs: () => number;
  onSeek: (ms: number) => void;
  onSave: (list: ReelHighlight[]) => Promise<void>;
  onClose: () => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [list, setList] = useState<ReelHighlight[]>(post.highlights ?? []);
  const [name, setName] = useState('');
  const [at, setAt] = useState(() => currentMs());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = list.length >= REEL_HIGHLIGHTS_MAX;
  const tooClose = list.some((h) => Math.abs(h.atMs - at) < REEL_HIGHLIGHT_GAP_MS);

  const add = () => {
    const label = name.trim();
    if (!label || full || tooClose) return;
    setList((l) => [...l, { atMs: at, label }].sort((a, b) => a.atMs - b.atMs));
    setName('');
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(list.map((h) => ({ ...h, label: h.label.trim() })).filter((h) => h.label));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet visible title={t('reel.highlights.edit')} onClose={onClose}>
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('reel.highlights.hint')}</Text>
      {list.length ? (
        <View style={{ gap: space[2] }}>
          {list.map((h, i) => (
            <View key={h.atMs} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('reel.moment.seek', { time: formatReelTime(h.atMs) })}
                onPress={() => {
                  onSeek(h.atMs);
                  setAt(h.atMs);
                }}
                style={({ pressed }) => [s.markTime, { backgroundColor: pressed ? c.yapiSoft : c.surfaceSunken }]}
              >
                <Text style={{ color: c.ink, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatReelTime(h.atMs)}</Text>
              </Pressable>
              <View style={{ flex: 1 }}>
                <Field
                  label={`${t('reel.highlights.name')}, ${formatReelTime(h.atMs)}`}
                  hideLabel
                  value={h.label}
                  maxLength={REEL_HIGHLIGHT_LABEL_MAX}
                  onChangeText={(v) => setList((l) => l.map((x, j) => (j === i ? { ...x, label: v } : x)))}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('reel.highlights.remove', { label: h.label || formatReelTime(h.atMs) })}
                onPress={() => setList((l) => l.filter((_, j) => j !== i))}
                style={s.markRemove}
              >
                <Icon name="close" size={20} color={c.inkMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('reel.highlights.none')}</Text>
      )}
      {full ? (
        <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('reel.highlights.full')}</Text>
      ) : (
        <View style={{ gap: space[2] }}>
          <Field
            label={t('reel.highlights.name')}
            value={name}
            maxLength={REEL_HIGHLIGHT_LABEL_MAX}
            placeholder={t('reel.highlights.placeholder')}
            onFocus={() => setAt(currentMs())}
            onChangeText={setName}
            onSubmitEditing={add}
            returnKeyType="done"
          />
          <Button
            label={t('reel.highlights.addAt', { time: formatReelTime(at) })}
            icon="add"
            variant="secondary"
            size="sm"
            disabled={!name.trim() || tooClose}
            onPress={add}
            style={{ alignSelf: 'flex-start' }}
          />
        </View>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space[2] }}>
        <Button label={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button label={t('common.save')} disabled={busy} onPress={() => save()} />
      </View>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  markTime: { minWidth: 64, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[2] },
  markRemove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  back: {
    position: 'absolute',
    start: space[3],
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SCRIM,
  },
  center: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' },
  sign: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: SCRIM },
  bigSign: { width: 76, height: 76, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: SCRIM },
  top: { position: 'absolute', start: space[3], end: space[3], flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { flex: 1, color: WHITE, fontSize: 18, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  iconButton: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: SCRIM },
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 40,
    paddingHorizontal: space[4],
    borderRadius: 12,
  },
  info: { position: 'absolute', start: space[4], end: 76, gap: 6 },
  author: { color: WHITE, fontWeight: '800', fontSize: 15, flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  follow: {
    minHeight: 26,
    paddingHorizontal: 11,
    justifyContent: 'center',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  caption: { color: WHITE, fontSize: 14, lineHeight: 20, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  captionBig: { fontSize: 16, lineHeight: 22 },
  captionLink: { color: WHITE, fontWeight: '800', textDecorationLine: 'underline' },
  more: { color: WHITE, fontWeight: '700', fontSize: 14, textDecorationLine: 'underline', opacity: 0.9 },
  details: {
    position: 'absolute',
    start: 0,
    end: 0,
    paddingHorizontal: space[4],
    paddingTop: space[3],
    paddingBottom: space[2],
    backgroundColor: 'rgba(5,6,11,0.9)',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  mark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 44,
    paddingHorizontal: space[3],
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pop: {
    position: 'absolute',
    start: space[4],
    maxWidth: 240,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingStart: 4,
    paddingEnd: 10,
    borderRadius: 12,
    borderBottomStartRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.93)',
  },
  actions: { position: 'absolute', end: space[2], alignItems: 'center', gap: space[2] },
  badge: {
    position: 'absolute',
    bottom: -9,
    alignSelf: 'center',
    width: 22,
    height: 22,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#05060B',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ACCENT,
  },
  actionIcon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SCRIM,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  count: { color: WHITE, fontSize: 12, fontWeight: '700', minHeight: 14, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 },
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  controls: { position: 'absolute', start: space[2], end: space[2], height: 44, flexDirection: 'row', alignItems: 'center', gap: space[1] },
  time: { color: WHITE, fontSize: 11, fontWeight: '600', minWidth: 72, textAlign: 'right', fontVariant: ['tabular-nums'] },
  scrub: { flex: 1, height: 44, justifyContent: 'center' },
  track: { height: 3, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: ACCENT },
  tick: { position: 'absolute', top: 16.5, width: 3, height: 11, marginStart: -1.5, borderRadius: 2, backgroundColor: SUN },
  bubble: { position: 'absolute', top: 12, width: 8, height: 7, marginStart: -4, borderRadius: 4, borderBottomStartRadius: 1, backgroundColor: MINT },
  thumb: { position: 'absolute', top: 15, width: 14, height: 14, marginStart: -7, borderRadius: 5, backgroundColor: WHITE },
  tip: {
    position: 'absolute',
    bottom: 40,
    marginStart: -24,
    width: 48,
    alignItems: 'center',
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(5,6,11,0.9)',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: 9,
    backgroundColor: 'rgba(5,6,11,0.42)',
  },
  chipText: { color: WHITE, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  echoGone: { gap: space[2], padding: space[3], borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.12)' },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 52, paddingHorizontal: space[2], borderRadius: radius.md },
  sheetIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  preparing: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.full,
  },
});
