import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
} from 'expo-audio';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, FlatList, Image, Linking, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatGame, Conversation, Message, PinnedMessage } from '../../../../packages/shared/src/types';
import { MESSAGE_EDIT_MINUTES } from '../../../../packages/shared/src/constants';
import { useCalls } from '../../lib/calls';
import { client, errorMessage, mediaUrl } from '../../lib/api';
import { clock, MAX_UPLOAD_BYTES, pickOne, uploadFile, uploadPicked, VOICE_MIME } from '../../lib/media';
import { useT } from '../../lib/i18n';
import { StoryCardView } from '../../lib/story-stickers';
import { liveStatus, NowStatusLine } from '../../lib/now-status';
import { conversationTitle } from '../../lib/post';
import { isVerificationError, SensitiveCover, UnavailableMedia, VerifyPrompt } from '../../lib/safety';
import { useRealtime, useSession } from '../../lib/session';
import { elevation, gradient, radius, space } from '../../lib/theme';
import {
  ActionSheet,
  BottomSheet,
  EmptyState,
  ErrorState,
  Icon,
  KeyboardAvoid,
  Notice,
  slop,
  SwitchRow,
  useColors,
  useKeyboardVisible,
  userText,
} from '../../lib/ui';
import { onBackOnline } from '../../lib/network';
import { formatList } from '../../../../packages/shared/src/feed-reasons';
import { ViewOnceBubble } from '../../lib/view-once';
import { useMicInUse, Waveform, YAP_MAX_MS, YAP_MIN_MS } from '../../lib/yaps';
import { SmartRepliesSwitch, SmartReplyChips } from '../../lib/ai-helpers';
import {
  applyReaction,
  disappearingText,
  DisappearingSheet,
  MessageActions,
  PinnedBar,
  previewOf,
  previewText,
  Quote,
  ReactionRow,
  SearchSheet,
  SwipeToReply,
  SystemLine,
  type SheetAction,
} from '../../lib/chat-extras';
import { TranslatableText } from '../../lib/translation';
import { useReport } from '../../lib/report';
import { ListCard, ListComposer, PollCard, PollComposer, ReminderNote, ReminderPicker } from '../../lib/chat-polls';
import { GameCard, GameSheet, StartGameSheet } from '../../lib/chat-games';
import { MiniAppsSheet, useMiniAppsOn } from '../../lib/miniapps';
import { ChatMixCard, ShareMixHereSheet } from '../../lib/mixes';
import { LocationCard, LocationRequestLine, ShareLocationSheet, SharingBanner, useLocationSharing } from '../../lib/chat-location';
import { ListingChatCard, OfferChatCard } from '../../lib/chat-market';
import type { LatLng } from '../../../../packages/shared/src/location';
import { accentFor, ChatLookSheet, ChatWallpaperView, laterLimits, ScheduledList, useScheduled } from '../../lib/chat-later';
import { DateTimeSheet } from '../../lib/date-time';
import { useFlag } from '../../lib/flags';
import { chatTheme, type AccentColors } from '../../../../packages/shared/src/chat-theme';
import { chatTooBig, openWatch, startWatch, useChatWatch, WatchBanner, watchableChat } from '../../lib/watch';
import { noticeText } from '../../../../packages/shared/src/server-text';
import { storyReplyLabel } from '../../../../packages/shared/src/message-preview';

