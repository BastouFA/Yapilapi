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
import { FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Conversation, Message } from '../../../../packages/shared/src/types';
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
      void api.conversations.read(id).catch(() => {});
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

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
      headerRight:
        canCall || yaps?.available
          ? () => (
              <View style={{ flexDirection: 'row', gap: space[4] }}>
                {yaps?.available ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={t('m.yap.settings')} hitSlop={10} onPress={() => setYapSettings(true)}>
                    <Icon name={yaps.paused ? 'volume-mute-outline' : 'volume-high-outline'} size={22} color={c.yapi} />
                  </Pressable>
                ) : null}
                {canCall ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('m.calls.startAudio')}
                      hitSlop={10}
                      onPress={() => void calls.start(id, 'audio')}
                    >
                      <Icon name="call-outline" size={22} color={c.yapi} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('m.calls.startVideo')}
                      hitSlop={10}
                      onPress={() => void calls.start(id, 'video')}
                    >
                      <Icon name="videocam-outline" size={24} color={c.yapi} />
                    </Pressable>
                  </>
                ) : null}
              </View>
            )
          : undefined,
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

  // Leaving the conversation while recording discards it.
  useEffect(
    () => () => {
      if (recorder.isRecording) void recorder.stop().catch(() => {});
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
    if (!text) return;
    setBody('');
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { message } = await (await client()).conversations.send(id, text, clientId);
      setMessages((cur) => (cur.some((x) => x.id === message.id) ? cur : [...cur, message]));
    } catch (e) {
      setBody(text);
      fail(e);
    }
  }

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
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space[4], gap: space[2] }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => {
          const mine = item.sender.id === me?.id;
          const text = item.body || (item.attachments.length || item.story ? '' : t('m.message.deleted'));
          const tint = mine ? c.onYapi : c.ink;
          const media = item.viewOnce ? (
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
          return mine ? (
            <View style={{ alignSelf: 'flex-end', maxWidth: '80%', gap: 2 }}>
              <LinearGradient {...gradient(c)} style={[bubble, { maxWidth: '100%', alignSelf: 'flex-end', borderBottomEndRadius: 6 }]}>
                {media}
                {text ? <Text style={[{ color: c.onYapi, fontSize: 15, lineHeight: 21 }, userText]}>{text}</Text> : null}
              </LinearGradient>
              {item.moderation === 'review' ? <Text style={{ color: c.inkMuted, fontSize: 12, alignSelf: 'flex-end' }}>{t('m.chat.held')}</Text> : null}
            </View>
          ) : (
            <View style={[bubble, { alignSelf: 'flex-start', backgroundColor: c.surface, borderBottomStartRadius: 6 }, elevation(c)]}>
              {conversation && conversation.members.length > 2 ? (
                <Text style={[{ color: c.yapi, fontSize: 12, fontWeight: '700' }, userText]}>{item.sender.displayName}</Text>
              ) : null}
              {media}
              {text ? <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText]}>{text}</Text> : null}
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
            {body.trim() ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t('inbox.send')} onPress={send}>
                <LinearGradient {...gradient(c)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
                  {/* Points up, not along the line, so it stays the same in right-to-left layouts. */}
                  <Icon name="arrow-up" size={22} color={c.onYapi} />
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
