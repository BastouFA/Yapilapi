import { useEventListener } from 'expo';
import { Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LiveChatMessage, LiveSummary } from '../../../../packages/api-client/src/index';
import { formatMoney } from '../../../../packages/shared/src/i18n';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { openOnWeb } from '../../lib/money';
import { useReport } from '../../lib/report';
import { useRealtime, useSession } from '../../lib/session';
import { ManagedOnWeb, useDigitalPurchases } from '../../lib/store';
import { radius, space } from '../../lib/theme';
import {
  type ActionSheetAction,
  Avatar,
  Button,
  EmptyState,
  Icon,
  KeyboardAvoid,
  Loading,
  Notice,
  Pill,
  ScreenError,
  Segmented,
  useActionSheet,
  useColors,
  userText,
} from '../../lib/ui';

type Tab = 'chat' | 'questions';
type Note = { tone: 'info' | 'danger' | 'warn'; text: string };

/**
 * Watching a live: the video (HLS, from the signed playback link the API gives each viewer), the
 * chat and questions for the host, updating live, and gifts. Ticketed lives only play for ticket
 * holders; tickets and gifts are paid for on the web (checkout isn't in the phone app), offered
 * only where the app store rules allow a link out (lib/store.tsx), and the screen checks again
 * when you come back. Going live needs streaming software on a computer.
 */