/** Voice messages shorter than this are treated as a slip of the finger and not sent. */
const MIN_VOICE_MS = 1000;
/** Voice messages stop recording at 5 minutes. */
const MAX_VOICE_MS = 5 * 60 * 1000;
/** An icon button in the header: 36 wide (44 to tap with the slop at its sides) and the header's 44 tall. */
const headerIcon = { minWidth: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' } as const;
const HEADER_SLOP = { left: 4, right: 4 };

/**
 * A conversation, updated live over the realtime socket, with audio and video call buttons.
 * With nothing typed, the send button records a voice message instead.
 */
export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, locale } = useT();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { me, sendRealtime } = useSession();
  const calls = useCalls();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  // While you type, the voice bar and suggested replies step aside so more of the chat shows.
  const typing = useKeyboardVisible();
  // Someone else typing here (their name), cleared a few seconds after the last word from them or when their message arrives.
  const [someoneTyping, setSomeoneTyping] = useState<{ userId: string; name: string } | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typingTimer.current), []);
  // When you last told the others you were typing: at most every few seconds.
  const typingSent = useRef(0);
  const onType = (text: string) => {
    setBody(text);
    if (!text.trim() || editing || Date.now() - typingSent.current < 3000) return;
    typingSent.current = Date.now();
    sendRealtime({ type: 'typing', conversationId: id });
  };
  const [error, setError] = useState<string | null>(null);
  // A sent message held for a quick check before it's delivered.
  const [held, setHeld] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  // Whether the newest messages are on screen (then growth at the bottom keeps them in view).
  const atBottom = useRef(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const report = useReport();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [disappearingOpen, setDisappearingOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  // Mini Apps added to this chat (the options menu's Apps).
  const miniAppsOn = useMiniAppsOn();
  const [appsOpen, setAppsOpen] = useState(false);
  // Games: the sheet to start one, and the board that's open (by its card's message id, so live updates show in it).
  const [gameStartOpen, setGameStartOpen] = useState(false);
  const [boardFor, setBoardFor] = useState<string | null>(null);
  // A game opened from the start sheet whose card isn't among the messages loaded yet (an older one).
  const [looseGame, setLooseGame] = useState<ChatGame | null>(null);
  // Mixes: the sheet to share one of yours here.
  const [mixShareOpen, setMixShareOpen] = useState(false);
  // Sharing where you are: the sheet, and your live share here (started on the web) with its banner.
  const [locationOpen, setLocationOpen] = useState(false);
  const sharing = useLocationSharing(id, me?.id);
  const [remindFor, setRemindFor] = useState<{ message: Message; scope: 'me' | 'group' } | null>(null);
  // Send later (touch and hold Send), your messages waiting here, and the chat's wallpaper and colour.
  const scheduled = useScheduled(id);
  const [laterOpen, setLaterOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const theme = chatTheme(conversation?.theme);
  const accent = useMemo(() => accentFor({ wallpaper: 'plain', accent: theme.accent }, c), [theme.accent, c]);
  const input = useRef<TextInput>(null);
  // Watch together: the session running here (a banner and a Join on its line), or a way to start one.
  const { summary: watching } = useChatWatch(id);
  const canWatch = !!conversation && watchableChat(conversation) && !chatTooBig(conversation) && conversation.members.length > 1;
  // A shared album for the people in this chat (a card goes in the chat).
  const togetherOn = useFlag('REAL_TOGETHER') === true;
  const canAlbum = togetherOn && !!conversation && (conversation.kind === 'direct' || conversation.kind === 'group');
  const patchMessage = (messageId: string, fn: (m: Message) => Message) => setMessages((cur) => cur.map((x) => (x.id === messageId ? fn(x) : x)));
  const loadPins = useCallback(async () => {
    try {
      setPins((await (await client()).conversations.pins(id)).items);
    } catch {
      // Pins are extra: the chat works without them.
    }
  }, [id]);
  const fail = (e: unknown) => {
    if (isVerificationError(e)) setNeedsVerify(true);
    else setError(errorMessage(e));
  };

  const load = useCallback(async () => {
    try {
      const api = await client();
      const [conv, page] = await Promise.all([api.conversations.get(id), api.conversations.messages(id)]);
      setConversation(conv.conversation);
      setMessages(page.items); // oldest first, the latest page
      setCursor(page.nextCursor);
      // Photos, voice notes and polls size themselves after the first layout: open at the newest
      // message once they have, not just at the first pass.
      atBottom.current = true;
      for (const ms of [150, 500, 1200]) setTimeout(() => atBottom.current && list.current?.scrollToEnd({ animated: false }), ms);
      void api.conversations.read(id).catch(() => {});
      void loadPins();
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, loadPins]);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from a dropped connection (the phone's, or the live one to the server): fetch what came in
  // meanwhile. Messages already here stay, so history scrolled back to isn't lost.
  const loaded = !!conversation;
  const catchUp = useCallback(async () => {
    if (!loaded) return void load();
    try {
      const page = await (await client()).conversations.messages(id);
      setMessages((cur) => {
        const fresh = new Map(page.items.map((m) => [m.id, m]));
        const ids = new Set(cur.map((m) => m.id));
        const clientIds = new Set(cur.map((m) => m.clientId).filter(Boolean));
        return [...cur.map((m) => fresh.get(m.id) ?? m), ...page.items.filter((m) => !ids.has(m.id) && !(m.clientId && clientIds.has(m.clientId)))];
      });
      void client().then((api) => api.conversations.read(id).catch(() => {}));
    } catch {
      // Still offline: the next reconnect tries again.
    }
  }, [id, loaded, load]);
  useEffect(() => onBackOnline(() => void catchUp()), [catchUp]);

  useRealtime((e) => {
    // A new live connection (the server says `ready` on each): anything sent while it was down.
    if (e.type === 'ready') void catchUp();
    if (e.type === 'message.created' && e.data?.conversationId === id) {
      const m = e.data as Message;
      setMessages((cur) => (cur.some((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId)) ? cur : [...cur, m]));
      void client().then((api) => api.conversations.read(id).catch(() => {}));
      setSomeoneTyping((cur) => (cur?.userId === m.sender?.id ? null : cur));
    }
    if (e.type === 'typing' && e.data?.conversationId === id && e.data.userId !== me?.id) {
      const name = conversation?.members.find((x) => x.id === e.data.userId)?.displayName ?? t('m.calls.someone');
      setSomeoneTyping({ userId: e.data.userId, name });
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setSomeoneTyping(null), 5000);
    }
    if ((e.type === 'message.deleted' || e.type === 'message.released') && e.data?.conversationId === id) void load();
    if (e.type === 'message.hidden' && e.data?.conversationId === id) setMessages((cur) => cur.filter((x) => x.id !== e.data.id));
    if (e.type === 'message.edited' && e.data?.conversationId === id) {
      patchMessage(e.data.id, (x) => ({ ...x, body: e.data.body, lang: e.data.lang ?? null, editedAt: e.data.editedAt }));
      setMessages((cur) =>
        cur.map((x) => (x.replyTo && x.replyTo.id === e.data.id ? { ...x, replyTo: { ...x.replyTo, body: String(e.data.body).slice(0, 200) } } : x)),
      );
    }
    if (e.type === 'message.unsent' && e.data?.conversationId === id) {
      patchMessage(e.data.id, (x) => ({
        ...x,
        unsent: true,
        body: '',
        attachments: [],
        reactions: undefined,
        viewOnce: undefined,
        story: undefined,
        poll: undefined,
        list: undefined,
        game: undefined,
        location: undefined,
        market: undefined,
        offer: undefined,
        reminder: undefined,
      }));
      setBoardFor((cur) => (cur === e.data.id ? null : cur));
      const own = sharing.mine;
      if (own && own.messageId === e.data.id) sharing.apply({ ...own, live: false, stoppedAt: new Date().toISOString(), point: null });
      setMessages((cur) =>
        cur.map((x) => (x.replyTo && x.replyTo.id === e.data.id ? { ...x, replyTo: { ...x.replyTo, unsent: true, body: '', attachmentKind: null } } : x)),
      );
      setEditing((cur) => (cur?.id === e.data.id ? null : cur));
      setReplyTo((cur) => (cur?.id === e.data.id ? null : cur));
    }
    // Your own taps are already shown.
    if (e.type === 'message.reaction' && e.data?.conversationId === id && e.data.userId !== me?.id)
      patchMessage(e.data.id, (x) => applyReaction(x, e.data.emoji, false, !!e.data.removed));
    if (e.type === 'conversation.pins' && e.data?.conversationId === id) void loadPins();
    // Live poll results and list changes, each as you see them; your next reminder on a message.
    if (e.type === 'poll.updated' && e.data?.conversationId === id) patchMessage(e.data.id, (x) => (x.unsent ? x : { ...x, poll: e.data.poll }));
    if (e.type === 'list.updated' && e.data?.conversationId === id) patchMessage(e.data.id, (x) => (x.unsent ? x : { ...x, list: e.data.list }));
    // A move, a forfeit or the end of a game: the card and any open board follow. An older update arriving late never winds the board back.
    if (e.type === 'game.updated' && e.data?.conversationId === id) {
      patchMessage(e.data.id, (x) => (x.unsent || (x.game && x.game.moveNumber > e.data.game.moveNumber) ? x : { ...x, game: e.data.game }));
      setLooseGame((g) => (g && g.id === e.data.game.id && g.moveNumber <= e.data.game.moveNumber ? e.data.game : g));
    }
    // Where someone is: the card moves, or says they stopped; your own share's banner follows.
    if (e.type === 'location.updated' && e.data?.conversationId === id) {
      patchMessage(e.data.id, (x) => (x.unsent ? x : { ...x, location: e.data.location }));
      sharing.apply(e.data.location);
    }
    // Market: the listing card (reserved, sold, rated) or an offer (answered, withdrawn) changed, as you see it.
    if (e.type === 'market.updated' && e.data?.conversationId === id)
      patchMessage(e.data.messageId, (x) =>
        x.unsent ? x : { ...x, ...(e.data.market ? { market: e.data.market } : {}), ...(e.data.offer ? { offer: e.data.offer } : {}) },
      );
    // "Ada added 3 songs": more adds raise the line's count.
    if (e.type === 'message.system' && e.data?.conversationId === id) patchMessage(e.data.id, (x) => ({ ...x, system: e.data.system }));
    // A mix shared here changed: its cards show it as it is now (or that it's gone).
    if (e.type === 'mix.updated' && (e.data?.conversationIds as string[] | undefined)?.includes(id)) {
      const mixId = e.data.mixId as string;
      void client()
        .then((api) => api.mixes.get(mixId))
        .then(
          (r) => setMessages((cur) => cur.map((x) => (x.mix?.id === mixId ? { ...x, mix: { available: true as const, ...r.mix } } : x))),
          () => setMessages((cur) => cur.map((x) => (x.mix?.id === mixId ? { ...x, mix: { id: mixId, available: false as const } } : x))),
        );
    }
    if (e.type === 'message.reminder' && e.data?.conversationId === id) patchMessage(e.data.id, (x) => ({ ...x, reminder: e.data.reminder ?? undefined }));
    if (e.type === 'conversation.updated' && e.data?.id === id)
      setConversation((cur) => (cur ? { ...cur, disappearingSeconds: e.data.disappearingSeconds } : cur));
    // Someone changed the wallpaper or bubble colour: everyone sees the same.
    if (e.type === 'conversation.theme' && e.data?.id === id) setConversation((cur) => (cur ? { ...cur, theme: e.data.theme } : cur));
    // The group's name, people or admins changed; or you were taken out of it.
    if (e.type === 'conversation.changed' && e.data?.id === id)
      void client()
        .then((api) => api.conversations.get(id))
        .then(
          (r) => setConversation(r.conversation),
          () => {},
        );
    if (e.type === 'conversation.removed' && e.data?.id === id) {
      setConversation(null);
      setMessages([]);
      setError(t('chat.group.gone'));
    }
    // Someone read up to here: "Seen" under your messages follows.
    if (e.type === 'conversation.read' && e.data?.conversationId === id)
      setConversation((cur) =>
        cur
          ? {
              ...cur,
              readBy: [...(cur.readBy ?? []).filter((r) => r.userId !== e.data.userId), { userId: e.data.userId, lastReadAt: e.data.lastReadAt }],
            }
          : cur,
      );
    if (e.type === 'app.foreground') void load();
    // Someone opened a view-once photo you sent, or its file was deleted.
    if (e.type === 'view_once.updated' && e.data?.conversationId === id)
      setMessages((cur) => cur.map((x) => (x.id === e.data.id ? { ...x, viewOnce: e.data.viewOnce } : x)));
  });

  const replaceMessage = (m: Message) => setMessages((cur) => cur.map((x) => (x.id === m.id ? m : x)));
  // A new card from an answer on another (a counter-offer); the socket may have brought it already.
  const appendMessage = (m: Message) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
  const yaps = conversation?.yaps;
  const [yapSettings, setYapSettings] = useState(false);
  const [smartSettings, setSmartSettings] = useState(false);
  // A setting that didn't save says so in its sheet, not behind it.
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const canCall = !!conversation && conversation.kind !== 'community' && conversation.members.length <= 8 && conversation.members.length > 1;
  // One-to-one chats: the other person's "Now" status, small and muted under their name.
  const nowStatus = conversation?.kind === 'direct' ? liveStatus(conversation.nowStatus) : null;
  useLayoutEffect(() => {
    const title = conversation ? conversationTitle(conversation, me?.id, t) : t('m.title.conversation');
    navigation.setOptions({
      title,
      headerTitle: nowStatus
        ? () => (
            <View style={{ maxWidth: 220, alignItems: Platform.OS === 'ios' ? 'center' : 'flex-start' }}>
              <Text accessibilityRole="header" numberOfLines={1} style={[{ color: c.ink, fontWeight: '700', fontSize: 17 }, userText]}>
                {title}
              </Text>
              <NowStatusLine status={nowStatus} small />
            </View>
          )
        : undefined,
      headerRight: () => (
        // Each icon sits in a 36 × 44 box, 8pt apart: the touch areas reach 44 wide without overlapping.
        <View style={{ flexDirection: 'row', gap: space[2] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.chat.options')}
            hitSlop={HEADER_SLOP}
            onPress={() => setOptionsOpen(true)}
            style={headerIcon}
          >
            <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
          </Pressable>
          {yaps?.available ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.yap.settings')}
              hitSlop={HEADER_SLOP}
              onPress={() => (setSettingsError(null), setYapSettings(true))}
              style={headerIcon}
            >
              <Icon name={yaps.paused ? 'volume-mute-outline' : 'volume-high-outline'} size={22} color={c.yapi} />
            </Pressable>
          ) : null}
          {canCall ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.calls.startAudio')}
                hitSlop={HEADER_SLOP}
                onPress={() => void calls.start(id, 'audio')}
                style={headerIcon}
              >
                <Icon name="call-outline" size={22} color={c.yapi} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.calls.startVideo')}
                hitSlop={HEADER_SLOP}
                onPress={() => void calls.start(id, 'video')}
                style={headerIcon}
              >
                <Icon name="videocam-outline" size={24} color={c.yapi} />
              </Pressable>
            </>
          ) : null}
        </View>
      ),
    });
  }, [navigation, conversation, me?.id, canCall, calls, id, c.yapi, c.ink, t, yaps?.available, yaps?.paused, nowStatus]);

  const [sending, setSending] = useState(false);
  // Set while a text message or an edit is on its way: a second tap on Send does nothing.
  const submitting = useRef(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recording = useAudioRecorderState(recorder, 250);
  const [recordingOn, setRecordingOn] = useState(false);
  const [micDenied, setMicDenied] = useState(false);

  /** Start recording a voice message (asks for the microphone the first time). */
  async function startVoice() {
    setError(null);
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setMicDenied(true);
        return;
      }
      setMicDenied(false);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecordingOn(true);
    } catch (e) {
      setRecordingOn(false);
      setError(errorMessage(e));
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
  }

  /** Stop recording; send it unless cancelled or too short. */
  async function stopVoice(send: boolean) {
    let ms = 0;
    try {
      ms = recorder.getStatus().durationMillis;
    } catch {
      // Released: nothing was kept.
    }
    setRecordingOn(false);
    try {
      await recorder.stop();
    } catch {
      // Already stopped (the recording hit its limit).
    }
    // Back to normal playback (the loudspeaker on iOS).
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    if (!send) return;
    const uri = recorder.uri;
    if (!uri) return;
    if (ms < MIN_VOICE_MS) {
      setError(t('m.chat.voiceTooShort'));
      return;
    }
    setSending(true);
    try {
      const media = await uploadFile(uri, `voice-${Date.now()}.m4a`, VOICE_MIME);
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { message, notice, noticeCode } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }]);
      setHeld(noticeText({ code: noticeCode, message: notice }, t) ?? null);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  // Stop at the length limit and send what was recorded.
  useEffect(() => {
    if (recordingOn && recording.durationMillis >= MAX_VOICE_MS) void stopVoice(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingOn, recording.durationMillis]);

  // ── Yap: hold to talk, let go to send ──
  const [yapping, setYapping] = useState(false);
  const yapHeld = useRef(false);

  async function startYap() {
    if (sending || recordingOn || yapHeld.current) return;
    yapHeld.current = true;
    setError(null);
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        yapHeld.current = false;
        setMicDenied(true);
        return;
      }
      setMicDenied(false);
      // Let go while the permission prompt was up: nothing to record.
      if (!yapHeld.current) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!yapHeld.current) {
        // Let go while it got ready: back to normal playback.
        void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
        return;
      }
      recorder.record();
      setYapping(true);
    } catch (e) {
      yapHeld.current = false;
      setYapping(false);
      setError(errorMessage(e));
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
  }

  async function stopYap() {
    const was = yapHeld.current;
    yapHeld.current = false;
    if (!was || !recorder.isRecording) {
      setYapping(false);
      return;
    }
    const ms = recorder.getStatus().durationMillis;
    setYapping(false);
    try {
      await recorder.stop();
    } catch {
      // Already stopped at the limit.
    }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    const uri = recorder.uri;
    if (!uri || ms < YAP_MIN_MS) return;
    setSending(true);
    try {
      const media = await uploadFile(uri, `yap-${Date.now()}.m4a`, VOICE_MIME);
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { message, notice, noticeCode } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }], { kind: 'yap' });
      setHeld(noticeText({ code: noticeCode, message: notice }, t) ?? null);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

  // No yap plays out loud over a recording (it would switch the audio away from the microphone).
  useMicInUse(recordingOn || yapping);

  // Yaps stop at 60 seconds and send.
  useEffect(() => {
    if (yapping && recording.durationMillis >= YAP_MAX_MS) void stopYap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yapping, recording.durationMillis]);

  /** Pick a photo or video and send it to view once: stored privately, each person opens it one time. */
  async function sendViewOnce() {
    const asset = await pickOne(['images', 'videos']).catch(() => null);
    if (!asset || asset === 'denied') {
      if (asset === 'denied') setError(t('m.create.photosPermission'));
      return;
    }
    if ((asset.fileSize ?? 0) > MAX_UPLOAD_BYTES) {
      setError(t('m.viewOnce.tooBig'));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const video = asset.type === 'video';
      const type = asset.mimeType ?? (video ? 'video/mp4' : 'image/jpeg');
      const media = await uploadFile(asset.uri, asset.fileName ?? `view-once.${video ? 'mp4' : 'jpg'}`, type, undefined, { viewOnce: true });
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { message, notice, noticeCode } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }], { viewOnce: true });
      setHeld(noticeText({ code: noticeCode, message: notice }, t) ?? null);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

  // Leaving the conversation while recording discards it. The recorder may already be released
  // by the time this runs (the hook cleans up first), and then reading it throws: nothing to stop.
  // Either way the phone goes back to normal playback, or everything after plays quietly from the earpiece.
  useEffect(
    () => () => {
      try {
        if (recorder.isRecording) void recorder.stop().catch(() => {});
      } catch {
        // Already released.
      }
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    },
    [recorder],
  );

  // Another screen on top (a link, a notification) while recording: stop and discard it, rather than
  // keep the microphone on out of sight (and a yap sending itself at its limit).
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) return;
    if (recordingOn) void stopVoice(false);
    if (yapHeld.current || yapping) {
      yapHeld.current = false;
      setYapping(false);
      try {
        if (recorder.isRecording) void recorder.stop().catch(() => {});
      } catch {
        // Already released.
      }
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  /** Pick a photo or video, upload it and send it as its own message. */
  async function sendMedia() {
    const asset = await pickOne(['images', 'videos']).catch(() => null);
    if (!asset || asset === 'denied') {
      if (asset === 'denied') setError(t('m.create.photosPermission'));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const media = await uploadPicked(asset);
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { message, notice, noticeCode } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }]);
      setHeld(noticeText({ code: noticeCode, message: notice }, t) ?? null);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

  async function send() {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await sendNow();
    } finally {
      submitting.current = false;
    }
  }

  async function sendNow() {
    const text = body.trim();
    if (editing) return saveEdit(editing, text);
    if (!text) return;
    const quoting = replyTo;
    setBody('');
    setReplyTo(null);
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { message, notice, noticeCode } = await (await client()).conversations.send(id, text, clientId, [], quoting ? { replyToId: quoting.id } : {});
      setHeld(noticeText({ code: noticeCode, message: notice }, t) ?? null);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      setBody(text);
      setReplyTo(quoting);
      fail(e);
    }
  }

  async function saveEdit(m: Message, text: string) {
    if (!text) return setError(t('m.chat.editEmpty'));
    if (text === m.body) return cancelCompose();
    try {
      const { message } = await (await client()).messages.edit(m.id, text);
      if (message) patchMessage(m.id, () => message);
      cancelCompose();
    } catch (e) {
      fail(e);
    }
  }

  function cancelCompose() {
    if (editing) setBody('');
    setEditing(null);
    setReplyTo(null);
  }

  function startReply(m: Message) {
    setActionsFor(null);
    setEditing(null);
    setReplyTo(m);
    input.current?.focus();
  }

  function startEdit(m: Message) {
    setActionsFor(null);
    setReplyTo(null);
    setEditing(m);
    setBody(m.body);
    input.current?.focus();
  }

  async function react(m: Message, emoji: string, on: boolean) {
    setActionsFor(null);
    patchMessage(m.id, (x) => applyReaction(x, emoji, true, !on));
    try {
      const api = await client();
      if (on) await api.messages.react(m.id, emoji);
      else await api.messages.unreact(m.id, emoji);
    } catch (e) {
      patchMessage(m.id, (x) => applyReaction(x, emoji, true, on));
      setError(errorMessage(e));
    }
  }

  async function run(action: () => Promise<unknown>) {
    setActionsFor(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Stop your live share here (started on the web): the card says you stopped. */
  async function stopSharing() {
    try {
      const ended = await sharing.stop();
      if (ended) patchMessage(ended.messageId, (x) => (x.location ? { ...x, location: ended } : x));
      AccessibilityInfo.announceForAccessibility(t('location.stoppedToast'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Ask the others where they are: a line in the chat; each person chooses whether to share. */
  async function askLocation() {
    try {
      const { message } = await (await client()).conversations.askLocation(id);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
      AccessibilityInfo.announceForAccessibility(t('location.request.sent'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const canManage = conversation?.kind === 'direct' || conversation?.myRole === 'admin';
  const pinnedIds = new Set(pins.map((p) => p.message.id));

  /** The long-press menu for one message. */
  function sheetActions(m: Message): SheetAction[] {
    const mine = m.sender.id === me?.id;
    const editable =
      mine &&
      !m.kind &&
      !m.viewOnce &&
      !m.poll &&
      !m.list &&
      !m.game &&
      !m.mix &&
      !m.location &&
      !m.market &&
      !m.offer &&
      !m.unsent &&
      Date.now() - new Date(m.createdAt).getTime() < MESSAGE_EDIT_MINUTES * 60_000;
    const out: SheetAction[] = [];
    if (!m.unsent) out.push({ label: t('m.chat.reply'), icon: 'arrow-undo-outline', onPress: () => startReply(m) });
    if (editable) out.push({ label: t('m.chat.edit'), icon: 'create-outline', onPress: () => startEdit(m) });
    if (canManage && !m.unsent && !m.moderation)
      out.push(
        pinnedIds.has(m.id)
          ? { label: t('m.chat.unpin'), icon: 'pin-outline', onPress: () => void run(async () => setPins((await (await client()).messages.unpin(m.id)).items)) }
          : { label: t('m.chat.pin'), icon: 'pin-outline', onPress: () => void run(async () => setPins((await (await client()).messages.pin(m.id)).items)) },
      );
    if (!m.unsent && !m.moderation) {
      const reminder = m.reminder;
      out.push(
        reminder
          ? {
              label: t('m.chat.remind.cancel'),
              icon: 'notifications-off-outline',
              onPress: () =>
                void run(async () => {
                  await (await client()).messages.cancelReminder(reminder.id);
                  patchMessage(m.id, (x) => ({ ...x, reminder: undefined }));
                }),
            }
          : {
              label: t('m.chat.remind.me'),
              icon: 'notifications-outline',
              onPress: () => {
                setActionsFor(null);
                setRemindFor({ message: m, scope: 'me' });
              },
            },
      );
      if (conversation?.kind === 'group' && conversation.myRole === 'admin')
        out.push({
          label: t('m.chat.remind.group'),
          icon: 'people-outline',
          onPress: () => {
            setActionsFor(null);
            setRemindFor({ message: m, scope: 'group' });
          },
        });
    }
    out.push({
      label: t('m.chat.deleteForMe'),
      icon: 'trash-outline',
      onPress: () =>
        void run(async () => {
          await (await client()).messages.deleteForMe(m.id);
          setMessages((cur) => cur.filter((x) => x.id !== m.id));
        }),
    });
    if (mine && !m.unsent)
      out.push({
        label: t('m.chat.unsend'),
        icon: 'close-circle-outline',
        danger: true,
        onPress: () => {
          setActionsFor(null);
          Alert.alert(t('m.chat.unsend'), t('m.chat.unsendConfirm'), [
            { text: t('m.chat.cancel'), style: 'cancel' },
            {
              text: t('m.chat.unsend'),
              style: 'destructive',
              onPress: () =>
                void run(async () => {
                  const { message } = await (await client()).messages.unsend(m.id);
                  if (message) patchMessage(m.id, () => message);
                }),
            },
          ]);
        },
      });
    // Someone else's message can be reported (not the chat's own lines, like "Ada joined").
    if (!mine && !m.unsent && m.kind !== 'system')
      out.push({
        label: t('post.report'),
        icon: 'flag-outline',
        danger: true,
        onPress: () => report.open({ type: 'message', id: m.id, authorId: m.sender.id, authorName: m.sender.displayName }),
      });
    return out;
  }

  /** Scroll to a message, loading earlier ones until it's there, and mark it for a moment. */
  async function jumpTo(target: string) {
    setSearchOpen(false);
    let all = messages;
    if (!all.some((m) => m.id === target)) {
      let c2 = cursor;
      const earlier: Message[] = [];
      try {
        const api = await client();
        for (let i = 0; i < 20 && c2 && !earlier.some((m) => m.id === target); i++) {
          const r = await api.conversations.messages(id, c2);
          earlier.unshift(...r.items);
          c2 = r.nextCursor;
        }
      } catch (e) {
        setError(errorMessage(e));
      }
      all = [...earlier, ...messages];
      if (earlier.length) {
        setMessages(all);
        setCursor(c2);
      }
    }
    const index = all.findIndex((m) => m.id === target);
    if (index < 0) return setError(t('m.chat.notFound'));
    setHighlight(target);
    setTimeout(() => setHighlight((h) => (h === target ? null : h)), 1800);
    setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 50);
  }

  // Stable handlers for the memoised rows; they call this render's functions.
  const latest = useRef({
    jumpTo,
    setActionsFor,
    startReply,
    react,
    patchMessage,
    replaceMessage,
    appendMessage,
    setBoardFor,
    setError,
    stopSharing,
    setLocationOpen,
    sharing,
  });
  latest.current = {
    jumpTo,
    setActionsFor,
    startReply,
    react,
    patchMessage,
    replaceMessage,
    appendMessage,
    setBoardFor,
    setError,
    stopSharing,
    setLocationOpen,
    sharing,
  };
  const rowHandlers = useMemo<RowHandlers>(
    () => ({
      jumpTo: (mid) => void latest.current.jumpTo(mid),
      openActions: (m) => latest.current.setActionsFor(m),
      startReply: (m) => latest.current.startReply(m),
      react: (m, emoji, on) => void latest.current.react(m, emoji, on),
      patchMessage: (mid, fn) => latest.current.patchMessage(mid, fn),
      replaceMessage: (m) => latest.current.replaceMessage(m),
      appendMessage: (m) => latest.current.appendMessage(m),
      openGame: (mid) => latest.current.setBoardFor(mid),
      stopSharing: () => latest.current.stopSharing(),
      shareLocation: () => latest.current.setLocationOpen(true),
      setViewer: (p) => latest.current.sharing.setViewer(p),
      // Adding a song from a mix card: a problem shows at the top; a song added is read out.
      note: (text, failed) => (failed ? latest.current.setError(text) : AccessibilityInfo.announceForAccessibility(text)),
    }),
    [],
  );
  // The same between renders (typing in the message box included), so the list leaves its rows
  // alone unless something they show changes.
  const meId = me?.id;
  const showSender = !!conversation && conversation.members.length > 2;
  const watchingId = watching?.id ?? null;
  const viewer = sharing.viewer;
  // Read receipts: under your newest message, "Seen" (one-to-one) or who of the group has read it.
  const lastMine = messages.filter((m) => m.sender.id === meId && m.kind !== 'system' && !m.unsent && !m.moderation).at(-1);
  const readers = lastMine ? (conversation?.readBy ?? []).filter((r) => r.lastReadAt >= lastMine.createdAt).length : 0;
  const seenLabel = !readers
    ? null
    : conversation?.kind === 'direct'
      ? t('chat.seen')
      : readers >= (conversation?.readBy?.length ?? 0)
        ? t('chat.seenByAll')
        : tp('chat.seenBy', readers);
  const lastMineId = lastMine?.id;
  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageRow
        item={item}
        mine={item.sender.id === meId}
        meId={meId}
        showSender={showSender}
        highlighted={highlight === item.id}
        accent={accent}
        watchLive={!!watchingId && item.system?.type === 'watch' && item.system.sessionId === watchingId}
        viewer={item.location ? viewer : null}
        seen={item.id === lastMineId ? seenLabel : null}
        h={rowHandlers}
      />
    ),
    [meId, showSender, highlight, accent, watchingId, viewer, rowHandlers, lastMineId, seenLabel],
  );

  // Follow the newest message, not when earlier ones are loaded above it.
  const followed = useRef<string | null>(null);

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      {error ? (
        <View style={{ padding: space[3] }}>
          {/* Nothing loaded yet: say why and offer to try again. */}
          {conversation ? <Notice tone="danger">{error}</Notice> : <ErrorState message={error} onRetry={load} />}
        </View>
      ) : null}
      {held ? (
        <View style={{ padding: space[3] }}>
          <Notice>{held}</Notice>
        </View>
      ) : null}
      {micDenied ? (
        <View style={{ padding: space[3] }}>
          <Notice tone="warn">
            <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.chat.micPermission')}</Text>
            <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} hitSlop={10}>
              <Text style={{ color: c.yapi, fontWeight: '700', marginTop: space[1] }}>{t('m.common.openSettings')}</Text>
            </Pressable>
          </Notice>
        </View>
      ) : null}
      {needsVerify ? (
        <View style={{ padding: space[3] }}>
          <VerifyPrompt action="message" />
        </View>
      ) : null}
      {watching ? <WatchBanner summary={watching} /> : null}
      <SharingBanner share={sharing.mine} onStop={stopSharing} here={sharing.startedHere} />
      <PinnedBar
        pins={pins}
        canManage={canManage}
        onJump={(mid) => void jumpTo(mid)}
        onUnpin={(mid) => void run(async () => setPins((await (await client()).messages.unpin(mid)).items))}
      />
      {conversation?.disappearingSeconds ? (
        <Pressable
          accessibilityRole="button"
          // 24pt tall; the touch area reaches 44.
          hitSlop={{ top: 10, bottom: 10 }}
          onPress={() => setDisappearingOpen(true)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'center', paddingVertical: space[1] }}
        >
          <Icon name="timer-outline" size={14} color={c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }}>
            {t('m.chat.disappearingOn', { time: disappearingText(t, conversation.disappearingSeconds) })}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        <ChatWallpaperView wallpaper={theme.wallpaper} />
        <FlatList
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          // Scrolling tucks the keyboard away, so the whole conversation is readable again.
          keyboardDismissMode="on-drag"
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          // A new chat: who is in it, so the first message has somewhere to start.
          ListEmptyComponent={
            conversation ? (
              <EmptyState
                icon="chatbubbles-outline"
                title={t('m.chat.empty.title')}
                body={t('m.chat.empty.body', {
                  names: formatList(
                    conversation.members.filter((m) => m.id !== me?.id).map((m) => m.displayName),
                    locale,
                    t,
                  ),
                })}
              />
            ) : null
          }
          contentContainerStyle={{ padding: space[4], gap: space[2] }}
          onContentSizeChange={() => {
            const last = messages.at(-1)?.id ?? null;
            // A new message, or the newest one growing (a poll's results, a vote, a photo loading)
            // while you're reading the bottom: stay at the bottom so nothing ends up cut off.
            if (last === followed.current && !atBottom.current) return;
            followed.current = last;
            list.current?.scrollToEnd({ animated: false });
          }}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottom.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120;
          }}
          scrollEventThrottle={100}
          // The space above the message box changed (the keyboard, suggested replies, the voice bar):
          // if you were at the newest message, stay there.
          onLayout={() => {
            if (atBottom.current) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: false }));
          }}
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 100);
          }}
          renderItem={renderMessage}
          // Your messages waiting to be sent: only you see them, after the newest message.
          ListFooterComponent={
            <>
              <ScheduledList
                items={scheduled.items}
                accent={accent}
                onChanged={(s) => scheduled.setItems((cur) => cur.map((x) => (x.id === s.id ? s : x)).sort((a, b) => a.sendAt.localeCompare(b.sendAt)))}
                onSent={(s, m) => {
                  scheduled.setItems((cur) => cur.filter((x) => x.id !== s.id));
                  setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
                }}
                onRemoved={(s) => scheduled.setItems((cur) => cur.filter((x) => x.id !== s.id))}
                onError={setError}
              />
              {someoneTyping ? (
                <Text style={{ color: c.inkMuted, fontSize: 13, paddingHorizontal: space[4], paddingVertical: space[1] }}>
                  {t('chat.typing', { name: someoneTyping.name })}
                </Text>
              ) : null}
            </>
          }
          initialNumToRender={20}
          maxToRenderPerBatch={12}
          windowSize={11}
        />
      </View>
      {yaps?.available && !recordingOn && !typing ? (
        <View style={{ paddingHorizontal: space[3], paddingTop: space[2] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.yap.a11y')}
            accessibilityState={{ selected: yapping, disabled: sending }}
            disabled={sending}
            onPressIn={() => void startYap()}
            onPressOut={() => void stopYap()}
            delayLongPress={60_000}
            style={{ opacity: sending ? 0.5 : 1 }}
          >
            <LinearGradient
              {...gradient(c)}
              style={{
                height: 56,
                borderRadius: 28,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space[2],
                transform: [{ scale: yapping ? 0.97 : 1 }],
              }}
            >
              <Icon name="mic" size={22} color={c.onYapi} />
              <Text style={{ color: c.onYapi, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                {yapping ? t('m.yap.release', { time: clock(recording.durationMillis / 1000) }) : t('m.yap.hold')}
              </Text>
              {yapping ? <Waveform color={c.onYapi} bars={7} height={18} /> : null}
            </LinearGradient>
          </Pressable>
        </View>
      ) : null}
      {!editing && !recordingOn && !body.trim() ? (
        <SmartReplyChips
          conversationId={id}
          lastMessageId={messages.at(-1)?.id ?? null}
          enabled={!!conversation?.smartReplies?.on}
          onPick={(text) => {
            setBody(text);
            input.current?.focus();
          }}
        />
      ) : null}
      {replyTo || editing ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            marginHorizontal: space[3],
            marginTop: space[2],
            paddingStart: space[3],
            paddingEnd: space[1],
            paddingVertical: space[1],
            borderStartWidth: 3,
            borderStartColor: c.yapi,
            borderRadius: radius.md,
            backgroundColor: c.surface,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.yapi, fontSize: 12, fontWeight: '700' }}>
              {editing
                ? t('m.chat.editing')
                : replyTo!.sender.id === me?.id
                  ? t('m.chat.replyingToSelf')
                  : t('m.chat.replyingTo', { name: replyTo!.sender.displayName })}
            </Text>
            {replyTo ? (
              <Text numberOfLines={1} style={[{ color: c.ink, fontSize: 14 }, userText]}>
                {previewText(t, previewOf(replyTo), { meId: me?.id, locale })}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(editing ? 'm.chat.cancelEdit' : 'm.chat.cancelReply')}
            hitSlop={8}
            onPress={cancelCompose}
            style={{ padding: space[2] }}
          >
            <Icon name="close" size={20} color={c.inkMuted} />
          </Pressable>
        </View>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: space[2],
          paddingHorizontal: space[3],
          paddingTop: space[2],
          paddingBottom: typing ? space[2] : Math.max(insets.bottom, space[3]),
        }}
      >
        {recordingOn ? (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.chat.cancelVoice')}
              onPress={() => void stopVoice(false)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="trash-outline" size={24} color={c.inkMuted} />
            </Pressable>
            <View
              accessibilityLiveRegion="polite"
              style={[
                { flex: 1, height: 44, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4] },
                { backgroundColor: c.surface },
                elevation(c),
              ]}
            >
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger }} />
              <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
                {t('m.chat.recording', { time: clock(recording.durationMillis / 1000) })}
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.chat.sendVoice')} onPress={() => void stopVoice(true)}>
              <LinearGradient {...gradient(c)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="arrow-up" size={22} color={c.onYapi} />
              </LinearGradient>
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.chat.addMenu')}
              disabled={sending}
              // 32 wide; the touch area reaches 44 into the padding at the row's start.
              hitSlop={slop({ start: 12 })}
              onPress={() => setAddOpen(true)}
              style={{ width: 32, height: 44, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.45 : 1 }}
            >
              <Icon name="add-circle-outline" size={26} color={c.inkMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.chat.sendPhoto')}
              disabled={sending}
              onPress={() => void sendMedia()}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.45 : 1 }}
            >
              <Icon name="image-outline" size={24} color={c.inkMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.viewOnce.send')}
              disabled={sending}
              // 36 wide; the touch area reaches 44 into the gap before the message box.
              hitSlop={slop({ end: 8 })}
              onPress={() => void sendViewOnce()}
              style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.45 : 1 }}
            >
              <Icon name="eye-outline" size={24} color={c.inkMuted} />
            </Pressable>
            <TextInput
              ref={input}
              accessibilityLabel={t('inbox.placeholder')}
              placeholder={t('inbox.placeholder')}
              placeholderTextColor={c.inkMuted}
              value={body}
              onChangeText={onType}
              maxLength={4000}
              multiline
              style={[
                {
                  flex: 1,
                  minHeight: 44,
                  maxHeight: 120,
                  borderRadius: radius.lg,
                  paddingHorizontal: space[4],
                  paddingTop: 12,
                  paddingBottom: 12,
                  fontSize: 15,
                  color: c.ink,
                  backgroundColor: c.surface,
                },
                userText,
                elevation(c),
              ]}
            />
            {body.trim() || editing ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={editing ? t('m.chat.saveEdit') : t('inbox.send')}
                accessibilityHint={editing ? undefined : t('m.chat.later.holdHint')}
                accessibilityActions={editing ? [] : [{ name: 'sendLater', label: t('m.chat.later.title') }]}
                onAccessibilityAction={(e) => e.nativeEvent.actionName === 'sendLater' && setLaterOpen(true)}
                onPress={send}
                onLongPress={editing ? undefined : () => setLaterOpen(true)}
              >
                <LinearGradient {...gradient(c)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
                  {/* Points up, not along the line, so it stays the same in right-to-left layouts. */}
                  <Icon name={editing ? 'checkmark' : 'arrow-up'} size={22} color={c.onYapi} />
                </LinearGradient>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.chat.record')}
                disabled={sending}
                onPress={() => void startVoice()}
                style={{ opacity: sending ? 0.45 : 1 }}
              >
                <LinearGradient {...gradient(c)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="mic" size={22} color={c.onYapi} />
                </LinearGradient>
              </Pressable>
            )}
          </>
        )}
      </View>
      {yaps ? (
        <BottomSheet visible={yapSettings} title={t('m.yap.settings')} onClose={() => setYapSettings(false)} done gap={space[4]}>
          {settingsError ? <Notice tone="danger">{settingsError}</Notice> : null}
          <SwitchRow
            label={t('m.yap.outLoud')}
            hint={yaps.playOutLoud === null ? t(conversation?.kind === 'direct' ? 'm.yap.defaultDirect' : 'm.yap.defaultGroup') : t('m.yap.outLoudHint')}
            value={yaps.playOutLoud ?? yaps.defaultOutLoud}
            onValueChange={async (on) => {
              setSettingsError(null);
              try {
                const r = await (await client()).conversations.setYaps(id, on);
                setConversation((cur) => (cur ? { ...cur, yaps: r.yaps } : cur));
              } catch (e) {
                setSettingsError(errorMessage(e));
              }
            }}
          />
          <SwitchRow
            label={t('m.yap.pause')}
            hint={t('m.yap.quietNote')}
            value={yaps.paused}
            onValueChange={async (paused) => {
              setSettingsError(null);
              try {
                await (await client()).yaps.setPaused(paused);
                setConversation((cur) => (cur?.yaps ? { ...cur, yaps: { ...cur.yaps, paused } } : cur));
              } catch (e) {
                setSettingsError(errorMessage(e));
              }
            }}
          />
        </BottomSheet>
      ) : null}
      {conversation?.smartReplies ? (
        <BottomSheet visible={smartSettings} title={t('smartReplies.label')} onClose={() => setSmartSettings(false)} done gap={space[4]}>
          {settingsError ? <Notice tone="danger">{settingsError}</Notice> : null}
          <SmartRepliesSwitch
            state={conversation.smartReplies}
            onChange={async (on) => {
              setSettingsError(null);
              try {
                const r = await (await client()).conversations.setSmartReplies(id, on);
                setConversation((cur) => (cur ? { ...cur, smartReplies: r.smartReplies } : cur));
              } catch (e) {
                setSettingsError(errorMessage(e));
              }
            }}
          />
        </BottomSheet>
      ) : null}
      <MessageActions
        open={!!actionsFor}
        onClose={() => setActionsFor(null)}
        onReact={
          actionsFor && !actionsFor.unsent
            ? (emoji) => void react(actionsFor, emoji, !actionsFor.reactions?.some((r) => r.emoji === emoji && r.mine))
            : undefined
        }
        actions={actionsFor ? sheetActions(actionsFor) : []}
      />
      <ActionSheet
        visible={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        title={t('m.chat.options')}
        actions={[
          ...(watching
            ? [{ label: t('watch.join'), icon: 'tv-outline' as const, onPress: () => openWatch(watching.id) }]
            : canWatch
              ? [{ label: t('watch.start'), icon: 'tv-outline' as const, hint: t('watch.startEmpty'), onPress: () => void startWatch(id).catch(fail) }]
              : []),
          ...(conversation?.kind === 'group'
            ? [{ label: t('chat.group.info'), icon: 'people-outline' as const, onPress: () => router.push({ pathname: '/group-info', params: { id } }) }]
            : []),
          { label: t('m.chat.search'), icon: 'search-outline', onPress: () => setSearchOpen(true) },
          {
            label: `${t('m.chat.disappearing')} · ${disappearingText(t, conversation?.disappearingSeconds)}`,
            icon: 'timer-outline',
            onPress: () => setDisappearingOpen(true),
          },
          ...(conversation?.smartReplies
            ? [{ label: t('smartReplies.label'), icon: 'sparkles-outline' as const, onPress: () => (setSettingsError(null), setSmartSettings(true)) }]
            : []),
          { label: t('m.chat.look.title'), icon: 'color-palette-outline', onPress: () => setLookOpen(true) },
          ...(canAlbum
            ? [{ label: t('together.chat.start'), icon: 'images-outline' as const, onPress: () => router.push(`/together/new?chat=${encodeURIComponent(id)}`) }]
            : []),
          ...(miniAppsOn ? [{ label: t('chat.apps'), icon: 'apps-outline' as const, onPress: () => setAppsOpen(true) }] : []),
        ]}
      />
      <MiniAppsSheet
        visible={appsOpen}
        onClose={() => setAppsOpen(false)}
        surface="conversation"
        surfaceId={id}
        onSend={async (text) => {
          const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const { message } = await (await client()).conversations.send(id, text, clientId);
          setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
        }}
      />
      <DateTimeSheet
        visible={laterOpen}
        title={t('m.chat.later.title')}
        min={laterLimits().min}
        max={laterLimits().max}
        value={new Date(Date.now() + 60 * 60_000)}
        quick
        hint={t('m.chat.later.hint')}
        confirmLabel={() => t('m.chat.later.schedule')}
        onClose={() => setLaterOpen(false)}
        onPick={(at) => {
          setLaterOpen(false);
          const text = body.trim();
          if (!text) return;
          const quoting = replyTo;
          void (async () => {
            try {
              const { scheduled: s } = await (
                await client()
              ).conversations.schedule(id, {
                body: text,
                sendAt: at.toISOString(),
                ...(quoting ? { replyToId: quoting.id } : {}),
              });
              scheduled.setItems((cur) => [...cur.filter((x) => x.id !== s.id), s].sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
              setBody('');
              setReplyTo(null);
              // Show it where it waits, below the newest message.
              setTimeout(() => list.current?.scrollToEnd({ animated: true }), 150);
            } catch (e) {
              fail(e);
            }
          })();
        }}
      />
      <ChatLookSheet
        visible={lookOpen}
        onClose={() => setLookOpen(false)}
        theme={conversation?.theme}
        onPick={async (next) => {
          try {
            const r = await (await client()).conversations.setTheme(id, next);
            setConversation((cur) => (cur ? { ...cur, theme: r.theme } : cur));
            const line = r.message;
            if (line) setMessages((cur) => (cur.some((x) => x.id === line.id) ? cur : [...cur, line]));
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
      <ActionSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('m.chat.addMenu')}
        actions={[
          { label: t('m.chat.poll.new'), icon: 'stats-chart-outline', onPress: () => setPollOpen(true) },
          { label: t('m.chat.list.new'), icon: 'checkbox-outline', onPress: () => setListOpen(true) },
          ...(conversation && conversation.kind !== 'community'
            ? [
                { label: t('m.chat.game.new'), icon: 'game-controller-outline' as const, onPress: () => setGameStartOpen(true) },
                { label: t('mixes.shareHere'), icon: 'list-outline' as const, onPress: () => setMixShareOpen(true) },
                { label: t('location.menu'), icon: 'location-outline' as const, onPress: () => setLocationOpen(true) },
                { label: t('location.ask'), icon: 'help-circle-outline' as const, onPress: () => void askLocation() },
              ]
            : []),
        ]}
      />
      <ShareLocationSheet
        visible={locationOpen}
        onClose={() => setLocationOpen(false)}
        conversationId={id}
        onSent={(m) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]))}
        onStarted={sharing.started}
      />
      <ShareMixHereSheet
        visible={mixShareOpen}
        onClose={() => setMixShareOpen(false)}
        conversationId={id}
        onSent={(m) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]))}
      />
      <StartGameSheet
        open={gameStartOpen}
        onClose={() => setGameStartOpen(false)}
        conversation={conversation}
        meId={me?.id}
        onSent={(m) => {
          setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
          setBoardFor(m.id);
        }}
        onOpenGame={(game) => {
          setLooseGame(messages.some((m) => m.id === game.messageId) ? null : game);
          setBoardFor(game.messageId);
        }}
      />
      <GameSheet
        game={messages.find((m) => m.id === boardFor)?.game ?? (looseGame?.messageId === boardFor ? looseGame : null)}
        meId={me?.id}
        onClose={() => setBoardFor(null)}
        onGame={(game) => {
          patchMessage(game.messageId, (x) => ({ ...x, game }));
          setLooseGame((g) => (g && g.id === game.id ? game : g));
        }}
        onRematch={(m) => {
          setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
          setBoardFor(m.id);
        }}
      />
      <PollComposer
        open={pollOpen}
        onClose={() => setPollOpen(false)}
        conversationId={id}
        onSent={(m) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]))}
      />
      <ListComposer
        open={listOpen}
        onClose={() => setListOpen(false)}
        conversationId={id}
        onSent={(m) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]))}
      />
      <ReminderPicker
        message={remindFor?.message ?? null}
        scope={remindFor?.scope ?? 'me'}
        onClose={() => setRemindFor(null)}
        onError={setError}
        onSet={(r) => {
          // Your own reminder shows on the message (the earliest one); the group's shows as a line at its time.
          if (r.scope === 'me')
            patchMessage(r.messageId, (x) => (x.reminder && x.reminder.remindAt <= r.remindAt ? x : { ...x, reminder: { id: r.id, remindAt: r.remindAt } }));
        }}
      />
      {report.sheet}
      <SearchSheet conversationId={id} open={searchOpen} onClose={() => setSearchOpen(false)} onJump={(mid) => void jumpTo(mid)} />
      <DisappearingSheet
        open={disappearingOpen}
        onClose={() => setDisappearingOpen(false)}
        current={conversation?.disappearingSeconds ?? null}
        canChange={canManage}
        onChange={(seconds) =>
          void (async () => {
            try {
              const r = await (await client()).conversations.setDisappearing(id, seconds);
              setConversation((cur) => (cur ? { ...cur, disappearingSeconds: r.disappearingSeconds } : cur));
              const line = r.message;
              if (line) setMessages((cur) => (cur.some((x) => x.id === line.id) ? cur : [...cur, line]));
              setDisappearingOpen(false);
            } catch (e) {
              setError(errorMessage(e));
            }
          })()
        }
      />
    </KeyboardAvoid>
  );
}

