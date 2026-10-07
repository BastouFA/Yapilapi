import { useEventListener } from 'expo';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  I18nManager,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Story, StoryGroup } from '../../../packages/api-client/src/index';
import type { StickerResults, StorySticker } from '../../../packages/shared/src/stories';
import type { PublicUser } from '../../../packages/shared/src/types';
import { compactCount } from '../../../packages/shared/src/post-stats';
import { client, errorMessage, mediaUrl, webUrl } from './api';
import { useDataSaver } from './data-saver';
import { useT } from './i18n';
import { RichText } from './post';
import { gradient, radius, space } from './theme';
import { ActionSheet, Avatar, Icon, KeyboardAvoid, Segmented, SwitchRow, useColors, userText, useScreenFocused } from './ui';
import { useReport } from './report';
import { SensitiveCover } from './safety';
import { AddToChapterSheet } from './chapters';
import { StickerLayer, StoryCardView } from './story-stickers';
import { MusicSticker, openMusic, useMusicLoop, useMusicOn } from './music';
import { TranslationBar, useTranslatable } from './translation';

const PHOTO_MS = 5000;
const WHITE = '#FFFFFF';
const SCRIM = 'rgba(0,0,0,0.35)';
const RING = 70;

/** Your own stories first, then the rest in the order the API gives (unseen before seen). */
export const orderStories = (groups: StoryGroup[]) => [...groups.filter((g) => g.mine), ...groups.filter((g) => !g.mine)];

/**
 * The horizontal stories strip on Home. Unseen stories have a gradient ring, seen ones a grey
 * ring. "Your story" is always first: with no story yet it adds one, otherwise it opens yours
 * and the small plus adds another.
 */