export default function LiveScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const commerceOn = useFlag('COMMERCE');
  // Tickets and gifts are digital goods: only offered where a link out is allowed (lib/store.tsx).
  const offer = useDigitalPurchases();
  const [live, setLive] = useState<LiveSummary | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone or private; a live already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chat, setChat] = useState<LiveChatMessage[]>([]);
  const [tab, setTab] = useState<Tab>('chat');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // The first playback link is kept while the live lasts, so reloading the page doesn't restart the video.
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const nearBottom = useRef(true);
  const joined = useRef(false);
  const menu = useActionSheet();
  const report = useReport();

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  const load = useCallback(async () => {
    try {
      const api = await client();
      let l = (await api.live.get(id)).live;
      const access = !l.ticket || l.ticket.hasTicket;
      // Joining puts you in the audience: that's who gets the chat as it happens.
      if (l.status === 'live' && access && l.myRole !== 'host') {
        try {
          l = (await api.live.join(id)).live;
          joined.current = true;
        } catch (e) {
          setNote({ tone: 'danger', text: errorMessage(e) });
        }
      }
      setLive(l);
      setLoadError(null);
      if (l.status === 'live' && l.playbackUrl) setPlayUrl((cur) => cur ?? mediaUrl(l.playbackUrl!));
      if (l.status !== 'live') setPlayUrl(null);
      if (access)
        api.live.chat(id).then(
          (r) => setChat(r.items),
          () => {},
        );
    } catch (e) {
      if (isGone(e)) setLive(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      if (!joined.current) return;
      void client()
        .then((api) => api.live.leave(id))
        .catch(() => {});
    };
  }, [id, load]);

  useRealtime((e) => {
    if (e.type === 'live.chat' && e.data?.liveId === id) {
      const msg = e.data.message as LiveChatMessage;
      setChat((cur) => (cur.some((m) => m.id === msg.id) ? cur : [...cur, msg]));
    }
    if (e.type === 'live.chat_deleted' && e.data?.liveId === id) setChat((cur) => cur.filter((m) => m.id !== e.data.messageId));
    if (e.type === 'live.viewers' && e.data?.id === id) setLive((l) => (l ? { ...l, viewers: e.data.viewers } : l));
    if (e.type === 'live.status' && e.data?.id === id) {
      if (e.data.status === 'removed') setNote({ tone: 'danger', text: t('m.live.removedYou') });
      setLive((l) => (l ? { ...l, status: 'ended', playbackUrl: null } : l));
      setPlayUrl(null);
    }
    // Back from paying on the web, or from the background: the ticket, the chat you missed, the viewer count.
    if (e.type === 'app.foreground') void load();
  });

  // New messages scroll into view, unless you've scrolled up to read.
  useEffect(() => {
    if (nearBottom.current) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: !reduceMotion }));
  }, [chat.length, reduceMotion]);

  if (live === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (live === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <Stack.Screen options={{ title: t('m.live.title') }} />
        <EmptyState title={t('m.live.missing')} />
      </View>
    );

  const l = live;
  const isHost = l.myRole === 'host';
  const canModerate = l.myRole === 'host' || l.myRole === 'cohost' || l.myRole === 'moderator';
  const needsTicket = !!l.ticket && !l.ticket.hasTicket;
  const canChat = l.status === 'live' && !!l.myRole && !needsTicket;
  const questions = chat.filter((m) => m.kind === 'question');
  const shown = tab === 'questions' ? questions : chat;

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setNote(null);
    try {
      const { message } = await (await client()).live.send(id, text, tab === 'questions' ? 'question' : 'chat');
      setBody('');
      nearBottom.current = true;
      setChat((cur) => (cur.some((m) => m.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setSending(false);
    }
  }

  function messageMenu(m: LiveChatMessage) {
    const mine = m.author.id === me?.id;
    const actions: ActionSheetAction[] = [];
    if (canModerate || mine)
      actions.push({
        label: t('m.live.removeMessage'),
        icon: 'trash-outline',
        destructive: true,
        onPress: async () => {
          try {
            await (await client()).raw.del(`/v1/live/${id}/chat/${m.id}`);
            setChat((cur) => cur.filter((x) => x.id !== m.id));
          } catch (e) {
            setNote({ tone: 'danger', text: errorMessage(e) });
          }
        },
      });
    if (canModerate && !mine && m.author.id !== l.host.id)
      actions.push({
        label: t('m.live.removePerson', { name: m.author.displayName }),
        icon: 'person-remove-outline',
        destructive: true,
        onPress: async () => {
          try {
            await (await client()).live.ban(id, m.author.id);
            setNote({ tone: 'info', text: t('m.live.removed') });
          } catch (e) {
            setNote({ tone: 'danger', text: errorMessage(e) });
          }
        },
      });
    // Live chat lines aren't reported one by one: report the person who wrote it.
    if (me && !mine)
      actions.push({
        label: t('m.profile.reportTitle', { name: m.author.displayName }),
        icon: 'flag-outline',
        destructive: true,
        onPress: () => report.open({ type: 'user', id: m.author.id, authorId: m.author.id, authorName: m.author.displayName }),
      });
    menu.show({ title: t('m.live.messageOptions'), actions });
  }

  function endLive() {
    Alert.alert(t('m.live.endTitle'), t('m.live.endBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.live.end'),
        style: 'destructive',
        onPress: async () => {
          try {
            setLive((await (await client()).live.end(id)).live);
            setPlayUrl(null);
          } catch (e) {
            setNote({ tone: 'danger', text: errorMessage(e) });
          }
        },
      },
    ]);
  }

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
  };

  const statusText = l.status === 'live' ? t('m.live.badge', { count: l.viewers }) : l.status === 'ended' ? t('m.live.ended') : t('m.live.scheduled');

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <Stack.Screen
        options={{
          title: l.title,
          // More: report the live (not your own).
          headerRight:
            me && !isHost
              ? () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('m.post.more')}
                    hitSlop={10}
                    onPress={() =>
                      menu.show({
                        title: l.title,
                        actions: [
                          {
                            label: t('post.report'),
                            icon: 'flag-outline',
                            destructive: true,
                            onPress: () => report.open({ type: 'live', id: l.id, authorId: l.host.id, authorName: l.host.displayName }),
                          },
                        ],
                      })
                    }
                  >
                    <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      <View style={{ aspectRatio: 16 / 9, width: '100%', backgroundColor: '#0B100E', alignItems: 'center', justifyContent: 'center' }}>
        {l.status === 'live' && playUrl ? (
          <LivePlayer url={playUrl} label={t('m.live.video', { title: l.title })} />
        ) : (
          <Text style={{ color: '#C7D2CD', textAlign: 'center', padding: space[4] }}>
            {l.status === 'ended' ? t('m.live.endedBody') : needsTicket ? t('m.live.ticketNeeded') : t('m.live.waiting')}
          </Text>
        )}
      </View>

      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[4] }}
        keyboardShouldPersistTaps="handled"
        // Scrolling tucks the keyboard away, so the whole conversation is readable again.
        keyboardDismissMode="on-drag"
        onScroll={onScroll}
        scrollEventThrottle={100}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <View style={{ gap: space[1] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 20, fontWeight: '800', flex: 1 }, userText]} numberOfLines={3}>
              {l.title}
            </Text>
            <View accessible accessibilityLiveRegion="polite" accessibilityLabel={statusText}>
              <Pill text={statusText} tone={l.status === 'live' ? 'live' : 'neutral'} />
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Avatar name={l.host.displayName} url={l.host.avatarUrl} size={24} />
            <Text style={[{ color: c.inkMuted }, userText]}>{t('m.live.hostedBy', { name: l.host.displayName })}</Text>
          </View>
        </View>

        {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}

        {needsTicket && l.ticket && offer !== 'link' ? (
          <Notice tone="warn" title={t('m.live.ticketNeeded')}>
            <ManagedOnWeb text={t('m.store.live')} />
          </Notice>
        ) : needsTicket && l.ticket ? (
          <Notice tone="warn" title={`${l.ticket.title}: ${formatMoney(l.ticket.priceCents, l.ticket.currency, locale)}`}>
            <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.live.ticketBody')}</Text>
            <Button
              label={t('m.live.buyOnWeb')}
              icon="open-outline"
              size="sm"
              onPress={() => openOnWeb(`/live/${encodeURIComponent(id)}`)}
              style={{ alignSelf: 'flex-start', marginTop: space[1] }}
            />
            <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.shop.onWeb')}</Text>
          </Notice>
        ) : null}

        {isHost ? (
          <Notice title={t('m.live.youHost')}>
            <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.live.fromComputer')}</Text>
            {l.status === 'live' ? (
              <Button label={t('m.live.end')} variant="danger" size="sm" onPress={endLive} style={{ alignSelf: 'flex-start', marginTop: space[1] }} />
            ) : null}
          </Notice>
        ) : null}

        {l.status === 'live' && !isHost && commerceOn !== false && offer === 'link' ? (
          <View style={{ gap: space[1] }}>
            <Button label={t('m.live.giftOnWeb')} icon="gift-outline" variant="secondary" onPress={() => openOnWeb(`/live/${encodeURIComponent(id)}`)} />
            <Text style={{ color: c.inkMuted, fontSize: 12, textAlign: 'center' }}>{t('m.live.giftHint')}</Text>
          </View>
        ) : null}

        {needsTicket ? null : (
          <>
            <Segmented<Tab>
              label={t('m.live.chatLabel')}
              value={tab}
              onChange={setTab}
              options={[
                { id: 'chat', label: t('m.live.chat') },
                { id: 'questions', label: t('m.live.questions'), count: questions.length },
              ]}
            />
            <View accessibilityLabel={tab === 'questions' ? t('m.live.questions') : t('m.live.chat')} style={{ gap: space[2] }}>
              {shown.length ? (
                shown.map((m) => <ChatLine key={m.id} m={m} mine={m.author.id === me?.id} onMore={me ? () => messageMenu(m) : undefined} />)
              ) : (
                <Text style={{ color: c.inkMuted, textAlign: 'center', paddingVertical: space[4] }}>
                  {l.status === 'scheduled' ? t('m.live.chatClosed') : tab === 'questions' ? t('m.live.noQuestions') : t('m.live.chatEmpty')}
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>

      {canChat ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: space[2],
            paddingHorizontal: space[4],
            paddingTop: space[2],
            paddingBottom: Math.max(insets.bottom, space[2]),
            borderTopWidth: 1,
            borderTopColor: c.line,
            backgroundColor: c.ground,
          }}
        >
          <TextInput
            accessibilityLabel={tab === 'questions' ? t('m.live.ask') : t('m.live.message')}
            placeholder={tab === 'questions' ? t('m.live.ask') : t('m.live.say')}
            placeholderTextColor={c.inkMuted}
            value={body}
            onChangeText={setBody}
            maxLength={500}
            multiline
            style={[
              {
                flex: 1,
                minHeight: 44,
                maxHeight: 120,
                borderWidth: 1,
                borderColor: c.line,
                borderRadius: radius.lg,
                paddingHorizontal: space[3],
                paddingTop: 11,
                paddingBottom: 11,
                color: c.ink,
                backgroundColor: c.surface,
                fontSize: 15,
              },
              userText,
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.live.send')}
            accessibilityState={{ disabled: !body.trim() || sending, busy: sending }}
            disabled={!body.trim() || sending}
            onPress={() => void send()}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: c.yapi,
              opacity: !body.trim() || sending ? 0.45 : pressed ? 0.85 : 1,
            })}
          >
            {sending ? <ActivityIndicator color={c.onYapi} /> : <Icon name="send" size={18} color={c.onYapi} directional />}
          </Pressable>
        </View>
      ) : null}
      {canChat ? null : <View style={{ height: insets.bottom }} />}
      {menu.sheet}
      {report.sheet}
    </KeyboardAvoid>
  );
}

