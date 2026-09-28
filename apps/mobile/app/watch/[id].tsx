import { VideoView } from 'expo-video';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  Image,
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
import type { Message, Post, PublicUser } from '../../../../packages/shared/src/types';
import { WATCH_REACTIONS, type WatchQueueItem, type WatchSkipReason } from '../../../../packages/shared/src/watch';
import { client, errorMessage } from '../../lib/api';
import { previewOf, previewText, SystemLine } from '../../lib/chat-extras';
import { useDataSaver } from '../../lib/data-saver';
import { useT } from '../../lib/i18n';
import { useReducedMotion } from '../../lib/motion';
import { REACTION_ICON, REACTION_LABEL } from '../../lib/rooms';
import { useRealtime, useSession } from '../../lib/session';
import { elevation, radius, space } from '../../lib/theme';
import {
  Avatar,
  Button,
  EmptyState,
  Field,
  Icon,
  type IconName,
  KeyboardAvoid,
  Loading,
  Notice,
  Pill,
  Segmented,
  useActionSheet,
  useColors,
  userText,
} from '../../lib/ui';
import { canWatch, FloatingReaction, postIdFromLink, postThumb, useWatchSync, videoOf } from '../../lib/watch';

const WHITE = '#FFFFFF';
const SCRIM = 'rgba(5,6,11,0.55)';

/** "1:05" for 65 000 ms. */
const clockOf = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Tab = 'chat' | 'queue' | 'people';

/**
 * Watch together: the video everyone in the chat is watching, in sync, with reactions floating
 * over it; below it the chat (messages go to the conversation), the queue ("Up next", add by
 * pasting a link) and who's watching. Opening the screen joins; leaving it leaves.
 */