export function StoriesStrip({ groups, onOpen, onCreate }: { groups: StoryGroup[]; onOpen: (index: number) => void; onCreate?: () => void }) {
  const c = useColors();
  const { t } = useT();
  const hasOwn = groups.some((g) => g.mine);
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={t('m.stories.label')}
      contentContainerStyle={{ gap: space[3], paddingVertical: space[1] }}
    >
      {!hasOwn && onCreate ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t('m.stories.add')} onPress={onCreate} style={st.item}>
          <View style={[st.ring, { borderWidth: 2, borderColor: c.line, borderStyle: 'dashed' }]}>
            <View style={[st.inner, { backgroundColor: c.surfaceSunken }]}>
              <Icon name="add" size={28} color={c.yapi} />
            </View>
          </View>
          <Text style={[st.name, { color: c.ink }]} numberOfLines={1}>
            {t('m.stories.yours')}
          </Text>
        </Pressable>
      ) : null}
      {groups.map((g, i) => {
        const name = g.mine ? t('m.stories.yours') : g.author.displayName;
        // A green ring for close friends stories you haven't seen (or your own).
        const close = g.moments.some((m) => m.closeFriends && (g.mine || !m.seen));
        const avatar = (
          <View style={[st.inner, { backgroundColor: c.ground }]}>
            <Avatar name={g.author.displayName} url={g.author.avatarUrl} size={RING - 10} />
          </View>
        );
        return (
          <View key={g.author.id} style={st.item}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${g.allSeen ? t('m.stories.a11y.seen', { name }) : t('m.stories.a11y.new', { name })}${close ? `, ${t('m.closeFriends.title')}` : ''}`}
              onPress={() => onOpen(i)}
              style={{ alignItems: 'center', gap: 4 }}
            >
              {close ? (
                <View style={[st.ring, { backgroundColor: c.closeFriends }]}>{avatar}</View>
              ) : g.allSeen ? (
                <View style={[st.ring, { borderWidth: 2, borderColor: c.lineStrong }]}>{avatar}</View>
              ) : (
                <LinearGradient {...gradient(c)} style={st.ring}>
                  {avatar}
                </LinearGradient>
              )}
              <Text style={[st.name, { color: c.ink }, userText]} numberOfLines={1}>
                {name}
              </Text>
            </Pressable>
            {g.mine && onCreate ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.stories.add')}
                // 22pt badge on the ring; the touch area reaches 44.
                hitSlop={11}
                onPress={onCreate}
                style={[st.plus, { backgroundColor: c.yapi, borderColor: c.ground }]}
              >
                <Icon name="add" size={14} color={c.onYapi} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

/**
 * Full-screen stories. Progress bars show where you are; photos and text stay 5 seconds,
 * videos play to the end. Tap the start or end side for previous and next (mirrored in
 * right-to-left layouts), hold to pause, swipe down or use the close button to close.
 * Viewing marks others' stories as seen; they can be liked and replied to (the reply arrives
 * as a direct message). Your own show who saw them and can be deleted.
 */
export function StoryViewer({
  groups,
  start,
  onClose,
  onChange,
}: {
  groups: StoryGroup[];
  start: number | null;
  onClose: () => void;
  /** Called after local changes (seen, liked, deleted) so the strip can update. */
  onChange: (groups: StoryGroup[]) => void;
}) {
  // Android's back button closes a panel open over the story (who saw it, share) before the stories.
  const back = useRef<(() => boolean) | null>(null);
  const focused = useScreenFocused();
  return (
    <Modal
      visible={start !== null && focused}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={() => {
        if (!back.current?.()) onClose();
      }}
      statusBarTranslucent
    >
      {start !== null && groups[start] ? <Viewer groups={groups} start={start} onClose={onClose} onChange={onChange} backRef={back} /> : null}
    </Modal>
  );
}

function Viewer({
  groups,
  start,
  onClose,
  onChange,
  backRef,
}: {
  groups: StoryGroup[];
  start: number;
  onClose: () => void;
  onChange: (groups: StoryGroup[]) => void;
  backRef: { current: (() => boolean) | null };
}) {
  const c = useColors();
  const { t, tp, timeAgo, locale } = useT();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [g, setG] = useState(start);
  const [i, setI] = useState(() => Math.max(0, groups[start]?.moments.findIndex((m) => !m.seen) ?? 0));
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reply, setReply] = useState('');
  const [typing, setTyping] = useState(false);
  // A reply on its way: Send is off until it's done, so a second tap doesn't send it twice.
  const [replying, setReplying] = useState(false);
  const replyingRef = useRef(false);
  const [sent, setSent] = useState<string | null>(null);
  const [viewers, setViewers] = useState<{
    items: { user: PublicUser; liked: boolean }[];
    results: StickerResults[];
    reshares: number;
    allowReshare: boolean;
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [chapterFor, setChapterFor] = useState<string | null>(null);
  // Someone else's story: More, with Report.
  const [moreOpen, setMoreOpen] = useState(false);
  const report = useReport();
  backRef.current = () => {
    if (sharing) return (setSharing(false), true);
    if (viewers) return (setViewers(null), true);
    return false;
  };
  const group = groups[g];
  const story = group?.moments[i];
  // Sensitive stories wait, blurred and paused, until the viewer chooses to see them.
  const [revealed, setRevealed] = useState<string[]>([]);
  const covered = !!story?.sensitive && !revealed.includes(story.id);
  // Data saver: a video shows its poster until tapped, then plays its 360p file; photos use the medium size.
  const saver = useDataSaver().active;
  const [tapped, setTapped] = useState<string[]>([]);
  const waiting = saver && story?.mediaKind === 'video' && !tapped.includes(story.id);
  const stopped =
    held || paused || typing || viewers !== null || covered || sharing || answering || chapterFor !== null || waiting || moreOpen || report.isOpen;
  // The story's music, in a loop while it's on screen and playing (instead of a video's own sound).
  const [musicOn, setMusicOn] = useMusicOn();
  const music = !covered ? (story?.music ?? null) : null;
  useMusicLoop(music, !!music && musicOn && !stopped);
  // "See translation" for the story's text. Asking for it pauses the story so there's time to read.
  const translation = useTranslatable({ kind: 'story', id: story?.id ?? '', text: story?.body ?? '', lang: story?.lang, own: !!group?.mine });
  const seeTranslation = () => {
    setPaused(true);
    translation.see();
  };
  const translationBar = <TranslationBar state={{ ...translation, see: seeTranslation }} tint="rgba(255,255,255,0.8)" linkTint={WHITE} />;

  const next = useCallback(() => {
    if (!group) return onClose();
    if (i < group.moments.length - 1) setI(i + 1);
    else if (g < groups.length - 1) {
      setG(g + 1);
      setI(
        Math.max(
          0,
          groups[g + 1]!.moments.findIndex((m) => !m.seen),
        ),
      );
    } else onClose();
  }, [g, i, group, groups, onClose]);
  const prev = useCallback(() => {
    if (i > 0) setI(i - 1);
    else if (g > 0) {
      setG(g - 1);
      setI(groups[g - 1]!.moments.length - 1);
    }
  }, [g, i, groups]);

  // Mark as seen (once) and reset progress when the story changes.
  useEffect(() => {
    setProgress(0);
    setReply('');
    setSent(null);
    if (!story || story.seen || group?.mine) return;
    void client()
      .then((api) => api.moments.view(story.id))
      .catch(() => {});
    onChange(
      groups.map((x, gi) =>
        gi !== g
          ? x
          : { ...x, moments: x.moments.map((m, mi) => (mi === i ? { ...m, seen: true } : m)), allSeen: x.moments.every((m, mi) => mi === i || m.seen) },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // Photos and text advance on a timer; videos report their own progress.
  const progressRef = useRef(0);
  progressRef.current = progress;
  const timed = useRef<string | null>(null);
  useEffect(() => {
    if (!story || story.mediaKind === 'video' || stopped) return;
    // A new story starts from nothing: the progress can still be the last story's (≈1) until its
    // reset lands, which would skip straight past this one. A resumed story carries on where it paused.
    const resumed = timed.current === story.id;
    timed.current = story.id;
    const started = Date.now() - (resumed ? progressRef.current : 0) * PHOTO_MS;
    const timer = setInterval(() => {
      const p = (Date.now() - started) / PHOTO_MS;
      if (p >= 1) {
        clearInterval(timer);
        next();
      } else setProgress(p);
    }, 50);
    return () => clearInterval(timer);
  }, [story, stopped, next]);

  // "Sent" confirmation after a reply, for a moment.
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(null), 2500);
    return () => clearTimeout(timer);
  }, [sent]);

  // One responder for the whole media area: tap either side, hold to pause, swipe down to close.
  const drag = useRef(new Animated.Value(0)).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holding = useRef(false);
  const nav = useRef({ next, prev, onClose, width, typing });
  nav.current = { next, prev, onClose, width, typing };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 8,
      onPanResponderGrant: () => {
        holdTimer.current = setTimeout(() => {
          holding.current = true;
          setHeld(true);
        }, 220);
      },
      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dy) > 8 || Math.abs(gs.dx) > 8) clearTimeout(holdTimer.current);
        if (gs.dy > 0) drag.setValue(gs.dy);
      },
      onPanResponderRelease: (e, gs) => {
        clearTimeout(holdTimer.current);
        const wasHolding = holding.current;
        holding.current = false;
        setHeld(false);
        if (gs.dy > 120 && gs.dy > Math.abs(gs.dx)) {
          nav.current.onClose();
          return;
        }
        Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
        if (wasHolding || Math.abs(gs.dx) > 10 || Math.abs(gs.dy) > 10) return;
        // While replying, a tap outside only closes the keyboard.
        if (nav.current.typing) return Keyboard.dismiss();
        // The start side (left, or right in right-to-left layouts) goes back.
        const x = e.nativeEvent.pageX;
        const w = nav.current.width;
        const startSide = I18nManager.isRTL ? x > (w * 2) / 3 : x < w / 3;
        if (startSide) nav.current.prev();
        else nav.current.next();
      },
      onPanResponderTerminate: () => {
        clearTimeout(holdTimer.current);
        holding.current = false;
        setHeld(false);
        Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  if (!group || !story) return null;
  const name = group.author.displayName;
  const small = !saver ? null : story.mediaKind === 'video' ? story.variants?.mp4_360 : story.variants?.medium;
  const uri = story.mediaUrl ? mediaUrl(small ?? story.mediaUrl) : null;
  const patchStory = (patch: Partial<Story>) =>
    onChange(groups.map((x, gi) => (gi !== g ? x : { ...x, moments: x.moments.map((m, mi) => (mi === i ? { ...m, ...patch } : m)) })));
  const addToStory = async (visibility: string) => {
    try {
      await (await client()).moments.reshare(story.id, { visibility });
      setSharing(false);
      setSent(t('m.stories.added'));
    } catch (e) {
      setSent(errorMessage(e));
    }
  };

  async function remove() {
    if (!group || !story) return;
    try {
      await (await client()).moments.remove(story.id);
      const rest = group.moments.filter((m) => m.id !== story.id);
      const updated = rest.length ? groups.map((x, gi) => (gi === g ? { ...x, moments: rest } : x)) : groups.filter((_, gi) => gi !== g);
      onChange(updated);
      if (!rest.length) onClose();
      else setI(Math.min(i, rest.length - 1));
    } catch (e) {
      Alert.alert(errorMessage(e));
    }
  }

  return (
    <KeyboardAvoid offset={0} style={{ backgroundColor: '#000' }}>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={t('m.stories.viewer', { name: group.mine ? t('m.stories.yours') : name, index: i + 1, total: group.moments.length })}
        style={{ flex: 1, transform: [{ translateY: drag }], opacity: drag.interpolate({ inputRange: [0, 400], outputRange: [1, 0.4], extrapolate: 'clamp' }) }}
      >
        {/* Screen readers swipe up and down on it (adjustable) for next and previous. */}
        <View
          style={StyleSheet.absoluteFill}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={translation.text || t('m.stories.photo', { name })}
          accessibilityLanguage={translation.lang}
          accessibilityHint={t('m.stories.hint')}
          accessibilityActions={[
            { name: 'increment' },
            { name: 'decrement' },
            { name: 'activate' },
            // The story is one element for screen readers, so "See translation" is one of its actions.
            ...(translation.offered
              ? [translation.status === 'shown' ? { name: 'original', label: t('translate.seeOriginal') } : { name: 'translate', label: t('translate.see') }]
              : []),
          ]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment') next();
            else if (e.nativeEvent.actionName === 'decrement') prev();
            else if (e.nativeEvent.actionName === 'translate') seeTranslation();
            else if (e.nativeEvent.actionName === 'original') translation.showOriginal();
            else setPaused((p) => !p);
          }}
          {...pan.panHandlers}
        >
          {covered && uri ? (
            <>
              {story.mediaKind === 'image' || story.posterUrl ? (
                <Image
                  key={story.id}
                  source={{ uri: story.mediaKind === 'image' ? uri : mediaUrl(story.posterUrl!) }}
                  blurRadius={50}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                />
              ) : null}
              <SensitiveCover onReveal={() => setRevealed((r) => [...r, story.id])} />
            </>
          ) : story.mediaKind === 'video' && uri && waiting ? (
            story.posterUrl ? (
              <Image key={story.id} source={{ uri: mediaUrl(story.posterUrl) }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            ) : null
          ) : story.mediaKind === 'video' && uri ? (
            <StoryVideo key={story.id} uri={uri} paused={stopped} muted={!!story.music} onProgress={setProgress} onEnd={next} />
          ) : story.mediaKind === 'image' && uri ? (
            <Image
              key={story.id}
              source={{ uri }}
              accessibilityLabel={story.body || t('m.stories.photo', { name })}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          ) : story.reshareOf ? (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[6], backgroundColor: '#1D1430' }]} />
          ) : (
            <LinearGradient {...gradient(c)} style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[6] }]} />
          )}
        </View>

        {/* Text, reshare cards and stickers sit above the tap area; only their own controls take touches. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {waiting && !covered ? (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="box-none">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('dataSaver.play')}
                onPress={() => setTapped((x) => [...x, story.id])}
                style={{ width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' }}
              >
                <Icon name="play" size={40} color={WHITE} />
              </Pressable>
            </View>
          ) : null}
          {!uri && !story.reshareOf && !covered ? (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[6] }]} pointerEvents="box-none">
              <RichText
                text={translation.text}
                language={translation.lang}
                style={{ color: WHITE, fontSize: 28, fontWeight: '800', textAlign: 'center', lineHeight: 36 }}
              />
              {translationBar}
            </View>
          ) : null}
          {story.reshareOf && !uri ? (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="box-none">
              <View style={{ backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: radius.lg, padding: space[3] }}>
                <StoryCardView
                  dark
                  card={story.reshareOf}
                  label={story.reshareOf.available ? t('m.stories.from', { username: story.reshareOf.author.username }) : undefined}
                  action={t('m.stories.openOriginal')}
                />
              </View>
            </View>
          ) : null}
          {story.body && (uri || story.reshareOf) ? (
            <View style={{ position: 'absolute', start: space[4], end: space[4], bottom: 110 + insets.bottom }} pointerEvents="box-none">
              <View style={st.captionBox}>
                <RichText text={translation.text} language={translation.lang} style={st.caption} />
                {translationBar}
              </View>
            </View>
          ) : null}
          {music ? (
            <MusicSticker
              music={music}
              onOpen={() => {
                onClose();
                openMusic(music.sound);
              }}
            />
          ) : null}
          {!covered && story.stickers.length ? (
            <StickerLayer
              story={story}
              mine={group.mine}
              onBusy={setAnswering}
              onMessage={setSent}
              onChange={(stickers: StorySticker[]) => patchStory({ stickers })}
            />
          ) : null}
        </View>

        <View style={[st.top, { paddingTop: insets.top + space[2] }]} pointerEvents="box-none">
          <View style={{ flexDirection: 'row', gap: 4 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {group.moments.map((m, mi) => (
              <View key={m.id} style={st.bar}>
                <View style={[st.fill, { width: `${mi < i ? 100 : mi > i ? 0 : Math.round(progress * 100)}%` }]} />
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Avatar name={name} url={group.author.avatarUrl} size={32} />
            <View style={{ flex: 1 }}>
              <Text style={[st.who, userText]} numberOfLines={1}>
                {group.mine ? t('m.stories.yours') : name}
              </Text>
              <Text style={st.when}>{timeAgo(story.createdAt)}</Text>
            </View>
            {story.closeFriends ? (
              <View style={[st.closeFriends, { backgroundColor: c.closeFriends }]}>
                <Icon name="people" size={12} color={c.onCloseFriends} />
                <Text style={{ color: c.onCloseFriends, fontSize: 12, fontWeight: '700' }}>{t('m.closeFriends.title')}</Text>
              </View>
            ) : null}
            {story.music ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={musicOn ? t('m.music.off') : t('m.music.on')}
                hitSlop={ICON_SLOP}
                onPress={() => setMusicOn(!musicOn)}
                style={st.icon}
              >
                <Icon name={musicOn ? 'volume-high-outline' : 'volume-mute-outline'} size={20} color={WHITE} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.stories.share')}
              hitSlop={ICON_SLOP}
              onPress={() => setSharing(true)}
              style={st.icon}
            >
              <Icon name="paper-plane-outline" size={20} color={WHITE} directional />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? t('m.common.play') : t('m.common.pause')}
              hitSlop={ICON_SLOP}
              onPress={() => setPaused((p) => !p)}
              style={st.icon}
            >
              <Icon name={paused ? 'play' : 'pause'} size={20} color={WHITE} />
            </Pressable>
            {group.mine ? null : (
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.post.more')} hitSlop={ICON_SLOP} onPress={() => setMoreOpen(true)} style={st.icon}>
                <Icon name="ellipsis-horizontal" size={22} color={WHITE} />
              </Pressable>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={ICON_SLOP} onPress={onClose} style={st.icon}>
              <Icon name="close" size={24} color={WHITE} />
            </Pressable>
          </View>
        </View>

        <View style={[st.foot, { paddingBottom: Math.max(insets.bottom, space[3]) }]}>
          {sent ? (
            <Text accessibilityLiveRegion="polite" style={st.sent}>
              {sent}
            </Text>
          ) : null}
          {group.mine ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {/* Your story's numbers, short on screen and in full for screen readers; it opens who saw it. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={[
                  t('m.stories.seenBy', { count: story.views ?? 0 }),
                  ...(story.likes ? [tp('post.stats.likes', story.likes)] : []),
                  ...(story.replies ? [tp('post.stats.replies', story.replies)] : []),
                  ...(story.shares ? [tp('post.stats.shares', story.shares)] : []),
                ].join(', ')}
                onPress={async () => {
                  // A list that couldn't load says why, rather than showing as "no viewers yet".
                  try {
                    setViewers(await (await client()).moments.viewers(story.id));
                  } catch (e) {
                    setSent(errorMessage(e));
                  }
                }}
                hitSlop={2}
                style={[st.pill, { gap: space[3] }]}
              >
                <StoryStat icon="eye-outline" value={compactCount(story.views ?? 0, locale)} />
                {story.likes ? <StoryStat icon="heart-outline" value={compactCount(story.likes, locale)} /> : null}
                {story.replies ? <StoryStat icon="chatbubble-outline" value={compactCount(story.replies, locale)} /> : null}
                {story.shares ? <StoryStat icon="paper-plane-outline" value={compactCount(story.shares, locale)} /> : null}
              </Pressable>
              <Pressable accessibilityRole="button" hitSlop={2} onPress={() => setChapterFor(story.id)} style={st.pill}>
                <Icon name="albums-outline" size={18} color={WHITE} />
                <Text style={st.pillText}>{t('m.chapters.add')}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setPaused(true);
                  Alert.alert(t('m.stories.delete.title'), t('m.stories.delete.body'), [
                    { text: t('common.cancel'), style: 'cancel', onPress: () => setPaused(false) },
                    {
                      text: t('m.common.delete'),
                      style: 'destructive',
                      onPress: () => {
                        setPaused(false);
                        void remove();
                      },
                    },
                  ]);
                }}
                hitSlop={2}
                style={st.pill}
              >
                <Icon name="trash-outline" size={18} color={WHITE} />
                <Text style={st.pillText}>{t('m.common.delete')}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ gap: space[2] }}>
              {story.mentionsYou && story.canReshare ? (
                <Pressable accessibilityRole="button" hitSlop={2} onPress={() => void addToStory('followers')} style={[st.pill, { alignSelf: 'flex-start' }]}>
                  <Icon name="add-circle-outline" size={18} color={WHITE} />
                  <Text style={st.pillText}>{t('m.stories.add')}</Text>
                </Pressable>
              ) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                <TextInput
                  accessibilityLabel={t('m.stories.replyTo', { name })}
                  placeholder={t('m.stories.replyTo', { name })}
                  placeholderTextColor="rgba(255,255,255,0.75)"
                  value={reply}
                  onChangeText={setReply}
                  onFocus={() => setTyping(true)}
                  onBlur={() => setTyping(false)}
                  maxLength={1000}
                  returnKeyType="send"
                  onSubmitEditing={() => void sendReply()}
                  style={[st.reply, userText]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={(story.liked ? t('post.unlike') : t('post.like')) + (story.likes ? `, ${tp('post.stats.likes', story.likes)}` : '')}
                  accessibilityState={{ selected: story.liked }}
                  hitSlop={ICON_SLOP}
                  onPress={async () => {
                    const liked = !story.liked;
                    // The like count moves with the heart, when the story has one (its author can hide it).
                    const set = (v: boolean) =>
                      onChange(
                        groups.map((x, gi) =>
                          gi !== g
                            ? x
                            : {
                                ...x,
                                moments: x.moments.map((m, mi) =>
                                  mi !== i || m.liked === v
                                    ? m
                                    : { ...m, liked: v, likes: m.likes === undefined ? undefined : Math.max(0, m.likes + (v ? 1 : -1)) },
                                ),
                              },
                        ),
                      );
                    set(liked);
                    try {
                      await (await client()).moments.like(story.id, liked);
                    } catch {
                      set(!liked);
                    }
                  }}
                  style={story.likes ? st.iconCount : st.icon}
                >
                  <Icon name={story.liked ? 'heart' : 'heart-outline'} size={26} color={story.liked ? c.yapi : WHITE} />
                  {story.likes ? (
                    <Text style={st.likes} numberOfLines={1}>
                      {compactCount(story.likes, locale)}
                    </Text>
                  ) : null}
                </Pressable>
                {reply.trim() ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('m.stories.sendReply')}
                    accessibilityState={{ disabled: replying, busy: replying }}
                    disabled={replying}
                    hitSlop={ICON_SLOP}
                    onPress={() => void sendReply()}
                    style={[st.icon, replying && { opacity: 0.5 }]}
                  >
                    <Icon name="send" size={22} color={WHITE} directional />
                  </Pressable>
                ) : null}
              </View>
            </View>
          )}
        </View>
      </Animated.View>

      <AddToChapterSheet momentId={chapterFor} onClose={() => setChapterFor(null)} onAdded={setSent} />
      <ActionSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        title={name}
        actions={[
          {
            label: t('post.report'),
            icon: 'flag-outline',
            destructive: true,
            onPress: () => report.open({ type: 'story', id: story.id, authorId: group.author.id, authorName: name }),
          },
        ]}
      />
      {report.sheet}
      {viewers !== null ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay, justifyContent: 'flex-end' }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} style={{ flex: 1 }} onPress={() => setViewers(null)} />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: c.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              padding: space[4],
              paddingBottom: Math.max(insets.bottom, space[4]),
              maxHeight: '60%',
              gap: space[3],
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {t('m.stories.seenByTitle')}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={10} onPress={() => setViewers(null)}>
                <Icon name="close" size={24} color={c.ink} />
              </Pressable>
            </View>
            {viewers.results.length || viewers.reshares ? (
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 260 }} contentContainerStyle={{ gap: space[3] }}>
                <StickerResultList results={viewers.results} />
                {viewers.reshares ? <Text style={{ color: c.inkMuted }}>{tp('m.stories.reshares', viewers.reshares)}</Text> : null}
              </ScrollView>
            ) : null}
            <FlatList
              keyboardShouldPersistTaps="handled"
              data={viewers.items}
              keyExtractor={(v) => v.user.id}
              contentContainerStyle={{ gap: space[3] }}
              ListEmptyComponent={<Text style={{ color: c.inkMuted }}>{t('m.stories.noViewers')}</Text>}
              renderItem={({ item }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                  <Avatar name={item.user.displayName} url={item.user.avatarUrl} size={36} />
                  <View style={{ flex: 1 }}>
                    <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                      {item.user.displayName}
                    </Text>
                    <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                      @{item.user.username}
                    </Text>
                  </View>
                  {item.liked ? (
                    <View accessible accessibilityLabel={t('m.stories.liked')}>
                      <Icon name="heart" size={20} color={c.yapi} />
                    </View>
                  ) : null}
                </View>
              )}
            />
          </View>
        </View>
      ) : null}

      {sharing ? (
        <ShareSheet
          story={story}
          mine={group.mine}
          onClose={() => setSharing(false)}
          onAddToStory={addToStory}
          onSent={(text) => {
            setSharing(false);
            setSent(text);
          }}
          onAllowReshare={async (allow) => {
            try {
              const r = await (await client()).moments.update(story.id, { allowReshare: allow });
              patchStory({ allowReshare: r.allowReshare });
            } catch (e) {
              setSent(errorMessage(e));
            }
          }}
        />
      ) : null}
    </KeyboardAvoid>
  );

  async function sendReply() {
    const body = reply.trim();
    if (!body || !story || replyingRef.current) return;
    replyingRef.current = true;
    setReplying(true);
    try {
      await (await client()).moments.reply(story.id, body);
      setReply('');
      setSent(t('m.stories.sent', { name }));
    } catch (e) {
      setSent(errorMessage(e));
    } finally {
      replyingRef.current = false;
      setReplying(false);
    }
  }
}

/** One of your story's numbers in its pill: an icon and the short number (the pill has the full label). */
function StoryStat({ icon, value }: { icon: 'eye-outline' | 'heart-outline' | 'chatbubble-outline' | 'paper-plane-outline'; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Icon name={icon} size={18} color={WHITE} directional={icon === 'paper-plane-outline'} />
      <Text style={st.pillText}>{value}</Text>
    </View>
  );
}

/** A story video: plays once to the end, reporting progress, and pauses while held. Muted when the story has music. */
function StoryVideo({
  uri,
  paused,
  muted,
  onProgress,
  onEnd,
}: {
  uri: string;
  paused: boolean;
  muted: boolean;
  onProgress: (p: number) => void;
  onEnd: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = muted;
    p.timeUpdateEventInterval = 0.1;
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (player.duration > 0) onProgress(Math.min(1, currentTime / player.duration));
  });
  useEventListener(player, 'playToEnd', onEnd);
  useEffect(() => {
    if (paused) player.pause();
    else player.play();
  }, [paused, player]);
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} pointerEvents="none" />;
}

// The 40pt round buttons sit 8 apart: 4 each side keeps their touch areas (48 × 56) from overlapping.
const ICON_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };

const st = StyleSheet.create({
  item: { width: RING + 8, alignItems: 'center' },
  ring: { width: RING, height: RING, borderRadius: RING / 2, alignItems: 'center', justifyContent: 'center' },
  inner: { width: RING - 6, height: RING - 6, borderRadius: (RING - 6) / 2, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 12, fontWeight: '600', maxWidth: RING + 8, textAlign: 'center' },
  plus: {
    position: 'absolute',
    top: RING - 22,
    end: 2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  top: { position: 'absolute', top: 0, start: 0, end: 0, paddingHorizontal: space[3], gap: space[2] },
  bar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
  fill: { height: 3, backgroundColor: WHITE },
  who: { color: WHITE, fontWeight: '700', fontSize: 14 },
  when: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  // The heart with its like count beside it: as tall as the other icons, as wide as the number needs.
  iconCount: { minWidth: 40, height: 40, borderRadius: 20, flexDirection: 'row', gap: 4, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  closeFriends: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  caption: {
    color: WHITE,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  captionBox: {
    backgroundColor: SCRIM,
    borderRadius: radius.md,
    padding: space[2],
    overflow: 'hidden',
  },
  foot: { position: 'absolute', bottom: 0, start: 0, end: 0, paddingHorizontal: space[3], paddingTop: space[2], gap: space[2] },
  sent: {
    alignSelf: 'center',
    color: WHITE,
    backgroundColor: SCRIM,
    borderRadius: radius.full,
    paddingHorizontal: space[3],
    paddingVertical: 6,
    overflow: 'hidden',
  },
  reply: {
    flex: 1,
    height: 44,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    color: WHITE,
    paddingHorizontal: space[4],
    fontSize: 15,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: SCRIM,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  pillText: { color: WHITE, fontWeight: '700', fontSize: 14 },
  likes: { color: WHITE, fontWeight: '700', fontSize: 13, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 },
  search: { height: 44, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space[3], fontSize: 15 },
  sheetButton: { height: 44, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
});

const AUDIENCES = ['followers', 'friends', 'public', 'close_friends'] as const;

/** Send to people, share the link, add to your own story, or (your own) choose whether others can reshare it. */
function ShareSheet({
  story,
  mine,
  onClose,
  onAddToStory,
  onSent,
  onAllowReshare,
}: {
  story: Story;
  mine: boolean;
  onClose: () => void;
  onAddToStory: (visibility: string) => Promise<void>;
  onSent: (text: string) => void;
  onAllowReshare: (allow: boolean) => Promise<void>;
}) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<{ user: PublicUser; canMessage: boolean }[]>([]);
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number]>('followers');

  useEffect(() => {
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 8))
          .then(
            (r) => setPeople(r.items),
            () => setPeople([]),
          ),
      q ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  const toggle = (u: PublicUser) => setPicked((p) => (p.some((x) => x.id === u.id) ? p.filter((x) => x.id !== u.id) : [...p, u]));
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).moments.send(story.id, { userIds: picked.map((p) => p.id), body: note.trim() });
      onSent(picked.length === 1 ? t('m.stories.sent', { name: picked[0]!.displayName }) : t('m.stories.sentMany', { count: r.conversationIds.length }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay, justifyContent: 'flex-end' }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} style={{ flex: 1 }} onPress={onClose} />
      <View
        accessibilityViewIsModal
        style={{
          backgroundColor: c.surface,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          padding: space[4],
          paddingBottom: Math.max(insets.bottom, space[4]),
          maxHeight: '80%',
          gap: space[3],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.stories.share')}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={10} onPress={onClose}>
            <Icon name="close" size={24} color={c.ink} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ gap: space[3] }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: c.ink, fontWeight: '600' }}>{t('m.stories.sendTo')}</Text>
          <TextInput
            accessibilityLabel={t('m.stories.searchPeople')}
            placeholder={t('m.stories.searchPeople')}
            placeholderTextColor={c.inkMuted}
            value={q}
            onChangeText={setQ}
            autoCapitalize="none"
            style={[st.search, { borderColor: c.line, color: c.ink, backgroundColor: c.surface }, userText]}
          />
          {people.map(({ user, canMessage }) => {
            const on = picked.some((p) => p.id === user.id);
            return (
              <Pressable
                key={user.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: !canMessage }}
                disabled={!canMessage}
                hitSlop={{ top: 4, bottom: 4 }}
                onPress={() => toggle(user)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], opacity: canMessage ? 1 : 0.45 }}
              >
                <Avatar name={user.displayName} url={user.avatarUrl} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                    {user.displayName}
                  </Text>
                  <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                    @{user.username}
                  </Text>
                </View>
                <Icon name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
              </Pressable>
            );
          })}
          {picked.length ? (
            <>
              <TextInput
                accessibilityLabel={t('inbox.placeholder')}
                placeholder={t('inbox.placeholder')}
                placeholderTextColor={c.inkMuted}
                value={note}
                onChangeText={setNote}
                maxLength={1000}
                style={[st.search, { borderColor: c.line, color: c.ink, backgroundColor: c.surface }, userText]}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => void send()}
                style={[st.sheetButton, { backgroundColor: c.yapi }]}
              >
                <Text style={{ color: c.onYapi, fontWeight: '700' }}>{t('m.stories.send')}</Text>
              </Pressable>
            </>
          ) : null}
          {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const url = `${webUrl}/s/${story.id}`;
              void Share.share(Platform.OS === 'ios' ? { url } : { message: url }).catch(() => {});
            }}
            style={[st.sheetButton, { borderWidth: 1, borderColor: c.line, flexDirection: 'row', gap: space[2] }]}
          >
            <Icon name="link" size={18} color={c.ink} />
            <Text style={{ color: c.ink, fontWeight: '700' }}>{t('m.stories.shareLink')}</Text>
          </Pressable>
          {!mine && story.canReshare ? (
            <View style={{ gap: space[2] }}>
              <Text style={{ color: c.ink, fontWeight: '600' }}>{t('m.stories.audience')}</Text>
              <Segmented
                label={t('m.stories.audience')}
                options={AUDIENCES.map((a) => ({ id: a, label: t(`visibility.${a}`) }))}
                value={audience}
                onChange={setAudience}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => void onAddToStory(audience)}
                style={[st.sheetButton, { borderWidth: 1, borderColor: c.line, flexDirection: 'row', gap: space[2] }]}
              >
                <Icon name="add-circle-outline" size={18} color={c.ink} />
                <Text style={{ color: c.ink, fontWeight: '700' }}>{t('m.stories.add')}</Text>
              </Pressable>
            </View>
          ) : null}
          {mine && !story.reshareOf ? (
            <SwitchRow
              label={t('m.stories.allowReshare')}
              hint={t('m.stories.allowReshareHint')}
              value={!!story.allowReshare}
              onValueChange={(v) => void onAllowReshare(v)}
            />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

/** Poll results, slider averages, question answers and countdown reminders, for the author. */
function StickerResultList({ results }: { results: StickerResults[] }) {
  const c = useColors();
  const { t, tp, number } = useT();
  return (
    <>
      {results.map((r) => (
        <View key={r.stickerId} style={{ gap: space[1] }}>
          {r.type === 'poll' ? (
            <>
              <Text style={{ color: c.ink, fontWeight: '700' }}>
                {t('m.sticker.kind.poll')} · {tp('m.sticker.votes', r.votes)}
              </Text>
              {r.options.map((o, k) => (
                <View key={k} style={{ borderRadius: radius.sm, backgroundColor: c.surfaceSunken, overflow: 'hidden', padding: space[2] }}>
                  <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, width: `${r.percents[k]}%`, backgroundColor: c.yapiSoft }} />
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={[{ color: c.ink }, userText]}>{o}</Text>
                    <Text style={{ color: c.ink, fontWeight: '700' }}>
                      {number(r.percents[k] / 100, { style: 'percent' })} ({number(r.counts[k])})
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : r.type === 'slider' ? (
            <>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>
                {r.emoji} {r.prompt}
              </Text>
              <Text style={{ color: c.inkMuted }}>
                {r.count ? t('m.sticker.average', { percent: number(r.average ?? 0, { style: 'percent' }), count: r.count }) : t('m.sticker.noAnswers')}
              </Text>
            </>
          ) : r.type === 'countdown' ? (
            <>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{r.title}</Text>
              <Text style={{ color: c.inkMuted }}>{t('m.sticker.reminders', { count: r.reminders })}</Text>
            </>
          ) : (
            <>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{r.prompt}</Text>
              {r.answers.length ? (
                r.answers.map((a) => (
                  <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                    <Avatar name={a.user.displayName} url={a.user.avatarUrl} size={28} />
                    <View style={{ flex: 1 }}>
                      <Text style={[{ color: c.ink }, userText]}>{a.text}</Text>
                      <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]}>@{a.user.username}</Text>
                    </View>
                  </View>
                ))
              ) : (
                <Text style={{ color: c.inkMuted }}>{t('m.sticker.noAnswers')}</Text>
              )}
            </>
          )}
        </View>
      ))}
    </>
  );
}