/** The live video. It plays as soon as it can; if the stream can't be reached, it says so with a way to try again. */
function LivePlayer({ url, label }: { url: string; label: string }) {
  const { t } = useT();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const player = useVideoPlayer({ uri: url, contentType: 'hls' }, (p) => {
    p.play();
  });
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') setFailed(true);
    if (status === 'readyToPlay') setFailed(false);
  });
  useEffect(() => {
    if (!attempt) return;
    player.replace({ uri: url, contentType: 'hls' });
    player.play();
  }, [attempt, player, url]);
  // A profile or anything else opened from the live covers it: the stream waits, and picks up again when you're back.
  const focused = useIsFocused();
  const wasFocused = useRef(focused);
  useEffect(() => {
    if (wasFocused.current === focused) return;
    wasFocused.current = focused;
    try {
      if (focused) player.play();
      else player.pause();
    } catch {
      // Already released.
    }
  }, [focused, player]);
  if (failed)
    return (
      <View style={{ alignItems: 'center', gap: space[2], padding: space[4] }}>
        <Text style={{ color: '#C7D2CD', textAlign: 'center' }}>{t('m.live.cantPlay')}</Text>
        <Button
          label={t('m.live.retry')}
          size="sm"
          variant="secondary"
          onPress={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        />
      </View>
    );
  return (
    <View accessible accessibilityLabel={label} style={{ width: '100%', height: '100%' }}>
      <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls allowsPictureInPicture />
    </View>
  );
}