export default function WatchScreen() {
  const { id, skipped } = useLocalSearchParams<{ id: string; skipped?: string }>();
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const navigation = useNavigation();
  const saver = useDataSaver().active;
  const reduce = useReducedMotion();
  const { width, height: windowHeight } = useWindowDimensions();
  const w = useWatchSync(id, { saver });
  const [tab, setTab] = useState<Tab>('chat');
  const menu = useActionSheet();
  const s = w.session;

  // Notes from starting it (videos that didn't go in the queue), once.
  const shownSkipped = useRef(false);
  const { flashSkipped } = w;
  useEffect(() => {
    if (!skipped || shownSkipped.current) return;
    shownSkipped.current = true;
    flashSkipped(skipped.split(',').filter(Boolean) as WatchSkipReason[]);
  }, [skipped, flashSkipped]);

  // iOS has no live regions: say it when the video jumps to catch up, and read the notes out
  // (who hosts now, what went in the queue). Android reads the live regions below.
  const { syncing, notice } = w;
  useEffect(() => {
    if (syncing && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(t('watch.syncing'));
  }, [syncing, t]);
  useEffect(() => {
    if (notice && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(notice);
  }, [notice]);

  /** Back to the chat: to the chat screen already open underneath, or it takes this screen's place. Either way this one closes (and leaves). */
  const backToChat = () => {
    if (!s) return router.canGoBack() ? router.back() : router.replace('/');
    router.dismissTo({ pathname: '/chat/[id]', params: { id: s.conversationId } });
  };
  const backRef = useRef(backToChat);
  backRef.current = backToChat;

  const { show: showMenu } = menu;
  const { leave, end, host } = w;
  const ended = w.ended;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: s?.conversationTitle ?? t('watch.title'),
      headerRight:
        s && !ended
          ? () => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.post.more')}
                hitSlop={10}
                onPress={() =>
                  showMenu({
                    title: t('watch.title'),
                    actions: [
                      { label: t('watch.back'), icon: 'chatbubbles-outline', onPress: () => backRef.current() },
                      {
                        label: t('watch.leave'),
                        icon: 'exit-outline',
                        onPress: () =>
                          void leave().then(() => {
                            backRef.current();
                          }),
                      },
                      ...(host
                        ? [
                            {
                              label: t('watch.end'),
                              icon: 'stop-circle-outline' as IconName,
                              destructive: true,
                              onPress: () =>
                                Alert.alert(t('watch.endConfirm'), undefined, [
                                  { text: t('common.cancel'), style: 'cancel' },
                                  { text: t('watch.end'), style: 'destructive', onPress: () => void end() },
                                ]),
                            },
                          ]
                        : []),
                    ],
                  })
                }
              >
                <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
              </Pressable>
            )
          : undefined,
    });
  }, [navigation, s, ended, host, leave, end, showMenu, t, c.yapi]);

  if (w.ended)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState
          icon="tv-outline"
          title={t('watch.ended')}
          action={s ? { label: t('watch.back'), icon: 'chatbubbles-outline', onPress: backToChat } : undefined}
        />
      </View>
    );
  if (w.error && !s)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState
          icon="tv-outline"
          title={t('watch.title')}
          body={t('watch.loadFailed')}
          action={{ label: t('m.common.retry'), onPress: () => void w.retry() }}
        />
      </View>
    );
  if (!s || !me) return <Loading />;

  const item = w.current;
  const media = item ? videoOf(item.post) : undefined;
  const ratio = media?.width && media.height ? media.width / media.height : 9 / 16;
  const videoHeight = Math.round(Math.min(width / ratio, windowHeight * 0.36));
  const up = s.queue.filter((q) => q.status === 'queued');
  const pb = w.playback;
  const sharedPlaying = !!pb?.playing;
  const duration = w.time.durationMs;

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      {/* The video, with reactions floating over it. */}
      <View style={{ width: '100%', height: videoHeight, backgroundColor: '#000' }}>
        {item ? (
          <VideoView
            player={w.player}
            style={{ flex: 1 }}
            contentFit="contain"
            nativeControls={false}
            accessibilityLabel={item.post.body ? `${item.post.author.displayName}: ${item.post.body}` : item.post.author.displayName}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[4], gap: space[3] }}>
            <Text style={{ color: WHITE, fontSize: 15, textAlign: 'center', lineHeight: 21 }}>{t('watch.queueEmpty')}</Text>
            <Button label={t('watch.add')} size="sm" variant="secondary" icon="add" onPress={() => setTab('queue')} />
          </View>
        )}
        {item && w.needsTap ? (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: space[4], gap: space[2], backgroundColor: SCRIM }]}>
            <Button label={t('watch.playToJoin')} icon="play" onPress={w.joinPlayback} />
            <Text style={{ color: WHITE, fontSize: 13, textAlign: 'center', lineHeight: 18 }}>{t('watch.dataSaverNote')}</Text>
          </View>
        ) : null}
        {/* Always there (empty when in sync), so Android reads the pill as it appears. */}
        <View accessibilityLiveRegion="polite" pointerEvents="none" style={{ position: 'absolute', top: space[2], start: space[2] }}>
          {w.syncing ? (
            <View style={{ backgroundColor: SCRIM, borderRadius: radius.full, paddingHorizontal: space[3], paddingVertical: 4 }}>
              <Text style={{ color: WHITE, fontSize: 12, fontWeight: '600' }}>{t('watch.syncing')}</Text>
            </View>
          ) : null}
        </View>
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
          {w.reactions.map((r) => (
            <FloatingReaction key={r.id} kind={r.kind} x={r.x} reduce={reduce} />
          ))}
        </View>
      </View>

      {/* Play, pause, 10 seconds back and forward, next; then the reactions. */}
      <View style={{ paddingHorizontal: space[3], paddingTop: space[2], gap: space[2] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
          <ControlButton icon="play-back" label={t('watch.back10')} disabled={!item} onPress={() => void w.seekBy(-10_000)} />
          <ControlButton
            icon={sharedPlaying ? 'pause' : 'play'}
            label={sharedPlaying ? t('watch.pause') : t('watch.play')}
            disabled={!item}
            big
            onPress={() => void (sharedPlaying ? w.pause() : w.play())}
          />
          <ControlButton icon="play-forward" label={t('watch.forward10')} disabled={!item} onPress={() => void w.seekBy(10_000)} />
          <ControlButton icon="play-skip-forward" label={t('watch.next')} disabled={!item && !up.length} onPress={() => void w.next()} />
          <View style={{ flex: 1 }} />
          {item && duration ? (
            <Text
              accessibilityLabel={t('watch.progress', { position: clockOf(w.time.positionMs), duration: clockOf(duration) })}
              style={{ color: c.inkMuted, fontSize: 13, fontVariant: ['tabular-nums'] }}
            >
              {`${clockOf(w.time.positionMs)} / ${clockOf(duration)}`}
            </Text>
          ) : null}
        </View>
        <View accessibilityRole="toolbar" accessibilityLabel={t('watch.react')} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {WATCH_REACTIONS.map((k) => (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={t(REACTION_LABEL[k])}
              onPress={() => void w.react(k)}
              style={({ pressed }) => ({
                width: 48,
                height: 44,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? c.surfaceSunken : 'transparent',
              })}
            >
              <Icon name={REACTION_ICON[k]} size={24} color={c.inkMuted} />
            </Pressable>
          ))}
        </View>
        {item ? (
          <Text numberOfLines={1} style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
            {`${t('watch.nowPlaying')} · ${item.post.author.displayName}${item.post.body ? ` · ${item.post.body}` : ''}`}
          </Text>
        ) : null}
        {w.notice ? (
          <View accessibilityLiveRegion="polite">
            <Notice>{w.notice}</Notice>
          </View>
        ) : null}
        <Segmented
          label={t('watch.title')}
          value={tab}
          onChange={setTab}
          options={[
            { id: 'chat', label: t('watch.chat') },
            { id: 'queue', label: t('watch.queue'), count: up.length || undefined },
            { id: 'people', label: t('watch.people'), count: s.watching.length },
          ]}
        />
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'chat' ? (
          <SideChat conversationId={s.conversationId} meId={me.id} />
        ) : tab === 'queue' ? (
          <Queue
            items={s.queue}
            playingId={pb?.itemId ?? null}
            meId={me.id}
            host={w.host}
            onJump={(itemId) => void w.jump(itemId)}
            onRemove={(itemId) => void w.remove(itemId)}
            onAdd={w.add}
          />
        ) : (
          <People watching={s.watching} members={s.members} hostId={s.hostId} meId={me.id} />
        )}
      </View>
      {menu.sheet}
    </KeyboardAvoid>
  );
}

