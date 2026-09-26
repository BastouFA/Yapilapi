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
import { FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Conversation, Message } from '../../../../packages/shared/src/types';
import { useCalls } from '../../lib/calls';
import { client, errorMessage, mediaUrl } from '../../lib/api';
import { clock, pickOne, uploadFile, uploadPicked, VOICE_MIME } from '../../lib/media';
import { useT } from '../../lib/i18n';
import { conversationTitle } from '../../lib/post';
import { useRealtime, useSession } from '../../lib/session';
import { elevation, gradient, radius, space } from '../../lib/theme';
import { Icon, Notice, useColors, userText } from '../../lib/ui';

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
  const list = useRef<FlatList<Message>>(null);

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
    if (e.type === 'message.deleted' && e.data?.conversationId === id) void load();
    if (e.type === 'app.foreground') void load();
  });

  const canCall = !!conversation && conversation.kind !== 'community' && conversation.members.length <= 8 && conversation.members.length > 1;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: conversation ? conversationTitle(conversation, me?.id, t) : t('m.title.conversation'),
      headerRight: canCall
        ? () => (
            <View style={{ flexDirection: 'row', gap: space[4] }}>
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.calls.startAudio')} hitSlop={10} onPress={() => void calls.start(id, 'audio')}>
                <Icon name="call-outline" size={22} color={c.yapi} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={t('m.calls.startVideo')} hitSlop={10} onPress={() => void calls.start(id, 'video')}>
                <Icon name="videocam-outline" size={24} color={c.yapi} />
              </Pressable>
            </View>
          )
        : undefined,
    });
  }, [navigation, conversation, me?.id, canCall, calls, id, c.yapi, t]);

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
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space[4], gap: space[2] }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => {
          const mine = item.sender.id === me?.id;
          const text = item.body || (item.attachments.length ? '' : t('m.message.deleted'));
          const media = <Attachments items={item.attachments} tint={mine ? c.onYapi : c.ink} />;
          // Your messages sit at the end edge (the right in English, the left in Arabic), with the
          // tail corner on that side.
          return mine ? (
            <LinearGradient {...gradient(c)} style={[bubble, { alignSelf: 'flex-end', borderBottomEndRadius: 6 }]}>
              {media}
              {text ? <Text style={[{ color: c.onYapi, fontSize: 15, lineHeight: 21 }, userText]}>{text}</Text> : null}
            </LinearGradient>
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
    </KeyboardAvoidingView>
  );
}

const bubble = { maxWidth: '80%', paddingHorizontal: space[3] + 2, paddingVertical: space[2] + 2, borderRadius: radius.lg } as const;

/** Photos and voice messages play inline; videos open in the player. */
function Attachments({ items, tint }: { items: Message['attachments']; tint: string }) {
  const { t } = useT();
  if (!items.length) return null;
  return (
    <View style={{ gap: space[1] }}>
      {items.map((a, i) =>
        a.kind === 'audio' ? (
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