function ChatLine({ m, mine, onMore }: { m: LiveChatMessage; mine: boolean; onMore?: () => void }) {
  const c = useColors();
  const { t, locale } = useT();
  if (m.kind === 'gift') {
    const amount = formatMoney(m.amountCents ?? 0, m.currency ?? 'USD', locale);
    return (
      <View
        accessible
        accessibilityLabel={`${t('m.live.gift', { name: m.author.displayName, amount })}${m.body ? `. ${m.body}` : ''}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], backgroundColor: c.saffronSoft, borderRadius: radius.md, padding: space[3] }}
      >
        <Icon name="gift" size={20} color={c.ink} />
        <View style={{ flex: 1 }}>
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{t('m.live.gift', { name: m.author.displayName, amount })}</Text>
          {m.body ? <Text style={[{ color: c.ink }, userText]}>{m.body}</Text> : null}
        </View>
      </View>
    );
  }
  const question = m.kind === 'question';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space[2] }}>
      <Avatar name={m.author.displayName} url={m.author.avatarUrl} size={28} />
      <View
        accessible
        accessibilityLabel={[m.author.displayName, question ? t('m.live.question') : null, m.body, m.answered ? t('m.live.answered') : null]
          .filter(Boolean)
          .join(', ')}
        style={{
          flex: 1,
          gap: 2,
          backgroundColor: mine ? c.yapiSoft : c.surface,
          borderRadius: radius.md,
          paddingHorizontal: space[3],
          paddingVertical: space[2],
          borderWidth: question ? 1 : 0,
          borderColor: c.yapi,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' }}>
          <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 13 }, userText]} numberOfLines={1}>
            {m.author.displayName}
          </Text>
          {question ? <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 12 }}>{t('m.live.question')}</Text> : null}
          {m.answered ? <Text style={{ color: c.success, fontWeight: '700', fontSize: 12 }}>{t('m.live.answered')}</Text> : null}
        </View>
        <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{m.body}</Text>
      </View>
      {onMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.live.messageOptionsFor', { name: m.author.displayName })}
          onPress={onMore}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="ellipsis-horizontal" size={18} color={c.inkMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}