/** What a message row can ask the chat to do. The object stays the same, so rows only render again when their message changes. */
interface RowHandlers {
  jumpTo: (id: string) => void;
  openActions: (m: Message) => void;
  startReply: (m: Message) => void;
  react: (m: Message, emoji: string, on: boolean) => void;
  patchMessage: (id: string, fn: (m: Message) => Message) => void;
  replaceMessage: (m: Message) => void;
  appendMessage: (m: Message) => void;
  openGame: (messageId: string) => void;
  note: (text: string, failed?: boolean) => void;
  stopSharing: () => Promise<unknown>;
  shareLocation: () => void;
  setViewer: (p: LatLng) => void;
}

/** One message: its bubble (yours at the end edge), reactions, and swipe to reply. */
const MessageRow = memo(function MessageRow({
  item,
  mine,
  meId,
  showSender,
  highlighted,
  accent,
  watchLive,
  viewer,
  seen,
  h,
}: {
  item: Message;
  mine: boolean;
  meId: string | undefined;
  showSender: boolean;
  highlighted: boolean;
  /** Your bubbles' colours in this chat (the brand gradient unless the chat has its own). */
  accent: AccentColors;
  watchLive: boolean;
  /** Where you are, for distances on location cards (worked out on this phone only). */
  viewer: LatLng | null;
  /** Read receipt under your newest message ("Seen", "Seen by 2"), or null. */
  seen: string | null;
  h: RowHandlers;
}) {
  const c = useColors();
  const { t } = useT();
  if (item.kind === 'system')
    return item.system?.type === 'location_request' ? (
      <LocationRequestLine message={item} meId={meId} onShare={h.shareLocation} />
    ) : (
      <SystemLine message={item} meId={meId} onJump={h.jumpTo} watchLive={watchLive} />
    );
  const rich = !item.unsent && (item.poll || item.list || item.game || item.mix || item.location || item.market || item.offer);
  const text = item.unsent
    ? t(mine ? 'm.chat.unsentMine' : 'm.chat.unsent')
    : rich
      ? ''
      : item.body || (item.attachments.length || item.story ? '' : t('m.message.deleted'));
  const tint = mine ? accent.on : c.ink;
  const quote = item.replyTo && !item.unsent ? <Quote preview={item.replyTo} tint={tint} meId={meId} onJump={h.jumpTo} /> : null;
  const textStyle = item.unsent ? { fontStyle: 'italic' as const, opacity: 0.8 } : null;
  const meta = item.editedAt && !item.unsent ? <Text style={{ color: tint, fontSize: 11, opacity: 0.75 }}>{t('m.chat.edited')}</Text> : null;
  const openActions = () => h.openActions(item);
  const media = item.unsent ? null : item.poll ? (
    <PollCard message={item} meId={meId} tint={tint} onPoll={(poll) => h.patchMessage(item.id, (x) => ({ ...x, poll }))} />
  ) : item.list ? (
    <ListCard message={item} meId={meId} tint={tint} onList={(l) => h.patchMessage(item.id, (x) => ({ ...x, list: l }))} />
  ) : item.game ? (
    <GameCard message={item} meId={meId} tint={tint} onOpen={() => h.openGame(item.id)} />
  ) : item.mix ? (
    <ChatMixCard mix={item.mix} onMix={(mix) => h.patchMessage(item.id, (x) => ({ ...x, mix }))} onNote={h.note} />
  ) : item.market ? (
    <ListingChatCard card={item.market} tint={tint} onCard={(market) => h.patchMessage(item.id, (x) => ({ ...x, market }))} onNote={h.note} />
  ) : item.offer ? (
    <OfferChatCard
      offer={item.offer}
      meId={meId}
      tint={tint}
      onOffer={(offer) => h.patchMessage(item.id, (x) => ({ ...x, offer }))}
      onAppend={h.appendMessage}
      onNote={h.note}
    />
  ) : item.location ? (
    <LocationCard message={item} meId={meId} tint={tint} viewer={viewer} onViewer={h.setViewer} onStop={h.stopSharing} />
  ) : item.viewOnce ? (
    <ViewOnceBubble message={item} mine={mine} tint={tint} onChange={h.replaceMessage} />
  ) : (
    <>
      {item.kind === 'yap' ? <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.8 }}>{t('m.yap.label')}</Text> : null}
      {/* A reply to a story says so first ("Replied to your story"), in your language. */}
      {item.storyReply ? (
        <Text style={[{ color: tint, fontSize: 12, opacity: 0.8 }, userText]}>{storyReplyLabel(item.storyReply, item.sender.id, meId, t)}</Text>
      ) : null}
      {item.story ? <StoryCardView card={item.story} dark={mine} /> : null}
      <Attachments items={item.attachments} tint={tint} />
    </>
  );
  // Your messages sit at the end edge (the right in English, the left in Arabic), with the
  // tail corner on that side.
  const bubbleView = mine ? (
    <View style={{ alignSelf: 'flex-end', maxWidth: '80%', gap: 2 }}>
      <Pressable onLongPress={openActions} accessibilityHint={t('m.chat.messageOptions')}>
        <LinearGradient
          colors={[accent.from, accent.to]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[bubble, { maxWidth: '100%', alignSelf: 'flex-end', borderBottomEndRadius: 6 }]}
        >
          {quote}
          {media}
          {text ? <Text style={[{ color: accent.on, fontSize: 15, lineHeight: 21 }, userText, textStyle]}>{text}</Text> : null}
          {meta}
        </LinearGradient>
      </Pressable>
      <ReactionRow message={item} mine onToggle={(emoji, on) => h.react(item, emoji, on)} />
      {item.moderation === 'review' ? <Text style={{ color: c.inkMuted, fontSize: 12, alignSelf: 'flex-end' }}>{t('m.chat.held')}</Text> : null}
      {seen ? <Text style={{ color: c.inkMuted, fontSize: 12, alignSelf: 'flex-end' }}>{seen}</Text> : null}
      {item.reminder && !item.unsent ? <ReminderNote at={item.reminder.remindAt} alignEnd /> : null}
    </View>
  ) : (
    <View style={{ alignSelf: 'flex-start', maxWidth: '80%', gap: 2 }}>
      <Pressable
        onLongPress={openActions}
        accessibilityHint={t('m.chat.messageOptions')}
        style={[bubble, { maxWidth: '100%', backgroundColor: c.surface, borderBottomStartRadius: 6 }, elevation(c)]}
      >
        {showSender ? <Text style={[{ color: c.yapi, fontSize: 12, fontWeight: '700' }, userText]}>{item.sender.displayName}</Text> : null}
        {quote}
        {media}
        {item.body && !item.unsent && !rich ? (
          // Their text, with "See translation" when it's in a language you don't understand. (A poll, list or game shows its own.)
          <TranslatableText kind="message" id={item.id} text={item.body} lang={item.lang} rich={false} style={{ color: c.ink, fontSize: 15, lineHeight: 21 }} />
        ) : text ? (
          <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText, textStyle]}>{text}</Text>
        ) : null}
        {meta}
      </Pressable>
      <ReactionRow message={item} mine={false} onToggle={(emoji, on) => h.react(item, emoji, on)} />
      {item.reminder && !item.unsent ? <ReminderNote at={item.reminder.remindAt} alignEnd={false} /> : null}
    </View>
  );
  return (
    <View
      style={{ borderRadius: radius.lg, backgroundColor: highlighted ? c.surfaceSunken : 'transparent' }}
      accessibilityActions={
        item.unsent
          ? []
          : [
              { name: 'reply', label: t('m.chat.reply') },
              { name: 'longpress', label: t('m.chat.messageOptions') },
            ]
      }
      onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'reply' ? h.startReply(item) : openActions())}
    >
      <SwipeToReply enabled={!item.unsent} onReply={() => h.startReply(item)}>
        {bubbleView}
      </SwipeToReply>
    </View>
  );
});