function ControlButton({ icon, label, onPress, disabled, big }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; big?: boolean }) {
  const c = useColors();
  const size = big ? 52 : 44;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: big ? c.yapi : pressed ? c.surfaceSunken : 'transparent',
        opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={big ? 26 : 22} color={big ? c.onYapi : c.ink} />
    </Pressable>
  );
}

/** The chat beside the video: the conversation's newest messages, live, and a box to write in. */
function SideChat({ conversationId, meId }: { conversationId: string; meId: string }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const list = useRef<FlatList<Message>>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const api = await client();
        const page = await api.conversations.messages(conversationId);
        if (!live) return;
        setMessages(page.items);
        void api.conversations.read(conversationId).catch(() => {});
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [conversationId]);

  useRealtime((e) => {
    if (e.type !== 'message.created' || e.data?.conversationId !== conversationId) return;
    const m = e.data as Message;
    setMessages((cur) => (cur.some((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId)) ? cur : [...cur, m]));
    void client().then((api) => api.conversations.read(conversationId).catch(() => {}));
  });

  async function send() {
    const text = body.trim();
    if (!text || sending.current) return;
    sending.current = true;
    setBody('');
    setError(null);
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { message } = await (await client()).conversations.send(conversationId, text, clientId);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      setBody(text);
      setError(errorMessage(e));
    } finally {
      sending.current = false;
    }
  }

  return (
    <View style={{ flex: 1 }}>
      {error ? (
        <View style={{ paddingHorizontal: space[3], paddingTop: space[2] }}>
          <Notice tone="danger">{error}</Notice>
        </View>
      ) : null}
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: space[3], gap: space[2] }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item: m }) => {
          if (m.kind === 'system') return <SystemLine message={m} meId={meId} />;
          const mine = m.sender.id === meId;
          const text = m.unsent ? t('m.chat.unsent') : previewText(t, previewOf(m), { meId });
          return (
            // One stop per message for screen readers: who wrote it, then what they wrote.
            <View accessible style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', gap: 2 }}>
              {!mine ? <Text style={[{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }, userText]}>{m.sender.displayName}</Text> : null}
              <View style={{ backgroundColor: mine ? c.yapi : c.surface, borderRadius: radius.lg, paddingHorizontal: space[3], paddingVertical: space[2] }}>
                <Text style={[{ color: mine ? c.onYapi : c.ink, fontSize: 15, lineHeight: 20, fontStyle: m.unsent ? 'italic' : 'normal' }, userText]}>
                  {text}
                </Text>
              </View>
            </View>
          );
        }}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: space[2],
          paddingHorizontal: space[3],
          paddingTop: space[2],
          paddingBottom: Math.max(insets.bottom, space[3]),
        }}
      >
        <TextInput
          accessibilityLabel={t('watch.chatPlaceholder')}
          accessibilityHint={t('watch.chatNote')}
          placeholder={t('watch.chatPlaceholder')}
          placeholderTextColor={c.inkMuted}
          value={body}
          onChangeText={setBody}
          maxLength={4000}
          multiline
          style={[
            { flex: 1, minHeight: 44, maxHeight: 100, borderRadius: radius.lg, paddingHorizontal: space[4], paddingTop: 12, paddingBottom: 12, fontSize: 15 },
            { color: c.ink, backgroundColor: c.surface },
            userText,
            elevation(c),
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('watch.send')}
          accessibilityState={{ disabled: !body.trim() }}
          disabled={!body.trim()}
          onPress={() => void send()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.yapi,
            opacity: body.trim() ? 1 : 0.45,
          }}
        >
          <Icon name="arrow-up" size={22} color={c.onYapi} />
        </Pressable>
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 11, textAlign: 'center', marginTop: -space[2], paddingBottom: space[1] }}>{t('watch.chatNote')}</Text>
    </View>
  );
}

