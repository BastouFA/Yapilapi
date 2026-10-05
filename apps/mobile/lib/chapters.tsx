import { useEventListener } from 'expo';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, I18nManager, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Chapter, ChapterDetail } from '../../../packages/api-client/src/index';
import { CHAPTER_GRADIENTS, CHAPTER_GUESTBOOK_MAX, CHAPTER_TITLE_MAX, type ChapterGradient, type ChapterSymbol } from '../../../packages/shared/src/constants';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import { SensitiveCover } from './safety';
import { useSession } from './session';
import { radius, space } from './theme';
import { Avatar, BottomSheet, Button, Field, Icon, type IconName, KeyboardAvoid, useColors, userText, useScreenFocused } from './ui';

const PHOTO_MS = 5000;
const WHITE = '#FFFFFF';
const SCRIM = 'rgba(0,0,0,0.35)';

/** The shared cover symbols as Ionicons. */
export const SYMBOL_ICON: Record<ChapterSymbol, IconName> = {
  star: 'star',
  sparkle: 'sparkles',
  heart: 'heart',
  music: 'musical-notes',
  globe: 'globe-outline',
  calendar: 'calendar',
  compass: 'compass',
  home: 'home',
  bookmark: 'bookmark',
  image: 'image',
};

export const isSealed = (c: Chapter) => !!c.capsule && !c.capsule.open;

/**
 * A chapter's cover: one of its stories, or its gradient and symbol. A time capsule keeps its
 * gradient and symbol with a small lock, since people may see the cover before it opens.
 */
export function ChapterCover({ chapter, size = 72 }: { chapter: Chapter; size?: number }) {
  const sealed = isSealed(chapter);
  const cv = chapter.cover;
  const image = cv.kind === 'story' && !sealed ? (cv.mediaKind === 'image' ? cv.mediaUrl : cv.posterUrl) : null;
  return (
    <CoverPreview size={size} gradient={chapter.coverGradient} symbol={chapter.coverSymbol} image={image} locked={!!chapter.capsule && !chapter.capsule.open} />
  );
}