const bubble = { maxWidth: '80%', paddingHorizontal: space[3] + 2, paddingVertical: space[2] + 2, borderRadius: radius.lg } as const;

/** Photos and voice messages play inline; videos open in the player. */
function Attachments({ items, tint }: { items: Message['attachments']; tint: string }) {
  const { t } = useT();
  const [revealed, setRevealed] = useState<number[]>([]);
  if (!items.length) return null;
  return (
    <View style={{ gap: space[1] }}>
      {items.map((a, i) =>
        a.removed ? (
          <UnavailableMedia key={i} tint={tint} />
        ) : a.sensitive && !revealed.includes(i) ? (
          <View key={i} style={{ width: 220, height: 160, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000' }}>
            {a.kind === 'image' || a.posterUrl ? (
              <Image
                source={{ uri: mediaUrl(a.kind === 'image' ? a.url : a.posterUrl!) }}
                blurRadius={40}
                style={{ width: 220, height: 160 }}
                resizeMode="cover"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            ) : null}
            <SensitiveCover compact onReveal={() => setRevealed((r) => [...r, i])} />
          </View>
        ) : a.kind === 'audio' ? (
          <VoiceMessage key={i} url={mediaUrl(a.url)} durationMs={a.durationMs ?? null} tint={tint} />
        ) : a.kind === 'image' ? (
          <Pressable
            key={i}
            accessibilityRole="imagebutton"
            accessibilityLabel={a.name || t('m.post.photo')}
            onPress={() => void Linking.openURL(mediaUrl(a.url))}
          >
            <Image source={{ uri: mediaUrl(a.url) }} style={{ width: 220, height: 160, borderRadius: radius.md }} resizeMode="cover" />
          </Pressable>
        ) : (
          <Pressable
            key={i}
            accessibilityRole="button"
            // 30pt tall; the touch area reaches 44 inside the bubble's padding.
            hitSlop={{ top: 7, bottom: 7 }}
            onPress={() => void Linking.openURL(mediaUrl(a.url))}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingVertical: space[1] }}
          >
            <Icon name="play-circle-outline" size={22} color={tint} />
            <Text style={{ color: tint, fontSize: 15, fontWeight: '600' }}>
              {t('m.chat.video')}
              {a.durationMs ? ` · ${clock(a.durationMs / 1000)}` : ''}
            </Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

/** The voice message playing now, so starting another pauses it. */
let nowPlaying: AudioPlayer | null = null;

/** A voice message in the bubble: play or pause, progress, and its length. */
function VoiceMessage({ url, durationMs, tint }: { url: string; durationMs: number | null; tint: string }) {
  const { t } = useT();
  const player = useAudioPlayer(url, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const total = status.duration > 0 ? status.duration : durationMs ? durationMs / 1000 : 0;
  const at = status.currentTime;

  // Back to the start when it finishes, ready to play again.
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      void player.seekTo(0);
    }
  }, [status.didJustFinish, player]);
  useEffect(
    () => () => {
      if (nowPlaying === player) nowPlaying = null;
    },
    [player],
  );

  const toggle = () => {
    if (status.playing) return player.pause();
    if (nowPlaying && nowPlaying !== player) {
      try {
        nowPlaying.pause();
      } catch {
        // That message's player was already released.
      }
    }
    nowPlaying = player;
    if (total && at >= total - 0.05) void player.seekTo(0);
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    player.play();
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minWidth: 180, paddingVertical: space[1] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? t('m.chat.pauseVoice') : t('m.chat.playVoice')}
        accessibilityState={{ selected: status.playing }}
        hitSlop={8}
        onPress={toggle}
      >
        <Icon name={status.playing ? 'pause-circle' : 'play-circle'} size={34} color={tint} />
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: tint, opacity: 0.25 }} />
        <View
          style={{
            position: 'absolute',
            top: 0,
            start: 0,
            height: 4,
            borderRadius: 2,
            backgroundColor: tint,
            width: `${total ? Math.min(100, (at / total) * 100) : 0}%`,
          }}
        />
        <Text style={{ color: tint, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }} accessibilityLabel={t('m.chat.voiceMessage')}>
          {status.playing || at > 0 ? `${clock(at)} / ${clock(total)}` : total ? clock(total) : t('m.chat.voiceMessage')}
        </Text>
      </View>
    </View>
  );
}