/** "Up next": the item on screen, the ones to come, and a field to add a reel or video post by its link. */
function Queue({
  items,
  playingId,
  meId,
  host,
  onJump,
  onRemove,
  onAdd,
}: {
  items: WatchQueueItem[];
  playingId: string | null;
  meId: string;
  host: boolean;
  onJump: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onAdd: (postIds: string[]) => Promise<boolean>;
}) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [link, setLink] = useState('');
  const [bad, setBad] = useState(false);

  async function add() {
    const postId = postIdFromLink(link);
    if (!postId) return setBad(true);
    setBad(false);
    if (await onAdd([postId])) setLink('');
  }

  // Something to pick without leaving: reels, or the videos you saved.
  const [source, setSource] = useState<'reels' | 'saved'>('reels');
  const [picks, setPicks] = useState<Post[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPicks(null);
    void (async () => {
      try {
        const api = await client();
        const page = source === 'reels' ? await api.reels() : await api.me.saved('videos');
        if (live) setPicks(page.items.filter(canWatch));
      } catch {
        if (live) setPicks([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [source]);
  const queued = new Set(items.map((q) => q.post.id));

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: space[3], gap: space[3], paddingBottom: Math.max(insets.bottom, space[4]) }}
    >
      <View style={{ gap: space[2] }}>
        <Segmented
          label={t('watch.pickFrom')}
          value={source}
          onChange={setSource}
          options={[
            { id: 'reels', label: t('watch.pickReels') },
            { id: 'saved', label: t('watch.pickSaved') },
          ]}
        />
        {picks === null ? (
          <Loading />
        ) : picks.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
            {picks.map((p) => {
              const thumb = postThumb(p);
              const inQueue = queued.has(p.id);
              const label = p.body.trim() || t('watch.pickUntitled', { name: p.author.displayName });
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityLabel={inQueue ? t('watch.pickQueued', { title: label }) : t('watch.pickAdd', { title: label })}
                  accessibilityState={{ disabled: inQueue || adding === p.id }}
                  disabled={inQueue || adding === p.id}
                  onPress={async () => {
                    setAdding(p.id);
                    await onAdd([p.id]);
                    setAdding(null);
                  }}
                  style={{ width: 96, gap: 4, opacity: inQueue ? 0.55 : 1 }}
                >
                  <View style={{ width: 96, height: 150, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000' }}>
                    {thumb ? <Image source={{ uri: thumb }} style={{ width: '100%', height: '100%' }} /> : null}
                    <View
                      style={{
                        position: 'absolute',
                        right: 6,
                        bottom: 6,
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(0,0,0,0.6)',
                      }}
                    >
                      <Icon name={inQueue ? 'checkmark' : 'add'} size={18} color="#fff" />
                    </View>
                  </View>
                  <Text numberOfLines={2} style={[{ color: c.ink, fontSize: 12, lineHeight: 16 }, userText]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{source === 'reels' ? t('watch.pickNoReels') : t('watch.pickNoSaved')}</Text>
        )}
      </View>
      <View style={{ gap: space[2] }}>
        <Field
          label={t('watch.add')}
          placeholder={t('watch.addPlaceholder')}
          value={link}
          onChangeText={(v) => {
            setLink(v);
            setBad(false);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void add()}
          error={bad ? t('watch.badLink') : null}
        />
        <Button
          label={t('watch.addButton')}
          icon="add"
          size="sm"
          variant="secondary"
          disabled={!link.trim()}
          onPress={add}
          style={{ alignSelf: 'flex-start' }}
        />
      </View>
      {!items.length ? <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('watch.queueEmpty')}</Text> : null}
      {items.map((q) => {
        const thumb = postThumb(q.post);
        const on = q.id === playingId;
        const canRemove = !on && (host || q.addedBy?.id === meId);
        const caption = q.post.body.trim();
        return (
          <View
            key={q.id}
            style={[
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[3],
                padding: space[2],
                borderRadius: radius.md,
                backgroundColor: on ? c.yapiSoft : c.surface,
              },
              elevation(c),
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={caption ? `${q.post.author.displayName}: ${caption}` : q.post.author.displayName}
              accessibilityHint={on ? undefined : t('watch.playNow')}
              accessibilityState={{ selected: on, disabled: on }}
              disabled={on}
              onPress={() => onJump(q.id)}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
            >
              <View
                style={{
                  width: 48,
                  height: 64,
                  borderRadius: radius.sm,
                  overflow: 'hidden',
                  backgroundColor: c.surfaceSunken,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {thumb ? <Image source={{ uri: thumb }} style={{ width: 48, height: 64 }} resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
                {!thumb ? <Icon name="film-outline" size={20} color={c.inkMuted} /> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                {on ? <Text style={{ color: c.yapi, fontSize: 12, fontWeight: '700' }}>{t('watch.nowPlaying')}</Text> : null}
                <Text numberOfLines={1} style={[{ color: c.ink, fontWeight: '700', fontSize: 14 }, userText]}>
                  {q.post.author.displayName}
                </Text>
                {caption ? (
                  <Text numberOfLines={2} style={[{ color: c.ink, fontSize: 13, lineHeight: 18 }, userText]}>
                    {caption}
                  </Text>
                ) : null}
                {q.addedBy ? <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]}>{t('watch.addedBy', { name: q.addedBy.displayName })}</Text> : null}
              </View>
            </Pressable>
            {canRemove ? (
              <Pressable
                accessibilityRole="button"
                // Several of these in a list: say which video each one takes out.
                accessibilityLabel={`${t('watch.remove')}: ${caption || q.post.author.displayName}`}
                hitSlop={6}
                onPress={() => onRemove(q.id)}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="close-circle-outline" size={22} color={c.inkMuted} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

/** Who's watching (the host marked), then the rest of the chat. */
function People({ watching, members, hostId, meId }: { watching: PublicUser[]; members: PublicUser[]; hostId: string | null; meId: string }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const ids = new Set(watching.map((u) => u.id));
  const others = members.filter((u) => !ids.has(u.id));
  const row = (u: PublicUser) => (
    <Pressable
      key={u.id}
      accessibilityRole="link"
      accessibilityLabel={u.id === hostId ? `${u.displayName}, ${t('watch.host')}` : u.displayName}
      onPress={() => router.push(`/u/${u.username}`)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48 }}
    >
      <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
      <Text numberOfLines={1} style={[{ color: c.ink, fontWeight: '600', fontSize: 15, flexShrink: 1 }, userText]}>
        {u.displayName}
      </Text>
      {u.id === hostId ? <Pill text={u.id === meId ? t('watch.youHost') : t('watch.host')} /> : null}
    </Pressable>
  );
  return (
    <ScrollView contentContainerStyle={{ padding: space[3], gap: space[1], paddingBottom: Math.max(insets.bottom, space[4]) }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 15, marginBottom: space[1] }}>
        {t('watch.people')}
      </Text>
      {watching.map(row)}
      {others.length ? (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 15, marginTop: space[3], marginBottom: space[1] }}>
            {t('watch.notWatching')}
          </Text>
          {others.map(row)}
        </>
      ) : null}
    </ScrollView>
  );
}
