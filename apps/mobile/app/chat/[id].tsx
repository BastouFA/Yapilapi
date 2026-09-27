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
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Conversation, Message, PinnedMessage } from '../../../../packages/shared/src/types';
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
import { Icon, Notice, SwitchRow, useColors, userText } from '../../lib/ui';
import { ViewOnceBubble } from '../../lib/view-once';
import { Waveform, YAP_MAX_MS, YAP_MIN_MS } from '../../lib/yaps';
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
  Sheet,
  SwipeToReply,
  SystemLine,
  type SheetAction,
} from '../../lib/chat-extras';
import { TranslatableText } from '../../lib/translation';
import { ListCard, ListComposer, PollCard, PollComposer, ReminderNote, ReminderPicker } from '../../lib/chat-polls';

/** Voice messages shorter than this are treated as a slip of the finger and not sent. */
const MIN_VOICE_MS = 1000;
/** Voice messages stop recording at 5 minutes. */
const MAX_VOICE_MS = 5 * 60 * 1000;

/**
 * A conversation, updated live over the realtime socket, with audio and video call buttons.
 * With nothing typed, the send button records a voice message instead.
 */
export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { me } = useSession();
  const calls = useCalls();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  // Whether the newest messages are on screen (then growth at the bottom keeps them in view).
  const atBottom = useRef(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [disappearingOpen, setDisappearingOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [remindFor, setRemindFor] = useState<{ message: Message; scope: 'me' | 'group' } | null>(null);
  const input = useRef<TextInput>(null);
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
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, loadPins]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime((e) => {
    if (e.type === 'message.created' && e.data?.conversationId === id) {
      const m = e.data as Message;
      setMessages((cur) => (cur.some((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId)) ? cur : [...cur, m]));
      void client().then((api) => api.conversations.read(id).catch(() => {}));
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
        reminder: undefined,
      }));
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
    if (e.type === 'message.reminder' && e.data?.conversationId === id) patchMessage(e.data.id, (x) => ({ ...x, reminder: e.data.reminder ?? undefined }));
    if (e.type === 'conversation.updated' && e.data?.id === id)
      setConversation((cur) => (cur ? { ...cur, disappearingSeconds: e.data.disappearingSeconds } : cur));
    if (e.type === 'app.foreground') void load();
    // Someone opened a view-once photo you sent, or its file was deleted.
    if (e.type === 'view_once.updated' && e.data?.conversationId === id)
      setMessages((cur) => cur.map((x) => (x.id === e.data.id ? { ...x, viewOnce: e.data.viewOnce } : x)));
  });

  const replaceMessage = (m: Message) => setMessages((cur) => cur.map((x) => (x.id === m.id ? m : x)));
  const yaps = conversation?.yaps;
  const [yapSettings, setYapSettings] = useState(false);

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
        <View style={{ flexDirection: 'row', gap: space[4] }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.chat.options')} hitSlop={10} onPress={() => setOptionsOpen(true)}>
            <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
          </Pressable>
          {yaps?.available ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.yap.settings')} hitSlop={10} onPress={() => setYapSettings(true)}>
              <Icon name={yaps.paused ? 'volume-mute-outline' : 'volume-high-outline'} size={22} color={c.yapi} />
            </Pressable>
          ) : null}
          {canCall ? (
            <>
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.calls.startAudio')} hitSlop={10} onPress={() => void calls.start(id, 'audio')}>
                <Icon name="call-outline" size={22} color={c.yapi} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.calls.startVideo')} hitSlop={10} onPress={() => void calls.start(id, 'video')}>
                <Icon name="videocam-outline" size={24} color={c.yapi} />
              </Pressable>
            </>
          ) : null}
        </View>
      ),
    });
  }, [navigation, conversation, me?.id, canCall, calls, id, c.yapi, c.ink, t, yaps?.available, yaps?.paused, nowStatus]);

  const [sending, setSending] = useState(false);
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
    }
  }

  /** Stop recording; send it unless cancelled or too short. */
  async function stopVoice(send: boolean) {
    const ms = recorder.getStatus().durationMillis;
    setRecordingOn(false);
    try {
      await recorder.stop();
    } catch {
      // Already stopped (the recording hit its limit).
    }
    // Back to normal playback (the loudspeaker on iOS).
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    const uri = recorder.uri;
    if (!send || !uri) return;
    if (ms < MIN_VOICE_MS) {
      setError(t('m.chat.voiceTooShort'));
      return;
    }
    setSending(true);
    try {
      const media = await uploadFile(uri, `voice-${Date.now()}.m4a`, VOICE_MIME);
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { message } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }]);
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
      if (!yapHeld.current) return;
      recorder.record();
      setYapping(true);
    } catch (e) {
      yapHeld.current = false;
      setYapping(false);
      setError(errorMessage(e));
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
      const { message } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }], { kind: 'yap' });
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

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
      const { message } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }], { viewOnce: true });
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

  // Leaving the conversation while recording discards it. The recorder may already be released
  // by the time this runs (the hook cleans up first), and then reading it throws: nothing to stop.
  useEffect(
    () => () => {
      try {
        if (recorder.isRecording) void recorder.stop().catch(() => {});
      } catch {
        // Already released.
      }
    },
    [recorder],
  );

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
      const { message } = await (await client()).conversations.send(id, '', clientId, [{ mediaId: media.id }]);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const text = body.trim();
    if (editing) return saveEdit(editing, text);
    if (!text) return;
    const quoting = replyTo;
    setBody('');
    setReplyTo(null);
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { message } = await (await client()).conversations.send(id, text, clientId, [], quoting ? { replyToId: quoting.id } : {});
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

  const canManage = conversation?.kind === 'direct' || conversation?.myRole === 'admin';
  const pinnedIds = new Set(pins.map((p) => p.message.id));

  /** The long-press menu for one message. */
  function sheetActions(m: Message): SheetAction[] {
    const mine = m.sender.id === me?.id;
    const editable =
      mine && !m.kind && !m.viewOnce && !m.poll && !m.list && !m.unsent && Date.now() - new Date(m.createdAt).getTime() < MESSAGE_EDIT_MINUTES * 60_000;
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

  // Follow the newest message, not when earlier ones are loaded above it.
  const followed = useRef<string | null>(null);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.ground }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      {error ? (
        <View style={{ padding: space[3] }}>
          <Notice tone="danger">{error}</Notice>
        </View>
      ) : null}
      {micDenied ? (
        <View style={{ padding: space[3] }}>
          <Notice tone="warn">
            <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.chat.micPermission')}</Text>
            <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} hitSlop={8}>
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
      <PinnedBar
        pins={pins}
        canManage={canManage}
        onJump={(mid) => void jumpTo(mid)}
        onUnpin={(mid) => void run(async () => setPins((await (await client()).messages.unpin(mid)).items))}
      />
      {conversation?.disappearingSeconds ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setDisappearingOpen(true)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'center', paddingVertical: space[1] }}
        >
          <Icon name="timer-outline" size={14} color={c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }}>
            {t('m.chat.disappearingOn', { time: disappearingText(t, conversation.disappearingSeconds) })}
          </Text>
        </Pressable>
      ) : null}
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
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
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 100);
        }}
        renderItem={({ item }) => {
          if (item.kind === 'system') return <SystemLine message={item} meId={me?.id} onJump={(mid) => void jumpTo(mid)} />;
          const mine = item.sender.id === me?.id;
          const rich = !item.unsent && (item.poll || item.list);
          const text = item.unsent
            ? t(mine ? 'm.chat.unsentMine' : 'm.chat.unsent')
            : rich
              ? ''
              : item.body || (item.attachments.length || item.story ? '' : t('m.message.deleted'));
          const tint = mine ? c.onYapi : c.ink;
          const quote = item.replyTo && !item.unsent ? <Quote preview={item.replyTo} tint={tint} meId={me?.id} onJump={(mid) => void jumpTo(mid)} /> : null;
          const textStyle = item.unsent ? { fontStyle: 'italic' as const, opacity: 0.8 } : null;
          const meta = item.editedAt && !item.unsent ? <Text style={{ color: tint, fontSize: 11, opacity: 0.75 }}>{t('m.chat.edited')}</Text> : null;
          const openActions = () => setActionsFor(item);
          const media = item.unsent ? null : item.poll ? (
            <PollCard message={item} meId={me?.id} tint={tint} onPoll={(poll) => patchMessage(item.id, (x) => ({ ...x, poll }))} />
          ) : item.list ? (
            <ListCard message={item} meId={me?.id} tint={tint} onList={(l) => patchMessage(item.id, (x) => ({ ...x, list: l }))} />
          ) : item.viewOnce ? (
            <ViewOnceBubble message={item} mine={mine} tint={tint} onChange={replaceMessage} />
          ) : (
            <>
              {item.kind === 'yap' ? (
                <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.8 }}>{t('m.yap.label')}</Text>
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
                <LinearGradient {...gradient(c)} style={[bubble, { maxWidth: '100%', alignSelf: 'flex-end', borderBottomEndRadius: 6 }]}>
                  {quote}
                  {media}
                  {text ? <Text style={[{ color: c.onYapi, fontSize: 15, lineHeight: 21 }, userText, textStyle]}>{text}</Text> : null}
                  {meta}
                </LinearGradient>
              </Pressable>
              <ReactionRow message={item} mine onToggle={(emoji, on) => void react(item, emoji, on)} />
              {item.moderation === 'review' ? <Text style={{ color: c.inkMuted, fontSize: 12, alignSelf: 'flex-end' }}>{t('m.chat.held')}</Text> : null}
              {item.reminder && !item.unsent ? <ReminderNote at={item.reminder.remindAt} alignEnd /> : null}
            </View>
          ) : (
            <View style={{ alignSelf: 'flex-start', maxWidth: '80%', gap: 2 }}>
              <Pressable
                onLongPress={openActions}
                accessibilityHint={t('m.chat.messageOptions')}
                style={[bubble, { maxWidth: '100%', backgroundColor: c.surface, borderBottomStartRadius: 6 }, elevation(c)]}
              >
                {conversation && conversation.members.length > 2 ? (
                  <Text style={[{ color: c.yapi, fontSize: 12, fontWeight: '700' }, userText]}>{item.sender.displayName}</Text>
                ) : null}
                {quote}
                {media}
                {item.body && !item.unsent ? (
                  // Their text, with "See translation" when it's in a language you don't understand.
                  <TranslatableText
                    kind="message"
                    id={item.id}
                    text={item.body}
                    lang={item.lang}
                    rich={false}
                    style={{ color: c.ink, fontSize: 15, lineHeight: 21 }}
                  />
                ) : text ? (
                  <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText, textStyle]}>{text}</Text>
                ) : null}
                {meta}
              </Pressable>
              <ReactionRow message={item} mine={false} onToggle={(emoji, on) => void react(item, emoji, on)} />
              {item.reminder && !item.unsent ? <ReminderNote at={item.reminder.remindAt} alignEnd={false} /> : null}
            </View>
          );
          return (
            <View
              style={{ borderRadius: radius.lg, backgroundColor: highlight === item.id ? c.surfaceSunken : 'transparent' }}
              accessibilityActions={
                item.unsent
                  ? []
                  : [
                      { name: 'reply', label: t('m.chat.reply') },
                      { name: 'longpress', label: t('m.chat.messageOptions') },
                    ]
              }
              onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'reply' ? startReply(item) : openActions())}
            >
              <SwipeToReply enabled={!item.unsent} onReply={() => startReply(item)}>
                {bubbleView}
              </SwipeToReply>
            </View>
          );
        }}
      />
      {yaps?.available && !recordingOn ? (
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
                {previewText(t, previewOf(replyTo))}
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
          paddingBottom: Math.max(insets.bottom, space[3]),
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
              onChangeText={setBody}
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
              <Pressable accessibilityRole="button" accessibilityLabel={editing ? t('m.chat.saveEdit') : t('inbox.send')} onPress={send}>
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
        <Modal visible={yapSettings} transparent animationType="slide" onRequestClose={() => setYapSettings(false)}>
          <Pressable style={{ flex: 1, backgroundColor: c.overlay }} accessibilityLabel={t('m.common.close')} onPress={() => setYapSettings(false)} />
          <View
            style={{
              backgroundColor: c.surface,
              borderTopStartRadius: radius.lg,
              borderTopEndRadius: radius.lg,
              padding: space[4],
              paddingBottom: Math.max(insets.bottom, space[4]),
              gap: space[4],
            }}
          >
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
              {t('m.yap.settings')}
            </Text>
            <SwitchRow
              label={t('m.yap.outLoud')}
              hint={yaps.playOutLoud === null ? t(conversation?.kind === 'direct' ? 'm.yap.defaultDirect' : 'm.yap.defaultGroup') : t('m.yap.outLoudHint')}
              value={yaps.playOutLoud ?? yaps.defaultOutLoud}
              onValueChange={async (on) => {
                try {
                  const r = await (await client()).conversations.setYaps(id, on);
                  setConversation((cur) => (cur ? { ...cur, yaps: r.yaps } : cur));
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
            <SwitchRow
              label={t('m.yap.pause')}
              hint={t('m.yap.quietNote')}
              value={yaps.paused}
              onValueChange={async (paused) => {
                try {
                  await (await client()).yaps.setPaused(paused);
                  setConversation((cur) => (cur?.yaps ? { ...cur, yaps: { ...cur.yaps, paused } } : cur));
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
            <Pressable accessibilityRole="button" onPress={() => setYapSettings(false)} style={{ alignSelf: 'flex-end', padding: space[2] }}>
              <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 15 }}>{t('m.common.done')}</Text>
            </Pressable>
          </View>
        </Modal>
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
      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title={t('m.chat.options')}>
        {[
          { label: t('m.chat.search'), icon: 'search-outline' as const, onPress: () => setSearchOpen(true) },
          {
            label: `${t('m.chat.disappearing')} · ${disappearingText(t, conversation?.disappearingSeconds)}`,
            icon: 'timer-outline' as const,
            onPress: () => setDisappearingOpen(true),
          },
        ].map((row) => (
          <Pressable
            key={row.icon}
            accessibilityRole="button"
            onPress={() => {
              setOptionsOpen(false);
              row.onPress();
            }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44, opacity: pressed ? 0.7 : 1 })}
          >
            <Icon name={row.icon} size={22} color={c.ink} />
            <Text style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>{row.label}</Text>
          </Pressable>
        ))}
      </Sheet>
      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title={t('m.chat.addMenu')}>
        {[
          { label: t('m.chat.poll.new'), icon: 'stats-chart-outline' as const, onPress: () => setPollOpen(true) },
          { label: t('m.chat.list.new'), icon: 'checkbox-outline' as const, onPress: () => setListOpen(true) },
        ].map((row) => (
          <Pressable
            key={row.icon}
            accessibilityRole="button"
            onPress={() => {
              setAddOpen(false);
              row.onPress();
            }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44, opacity: pressed ? 0.7 : 1 })}
          >
            <Icon name={row.icon} size={22} color={c.ink} />
            <Text style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>{row.label}</Text>
          </Pressable>
        ))}
      </Sheet>
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
    </KeyboardAvoidingView>
  );
}

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
