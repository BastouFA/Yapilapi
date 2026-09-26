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
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StoryGroup } from '../../../packages/api-client/src/index';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import { gradient, radius, space } from './theme';
import { Avatar, Icon, useColors, userText } from './ui';
import { SensitiveCover } from './safety';

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
export function StoriesStrip({ groups, onOpen, onCreate }: { groups: StoryGroup[]; onOpen: (index: number) => void; onCreate: () => void }) {
  const c = useColors();
  const { t } = useT();
  const hasOwn = groups.some((g) => g.mine);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={t('m.stories.label')}
      contentContainerStyle={{ gap: space[3], paddingVertical: space[1] }}
    >
      {!hasOwn ? (
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
        const avatar = (
          <View style={[st.inner, { backgroundColor: c.ground }]}>
            <Avatar name={g.author.displayName} url={g.author.avatarUrl} size={RING - 10} />
          </View>
        );
        return (
          <View key={g.author.id} style={st.item}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={g.allSeen ? t('m.stories.a11y.seen', { name }) : t('m.stories.a11y.new', { name })}
              onPress={() => onOpen(i)}
              style={{ alignItems: 'center', gap: 4 }}
            >
              {g.allSeen ? (
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
            {g.mine ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.stories.add')}
                hitSlop={6}
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
  return (
    <Modal visible={start !== null} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      {start !== null && groups[start] ? <Viewer groups={groups} start={start} onClose={onClose} onChange={onChange} /> : null}
    </Modal>
  );
}

function Viewer({ groups, start, onClose, onChange }: { groups: StoryGroup[]; start: number; onClose: () => void; onChange: (groups: StoryGroup[]) => void }) {
  const c = useColors();
  const { t, timeAgo } = useT();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [g, setG] = useState(start);
  const [i, setI] = useState(() => Math.max(0, groups[start]?.moments.findIndex((m) => !m.seen) ?? 0));
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reply, setReply] = useState('');
  const [typing, setTyping] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [viewers, setViewers] = useState<{ user: PublicUser; liked: boolean }[] | null>(null);
  const group = groups[g];
  const story = group?.moments[i];
  // Sensitive stories wait, blurred and paused, until the viewer chooses to see them.
  const [revealed, setRevealed] = useState<string[]>([]);
  const covered = !!story?.sensitive && !revealed.includes(story.id);
  const stopped = held || paused || typing || viewers !== null || covered;

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
  useEffect(() => {
    if (!story || story.mediaKind === 'video' || stopped) return;
    const started = Date.now() - progressRef.current * PHOTO_MS;
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
  const uri = story.mediaUrl ? mediaUrl(story.mediaUrl) : null;

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
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#000' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
          accessibilityLabel={story.body || t('m.stories.photo', { name })}
          accessibilityHint={t('m.stories.hint')}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment') next();
            else if (e.nativeEvent.actionName === 'decrement') prev();
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
          ) : story.mediaKind === 'video' && uri ? (
            <StoryVideo key={story.id} uri={uri} paused={stopped} onProgress={setProgress} onEnd={next} />
          ) : story.mediaKind === 'image' && uri ? (
            <Image
              key={story.id}
              source={{ uri }}
              accessibilityLabel={story.body || t('m.stories.photo', { name })}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          ) : (
            <LinearGradient {...gradient(c)} style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[6] }]}>
              <Text style={[{ color: WHITE, fontSize: 28, fontWeight: '800', textAlign: 'center', lineHeight: 36 }, userText]}>{story.body}</Text>
            </LinearGradient>
          )}
          {story.body && uri ? (
            <View style={{ position: 'absolute', start: space[4], end: space[4], bottom: 110 + insets.bottom }} pointerEvents="none">
              <Text style={[st.caption, userText]}>{story.body}</Text>
            </View>
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? t('m.common.play') : t('m.common.pause')}
              hitSlop={8}
              onPress={() => setPaused((p) => !p)}
              style={st.icon}
            >
              <Icon name={paused ? 'play' : 'pause'} size={20} color={WHITE} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={8} onPress={onClose} style={st.icon}>
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
            <View style={{ flexDirection: 'row', gap: space[2] }}>
              <Pressable
                accessibilityRole="button"
                onPress={async () => {
                  const r = await client()
                    .then((api) => api.moments.viewers(story.id))
                    .catch(() => ({ items: [] }));
                  setViewers(r.items);
                }}
                style={st.pill}
              >
                <Icon name="eye-outline" size={18} color={WHITE} />
                <Text style={st.pillText}>{t('m.stories.seenBy', { count: story.views ?? 0 })}</Text>
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
                style={st.pill}
              >
                <Icon name="trash-outline" size={18} color={WHITE} />
                <Text style={st.pillText}>{t('m.common.delete')}</Text>
              </Pressable>
            </View>
          ) : (
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
                accessibilityLabel={story.liked ? t('post.unlike') : t('post.like')}
                accessibilityState={{ selected: story.liked }}
                hitSlop={8}
                onPress={async () => {
                  const liked = !story.liked;
                  const set = (v: boolean) =>
                    onChange(groups.map((x, gi) => (gi !== g ? x : { ...x, moments: x.moments.map((m, mi) => (mi === i ? { ...m, liked: v } : m)) })));
                  set(liked);
                  try {
                    await (await client()).moments.like(story.id, liked);
                  } catch {
                    set(!liked);
                  }
                }}
                style={st.icon}
              >
                <Icon name={story.liked ? 'heart' : 'heart-outline'} size={26} color={story.liked ? c.yapi : WHITE} />
              </Pressable>
              {reply.trim() ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('m.stories.sendReply')}
                  hitSlop={8}
                  onPress={() => void sendReply()}
                  style={st.icon}
                >
                  <Icon name="send" size={22} color={WHITE} directional />
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      </Animated.View>

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
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={8} onPress={() => setViewers(null)}>
                <Icon name="close" size={24} color={c.ink} />
              </Pressable>
            </View>
            <FlatList
              data={viewers}
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
    </KeyboardAvoidingView>
  );

  async function sendReply() {
    const body = reply.trim();
    if (!body || !story) return;
    try {
      await (await client()).moments.reply(story.id, body);
      setReply('');
      setSent(t('m.stories.sent', { name }));
    } catch (e) {
      setSent(errorMessage(e));
    }
  }
}

/** A story video: plays once to the end, reporting progress, and pauses while held. */
function StoryVideo({ uri, paused, onProgress, onEnd }: { uri: string; paused: boolean; onProgress: (p: number) => void; onEnd: () => void }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
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
  caption: {
    color: WHITE,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
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
});