/** The cover square itself, also the live preview while choosing a colour and symbol. */
export function CoverPreview({
  size,
  gradient,
  symbol,
  image,
  locked,
}: {
  size: number;
  gradient: ChapterGradient;
  symbol: ChapterSymbol;
  image?: string | null;
  locked?: boolean;
}) {
  const box = { width: size, height: size, borderRadius: radius.md, overflow: 'hidden' as const };
  const lock = locked ? (
    <View style={{ position: 'absolute', bottom: 4, end: 4, padding: 3, borderRadius: 99, backgroundColor: 'rgba(0,0,0,0.45)' }}>
      <Icon name="lock-closed" size={Math.max(11, Math.round(size * 0.17))} color={WHITE} />
    </View>
  ) : null;
  if (image)
    return (
      <View style={box}>
        <Image source={{ uri: mediaUrl(image) }} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />
        {lock}
      </View>
    );
  const [from, to] = CHAPTER_GRADIENTS[gradient];
  return (
    <LinearGradient colors={[from, to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[box, { alignItems: 'center', justifyContent: 'center' }]}>
      <Icon name={SYMBOL_ICON[symbol]} size={Math.round(size * 0.4)} color={WHITE} />
      {lock}
    </LinearGradient>
  );
}

/** "Opens 12 Mar 2027 · 4 stories · Shared". */
export function useChapterMeta() {
  const { t, tp, date } = useT();
  return (c: Chapter) =>
    [
      isSealed(c) ? t('m.chapters.opens', { date: date(c.capsule!.opensAt, { dateStyle: 'medium' }) }) : null,
      tp('m.chapters.stories', c.storyCount),
      c.shared ? t('m.chapters.shared') : null,
    ]
      .filter(Boolean)
      .join(' · ');
}

/**
 * The row of chapter covers on a profile. Open chapters play right away; a sealed time capsule
 * (or an empty chapter) opens its page. On your own profile it starts a new chapter and links
 * to your archive.
 */
export function ChaptersRow({
  userId,
  isSelf,
  emptyText,
}: {
  userId: string;
  isSelf: boolean;
  /** Shown to visitors when there are none (as a profile tab). */ emptyText?: string;
}) {
  const c = useColors();
  const { t, date } = useT();
  const meta = useChapterMeta();
  const [items, setItems] = useState<Chapter[] | null>(null);
  const [playing, setPlaying] = useState<ChapterDetail | null>(null);

  useEffect(() => {
    let live = true;
    client()
      .then((api) => api.chapters.forUser(userId))
      .then(
        (r) => live && setItems(r.items),
        () => live && setItems([]),
      );
    return () => {
      live = false;
    };
  }, [userId]);

  if (items && !items.length && !isSelf && emptyText)
    return <Text style={{ color: c.inkMuted, textAlign: 'center', paddingVertical: space[4] }}>{emptyText}</Text>;
  if (!items || (!items.length && !isSelf)) return null;
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('m.chapters.title')}
        </Text>
        {isSelf ? (
          // A line of text: the touch area reaches 44 tall, less downwards, where the chapters start 8pt under the heading.
          <Pressable accessibilityRole="button" hitSlop={{ top: 16, bottom: 8, left: 8, right: 8 }} onPress={() => router.push('/archive')}>
            <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('m.archive.title')}</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[3] }}>
        {isSelf ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.chapters.new')} onPress={() => router.push('/chapter-edit')} style={st.tile}>
            <View style={[st.newCover, { borderColor: c.lineStrong, backgroundColor: c.surfaceSunken }]}>
              <Icon name="add" size={28} color={c.yapi} />
            </View>
            <Text style={[st.tileTitle, { color: c.ink }]} numberOfLines={1}>
              {t('m.chapters.new')}
            </Text>
          </Pressable>
        ) : null}
        {items.map((ch) => (
          <Pressable
            key={ch.id}
            accessibilityRole="button"
            accessibilityLabel={`${ch.title}, ${meta(ch)}`}
            style={st.tile}
            onPress={async () => {
              if (isSealed(ch) || !ch.storyCount) return router.push(`/chapter/${ch.id}`);
              try {
                setPlaying(await (await client()).chapters.get(ch.id));
              } catch {
                router.push(`/chapter/${ch.id}`);
              }
            }}
          >
            <ChapterCover chapter={ch} />
            <Text style={[st.tileTitle, { color: c.ink }, userText]} numberOfLines={1}>
              {ch.title}
            </Text>
            {isSealed(ch) ? (
              <Text style={{ color: c.inkMuted, fontSize: 11 }} numberOfLines={1}>
                {t('m.chapters.opens', { date: date(ch.capsule!.opensAt, { dateStyle: 'medium' }) })}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
      <ChapterPlayer detail={playing} onClose={() => setPlaying(null)} />
    </View>
  );
}

/**
 * Plays a chapter full screen: its stories in order, each with who shared it and the date.
 * Tap the start or end side for previous and next. When it finishes, viewers can leave one
 * short line in the guestbook.
 */
export function ChapterPlayer({ detail, start = 0, onClose }: { detail: ChapterDetail | null; start?: number; onClose: () => void }) {
  const focused = useScreenFocused();
  return (
    <Modal visible={!!detail && focused} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      {detail ? <Player detail={detail} start={start} onClose={onClose} /> : null}
    </Modal>
  );
}

function Player({ detail, start, onClose }: { detail: ChapterDetail; start: number; onClose: () => void }) {
  const { t, date } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { chapter, stories } = detail;
  const [i, setI] = useState(start);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [done, setDone] = useState(stories.length === 0);
  const [line, setLine] = useState('');
  // A guestbook line on its way: a second tap doesn't sign twice.
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string[]>([]);
  const story = stories[i];
  const covered = !!story?.sensitive && !revealed.includes(story.id);
  const stopped = paused || done || covered;

  const next = useCallback(() => {
    if (i < stories.length - 1) setI(i + 1);
    else setDone(true);
  }, [i, stories.length]);
  const prev = useCallback(() => {
    if (done) setDone(false);
    else if (i > 0) setI(i - 1);
  }, [i, done]);

  useEffect(() => setProgress(0), [story?.id]);
  useEffect(() => {
    if (!story || story.mediaKind === 'video' || stopped) return;
    const started = Date.now() - progress * PHOTO_MS;
    const timer = setInterval(() => {
      const p = (Date.now() - started) / PHOTO_MS;
      if (p >= 1) {
        clearInterval(timer);
        next();
      } else setProgress(p);
    }, 50);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, stopped, next]);

  const uri = story?.mediaUrl ? mediaUrl(story.mediaUrl) : null;
  const canSign = !!me && !isSealed(chapter);

  return (
    <KeyboardAvoid offset={0} style={{ backgroundColor: '#000' }}>
      {done ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[6], gap: space[3] }]}>
          <ChapterCover chapter={chapter} size={96} />
          <Text accessibilityRole="header" style={[{ color: WHITE, fontSize: 24, fontWeight: '800', textAlign: 'center' }, userText]}>
            {chapter.title}
          </Text>
          {chapter.description ? <Text style={[{ color: 'rgba(255,255,255,0.8)', textAlign: 'center' }, userText]}>{chapter.description}</Text> : null}
          {canSign ? (
            note ? (
              <Text accessibilityLiveRegion="polite" style={{ color: WHITE, textAlign: 'center' }}>
                {note}
              </Text>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], alignSelf: 'stretch' }}>
                <TextInput
                  accessibilityLabel={t('m.chapters.guestbookPlaceholder')}
                  placeholder={t('m.chapters.guestbookPlaceholder')}
                  placeholderTextColor="rgba(255,255,255,0.75)"
                  value={line}
                  onChangeText={setLine}
                  maxLength={CHAPTER_GUESTBOOK_MAX}
                  returnKeyType="send"
                  onSubmitEditing={() => void sign()}
                  style={[st.input, userText]}
                />
                {line.trim() ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('m.chapters.sign')}
                    accessibilityState={{ disabled: signing, busy: signing }}
                    disabled={signing}
                    hitSlop={8}
                    onPress={() => void sign()}
                    style={[st.icon, signing && { opacity: 0.5 }]}
                  >
                    <Icon name="send" size={22} color={WHITE} directional />
                  </Pressable>
                ) : null}
              </View>
            )
          ) : null}
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            {stories.length ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setDone(false);
                  setI(0);
                }}
                // 40pt tall; the touch area reaches 44.
                hitSlop={2}
                style={st.pill}
              >
                <Icon name="refresh" size={18} color={WHITE} />
                <Text style={st.pillText}>{t('m.chapters.playAgain')}</Text>
              </Pressable>
            ) : null}
            {me ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  router.push(`/chapter/${chapter.id}`);
                }}
                // 40pt tall; the touch area reaches 44.
                hitSlop={2}
                style={st.pill}
              >
                <Icon name="book-outline" size={18} color={WHITE} />
                <Text style={st.pillText}>{t('m.chapters.guestbook')}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : story ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="adjustable"
          accessibilityLabel={t('m.chapters.viewer', { title: chapter.title, index: i + 1, total: stories.length })}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment') next();
            else if (e.nativeEvent.actionName === 'decrement') prev();
            else setPaused((p) => !p);
          }}
          onLongPress={() => setPaused(true)}
          onPressOut={() => paused && setPaused(false)}
          onPress={(e) => {
            const x = e.nativeEvent.pageX;
            const startSide = I18nManager.isRTL ? x > (width * 2) / 3 : x < width / 3;
            if (startSide) prev();
            else next();
          }}
        >
          {covered && uri ? (
            <>
              {story.mediaKind === 'image' || story.posterUrl ? (
                <Image
                  source={{ uri: story.mediaKind === 'image' ? uri : mediaUrl(story.posterUrl!) }}
                  blurRadius={50}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                />
              ) : null}
              <SensitiveCover onReveal={() => setRevealed((r) => [...r, story.id])} />
            </>
          ) : story.mediaKind === 'video' && uri ? (
            <ChapterVideo key={story.id} uri={uri} paused={stopped} onProgress={setProgress} onEnd={next} />
          ) : story.mediaKind === 'image' && uri ? (
            <Image key={story.id} source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityIgnoresInvertColors />
          ) : (
            <LinearGradient
              colors={[...CHAPTER_GRADIENTS[chapter.coverGradient]]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[6] }]}
            >
              <Text style={[{ color: WHITE, fontSize: 28, fontWeight: '800', textAlign: 'center', lineHeight: 36 }, userText]}>{story.body}</Text>
            </LinearGradient>
          )}
          {story.body && uri ? (
            <View style={{ position: 'absolute', start: space[4], end: space[4], bottom: space[8] + insets.bottom }} pointerEvents="none">
              <Text style={[st.caption, userText]}>{story.body}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}

      <View style={[st.top, { paddingTop: insets.top + space[2] }]} pointerEvents="box-none">
        <View style={{ flexDirection: 'row', gap: 4 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {stories.map((s, si) => (
            <View key={s.id} style={st.bar}>
              <View style={[st.fill, { width: `${done || si < i ? 100 : si > i ? 0 : Math.round(progress * 100)}%` }]} />
            </View>
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          {story && !done ? <Avatar name={story.author.displayName} url={story.author.avatarUrl} size={32} /> : <ChapterCover chapter={chapter} size={32} />}
          <View style={{ flex: 1 }}>
            <Text style={[st.who, userText]} numberOfLines={1}>
              {chapter.title}
            </Text>
            <Text style={[st.when, userText]} numberOfLines={1}>
              {story && !done
                ? t('m.chapters.storyBy', { name: story.author.displayName, date: date(story.createdAt, { dateStyle: 'long' }) })
                : chapter.owner.displayName}
            </Text>
          </View>
          {!done ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? t('m.common.play') : t('m.common.pause')}
              // 40pt buttons 8pt apart: 4pt more each way reaches 48 without overlapping.
              hitSlop={4}
              onPress={() => setPaused((p) => !p)}
              style={st.icon}
            >
              <Icon name={paused ? 'play' : 'pause'} size={20} color={WHITE} />
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={4} onPress={onClose} style={st.icon}>
            <Icon name="close" size={24} color={WHITE} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoid>
  );

  async function sign() {
    const body = line.trim();
    if (!body || signing) return;
    setSigning(true);
    try {
      const { entry } = await (await client()).chapters.sign(chapter.id, body);
      setNote(entry.pending ? t('m.chapters.signedPending') : t('m.chapters.signed'));
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setSigning(false);
    }
  }
}

function ChapterVideo({ uri, paused, onProgress, onEnd }: { uri: string; paused: boolean; onProgress: (p: number) => void; onEnd: () => void }) {
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

/**
 * Add one of your stories (up now, or from your archive) to a chapter you own or contribute to,
 * or start a new chapter with it.
 */
export function AddToChapterSheet({ momentId, onClose, onAdded }: { momentId: string | null; onClose: () => void; onAdded?: (message: string) => void }) {
  const c = useColors();
  const { t, tp } = useT();
  const [items, setItems] = useState<Chapter[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!momentId) return;
    setItems(null);
    setTitle('');
    setError(null);
    client()
      .then((api) => api.chapters.mine())
      .then(
        (r) => setItems(r.items.filter((x) => x.canAdd)),
        () => setItems([]),
      );
  }, [momentId]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      const message = await fn();
      onAdded?.(message);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={!!momentId} title={t('m.chapters.add')} onClose={onClose} scroll={false} maxHeight="75%">
      {items === null ? (
        <ActivityIndicator color={c.yapi} />
      ) : items.length ? (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space[2] }}>
          {items.map((ch) => (
            <Pressable
              key={ch.id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await (await client()).chapters.addStory(ch.id, momentId!);
                  return t('m.chapters.added', { title: ch.title });
                })
              }
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[3],
                padding: space[2],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
              }}
            >
              <ChapterCover chapter={ch} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                  {ch.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                  {ch.role === 'contributor' ? `${t('m.chapters.by', { name: ch.owner.displayName })} · ` : ''}
                  {tp('m.chapters.stories', ch.storyCount)}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('m.chapters.none')}</Text>
      )}
      <Field
        label={t('m.chapters.newLabel')}
        placeholder={t('m.chapters.newPlaceholder')}
        value={title}
        onChangeText={setTitle}
        maxLength={CHAPTER_TITLE_MAX}
      />
      <Button
        label={t('m.chapters.create')}
        disabled={!title.trim() || busy}
        onPress={() =>
          run(async () => {
            await (await client()).chapters.create({ title: title.trim(), momentIds: [momentId!] });
            return t('m.chapters.started', { title: title.trim() });
          })
        }
      />
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
    </BottomSheet>
  );
}

const st = StyleSheet.create({
  tile: { width: 84, alignItems: 'center', gap: 4 },
  tileTitle: { fontSize: 13, fontWeight: '600', maxWidth: 84, textAlign: 'center' },
  newCover: { width: 72, height: 72, borderRadius: radius.md, borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
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
  input: {
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
