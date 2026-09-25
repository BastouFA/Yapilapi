import * as Notifications from 'expo-notifications';
import { LinearGradient } from 'expo-linear-gradient';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Linking, Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import type { CallInfo } from '../../../packages/api-client/src/index';
import { client, errorMessage } from './api';
import { configureCallNotifications } from './push';
import { useRealtime, useSession } from './session';
import { gradient, radius, space } from './theme';
import { Avatar, Icon, useColors, type IconName } from './ui';
import { audio, callsSupported, rtc } from './webrtc';

type Phase = 'idle' | 'incoming' | 'outgoing' | 'active';
type Kind = 'audio' | 'video';
type SignalData = Record<string, unknown>;

interface CallsCtx {
  /** Start a call in a conversation. Resolves once ringing (or after explaining why it can't). */
  start: (conversationId: string, kind: Kind) => Promise<void>;
  supported: boolean;
}
const Ctx = createContext<CallsCtx>({ start: async () => {}, supported: false });
export const useCalls = () => useContext(Ctx);

const RING_MS = 45_000;

class PermissionError extends Error {}
class UnsupportedError extends Error {}

function explain(e: unknown, action: 'call' | 'answer') {
  if (e instanceof UnsupportedError)
    return Alert.alert(
      'Calls need the full app',
      'Calls use native audio and video that Expo Go does not include. Install a development build of YAPILAPI to make and answer calls.',
    );
  if (e instanceof PermissionError)
    return Alert.alert(e.message, 'Allow microphone and camera access for YAPILAPI in Settings, then try again.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: () => void Linking.openSettings() },
    ]);
  Alert.alert(action === 'call' ? "Couldn't start the call" : "Couldn't answer the call", errorMessage(e));
}

/**
 * Peer-to-peer calls with react-native-webrtc, speaking the same protocol as the web app
 * (apps/web/components/Calls.tsx) so phones and browsers can call each other:
 *  - POST /v1/conversations/:id/calls rings everyone else (realtime `call.incoming`, plus a
 *    `call_incoming` push);
 *  - each person who answers triggers `call.answered`; the caller then sends them an offer;
 *  - offers, answers and ICE candidates travel through POST /v1/calls/:id/signal and arrive
 *    as `call.signal` events; `call.declined` / `call.left` end 1:1 calls.
 * Media never passes through the API. ICE servers (STUN, plus TURN when configured) come
 * from the API with each call.
 */
export function CallsProvider({ children }: { children: ReactNode }) {
  const { me, setKeepAlive, waitForRealtime } = useSession();
  const [call, setCall] = useState<CallInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [frontCamera, setFrontCamera] = useState(true);
  const [speaker, setSpeaker] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [names, setNames] = useState<Record<string, { name: string; avatarUrl: string | null }>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const localRef = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidates = useRef(new Map<string, SignalData[]>());
  const ice = useRef<RTCIceServer[]>([]);
  const callRef = useRef<CallInfo | null>(null);
  callRef.current = call;
  const starting = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 3500);
  }, []);

  const cleanup = useCallback(() => {
    peers.current.forEach((p) => p.close());
    peers.current.clear();
    pendingCandidates.current.clear();
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current?.release();
    localRef.current = null;
    audio.stopRing();
    audio.stop();
    Vibration.cancel();
    setLocal(null);
    setRemotes({});
    setCall(null);
    setPhase('idle');
    setMuted(false);
    setCameraOff(false);
    setFrontCamera(true);
    setSpeaker(false);
    setConnectedAt(null);
    setKeepAlive(false);
  }, [setKeepAlive]);

  /** Camera and microphone. A call without a microphone is not a call, so that is required. */
  async function getMedia(kind: Kind) {
    if (!rtc) throw new UnsupportedError();
    let stream: MediaStream;
    try {
      stream = await rtc.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' ? { facingMode: 'user' } : false });
    } catch {
      throw new PermissionError(kind === 'video' ? 'Camera and microphone are blocked' : 'Microphone is blocked');
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      stream.release();
      throw new PermissionError('Microphone is blocked');
    }
    if (kind === 'video' && !stream.getVideoTracks().length) {
      setCameraOff(true);
      flash('Camera access is off, so they will only hear you.');
    }
    localRef.current = stream;
    setLocal(stream);
    return stream;
  }

  function beginAudio(kind: Kind) {
    audio.start(kind);
    // Video calls default to the loudspeaker, audio calls to the earpiece, like a phone call.
    audio.speaker(kind === 'video');
    setSpeaker(kind === 'video');
    setKeepAlive(true);
  }

  const loadNames = useCallback(async (c: CallInfo) => {
    try {
      const { conversation } = await (await client()).conversations.get(c.conversationId);
      setNames(Object.fromEntries(conversation.members.map((m) => [m.id, { name: m.displayName, avatarUrl: m.avatarUrl }])));
    } catch {
      /* names are a nicety */
    }
  }, []);

  const peerFor = useCallback(
    (callId: string, userId: string) => {
      let pc = peers.current.get(userId);
      if (pc) return pc;
      const RTC = rtc!;
      const created = new RTC.RTCPeerConnection({ iceServers: ice.current as never });
      pc = created;
      localRef.current?.getTracks().forEach((t) => created.addTrack(t, localRef.current!));
      // The package's event typings are incomplete, so the handlers describe the fields they use.
      created.onicecandidate = (e: unknown) => {
        const cand = (e as { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }).candidate;
        if (!cand) return;
        void client()
          .then((api) => api.calls.signal(callId, userId, 'candidate', { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex }))
          .catch(() => {});
      };
      created.ontrack = (e: unknown) => {
        const stream = (e as { streams: MediaStream[] }).streams[0];
        if (stream) setRemotes((r) => ({ ...r, [userId]: stream }));
      };
      created.onconnectionstatechange = () => {
        if (created.connectionState === 'connected') setConnectedAt((t) => t ?? Date.now());
        if (created.connectionState === 'failed') flash('The connection dropped. Try calling again.');
      };
      peers.current.set(userId, created);
      return created;
    },
    [flash],
  );

  async function flushCandidates(userId: string, pc: RTCPeerConnection) {
    const queued = pendingCandidates.current.get(userId) ?? [];
    pendingCandidates.current.delete(userId);
    for (const c of queued) await pc.addIceCandidate(new rtc!.RTCIceCandidate(c as never)).catch(() => {});
  }

  const start = useCallback(
    async (conversationId: string, kind: Kind) => {
      if (callRef.current || starting.current) return void Alert.alert("You're already in a call");
      starting.current = true;
      try {
        await getMedia(kind);
        const r = await (await client()).calls.start(conversationId, kind);
        ice.current = r.iceServers;
        setCall(r.call);
        setPhase('outgoing');
        beginAudio(kind);
        void loadNames(r.call);
      } catch (e) {
        explain(e, 'call');
        cleanup();
      } finally {
        starting.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleanup, loadNames],
  );

  async function answer(incoming?: CallInfo) {
    const cur = incoming ?? callRef.current;
    if (!cur) return;
    audio.stopRing();
    Vibration.cancel();
    try {
      // Media and ICE servers first, so the caller's offer finds everything ready.
      const api = await client();
      const [, info] = await Promise.all([getMedia(cur.kind), api.calls.get(cur.id), waitForRealtime()]);
      ice.current = info.iceServers;
      const r = await api.calls.answer(cur.id);
      ice.current = r.iceServers;
      setCall(r.call);
      setPhase('active');
      beginAudio(cur.kind);
    } catch (e) {
      explain(e, 'answer');
      await (await client()).calls.decline(cur.id).catch(() => {});
      cleanup();
    }
  }

  async function decline() {
    const cur = callRef.current;
    if (cur) await (await client()).calls.decline(cur.id).catch(() => {});
    cleanup();
  }

  async function hangUp() {
    const cur = callRef.current;
    if (cur) await (await client()).calls.end(cur.id).catch(() => {});
    cleanup();
  }

  const ringIncoming = useCallback(
    (c: CallInfo) => {
      setCall(c);
      setPhase('incoming');
      void loadNames(c);
      if (audio.available) audio.ring();
      else Vibration.vibrate([0, 800, 600], true);
    },
    [loadNames],
  );

  useRealtime(async (e) => {
    if (!me) return;
    if (!rtc) {
      // Without WebRTC we can still show the ring screen, which explains what is needed.
      if (e.type === 'call.incoming' && !callRef.current) ringIncoming(e.data);
      if (callRef.current && e.data?.callId === callRef.current.id && (e.type === 'call.left' || e.type === 'call.declined')) cleanup();
      return;
    }
    const cur = callRef.current;
    if (e.type === 'call.incoming') {
      if (cur) return void (await client()).calls.decline(e.data.id).catch(() => {}); // busy
      ringIncoming(e.data);
      return;
    }
    if (!cur || e.data?.callId !== cur.id) return;
    try {
      if (e.type === 'call.answered' && e.data.userId !== me.id) {
        if (cur.callerId !== me.id) return;
        setPhase('active');
        const pc = peerFor(cur.id, e.data.userId);
        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        await (await client()).calls.signal(cur.id, e.data.userId, 'offer', { type: offer.type, sdp: offer.sdp });
      }
      if (e.type === 'call.answered' && e.data.userId === me.id && phaseRef.current === 'incoming') {
        // Answered on another device.
        cleanup();
        return;
      }
      if (e.type === 'call.signal') {
        const from = e.data.from as string;
        const pc = peerFor(cur.id, from);
        const data = e.data.data as SignalData;
        if (e.data.type === 'offer') {
          await pc.setRemoteDescription(new rtc.RTCSessionDescription(data as never));
          await flushCandidates(from, pc);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          await (await client()).calls.signal(cur.id, from, 'answer', { type: ans.type, sdp: ans.sdp });
        } else if (e.data.type === 'answer') {
          await pc.setRemoteDescription(new rtc.RTCSessionDescription(data as never));
          await flushCandidates(from, pc);
        } else if (e.data.type === 'candidate') {
          if (pc.remoteDescription) await pc.addIceCandidate(new rtc.RTCIceCandidate(data as never)).catch(() => {});
          else pendingCandidates.current.set(from, [...(pendingCandidates.current.get(from) ?? []), data]);
        }
      }
      if (e.type === 'call.declined' || e.type === 'call.left') {
        const uid = e.data.userId as string;
        if (uid === me.id) {
          // Declined or ended on another of my devices.
          if (phaseRef.current === 'incoming') cleanup();
          return;
        }
        peers.current.get(uid)?.close();
        peers.current.delete(uid);
        setRemotes((r) => {
          const n = { ...r };
          delete n[uid];
          return n;
        });
        if (cur.participants.length === 2) {
          flash(e.type === 'call.declined' ? 'Call declined' : 'Call ended');
          cleanup();
        }
      }
    } catch {
      flash('The call hit a problem. Try calling again.');
    }
  });

  // Ringing times out on the server after 45 seconds; mirror it here, like the web app.
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing') return;
    const id = setTimeout(() => {
      flash(phase === 'incoming' ? 'Missed call' : 'No answer');
      void hangUp();
    }, RING_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Push: the call_incoming category (Answer / Decline) and taps on call notifications.
  useEffect(() => {
    void configureCallNotifications();
  }, []);
  useEffect(() => {
    if (!me) return;
    const handle = async (resp: Notifications.NotificationResponse | null) => {
      const data = resp?.notification.request.content.data as { type?: string; entityId?: string } | undefined;
      if (!resp || data?.type !== 'call_incoming' || !data.entityId) return;
      await Notifications.clearLastNotificationResponseAsync().catch(() => {});
      const api = await client();
      if (resp.actionIdentifier === 'decline') return void api.calls.decline(data.entityId).catch(() => {});
      if (callRef.current) return;
      try {
        const { call: c } = await api.calls.get(data.entityId);
        if (c.status !== 'ringing') return flash('Missed call');
        ringIncoming(c);
        if (resp.actionIdentifier === 'answer') void answer(c);
      } catch {
        flash('That call has ended.');
      }
    };
    void Notifications.getLastNotificationResponseAsync().then(handle);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => void handle(r));
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, flash, ringIncoming]);

  const others = call ? call.participants.filter((p) => p !== me?.id) : [];
  const title = others.map((id) => names[id]?.name ?? 'Someone').join(', ') || 'Call';

  return (
    <Ctx.Provider value={{ start, supported: callsSupported }}>
      {children}
      <Modal
        visible={phase !== 'idle' && !!call}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => (phase === 'incoming' ? decline() : hangUp())}
      >
        {call ? (
          <CallView
            call={call}
            phase={phase}
            title={title}
            avatarUrl={others.length === 1 ? (names[others[0]!]?.avatarUrl ?? null) : null}
            local={local}
            remotes={remotes}
            muted={muted}
            cameraOff={cameraOff}
            frontCamera={frontCamera}
            speaker={speaker}
            connectedAt={connectedAt}
            notice={notice}
            onAnswer={() => void answer()}
            onDecline={decline}
            onHangUp={hangUp}
            onMute={() => {
              localRef.current?.getAudioTracks().forEach((t) => (t.enabled = muted));
              setMuted(!muted);
            }}
            onCamera={() => {
              localRef.current?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
              setCameraOff(!cameraOff);
            }}
            onFlip={() => {
              localRef.current?.getVideoTracks().forEach((t) => t._switchCamera());
              setFrontCamera(!frontCamera);
            }}
            onSpeaker={() => {
              audio.speaker(!speaker);
              setSpeaker(!speaker);
            }}
          />
        ) : null}
      </Modal>
      {notice && phase === 'idle' ? <Toast text={notice} /> : null}
    </Ctx.Provider>
  );
}

function Toast({ text }: { text: string }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16, alignItems: 'center' }}>
      <View accessibilityLiveRegion="polite" style={{ backgroundColor: c.ink, borderRadius: radius.full, paddingHorizontal: 18, paddingVertical: 10 }}>
        <Text style={{ color: c.ground, fontWeight: '600' }}>{text}</Text>
      </View>
    </View>
  );
}

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function CallView(p: {
  call: CallInfo;
  phase: Phase;
  title: string;
  avatarUrl: string | null;
  local: MediaStream | null;
  remotes: Record<string, MediaStream>;
  muted: boolean;
  cameraOff: boolean;
  frontCamera: boolean;
  speaker: boolean;
  connectedAt: number | null;
  notice: string | null;
  onAnswer: () => void;
  onDecline: () => void;
  onHangUp: () => void;
  onMute: () => void;
  onCamera: () => void;
  onFlip: () => void;
  onSpeaker: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const elapsed = useElapsed(p.connectedAt);
  const video = p.call.kind === 'video';
  const remote = Object.values(p.remotes).find((s) => s.getVideoTracks().length);
  const RTCView = rtc?.RTCView;
  const status = p.phase === 'incoming' ? `Incoming ${p.call.kind} call` : p.phase === 'outgoing' ? 'Calling…' : (elapsed ?? 'Connecting…');

  return (
    <View style={{ flex: 1, backgroundColor: '#0B0C14' }}>
      {video && remote && RTCView && p.phase === 'active' ? (
        <RTCView streamURL={remote.toURL()} objectFit="cover" style={StyleSheet.absoluteFill} />
      ) : (
        <LinearGradient colors={['#3A1624', '#151726', '#0B0C14']} style={StyleSheet.absoluteFill} />
      )}

      <View style={{ paddingTop: insets.top + space[6], alignItems: 'center', gap: space[3], paddingHorizontal: space[6] }}>
        {!(video && remote && p.phase === 'active') ? <Avatar name={p.title} url={p.avatarUrl} size={104} /> : null}
        <Text style={s.name} numberOfLines={2}>
          {p.title}
        </Text>
        <Text style={s.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
        {p.notice ? <Text style={[s.status, { color: '#FFBE3D' }]}>{p.notice}</Text> : null}
        {!callsSupported ? (
          <Text style={[s.status, { textAlign: 'center' }]}>
            Calls need the development build of YAPILAPI. Expo Go can't carry audio or video, so you can only decline here.
          </Text>
        ) : null}
      </View>

      {video && p.local && RTCView && !p.cameraOff && p.phase !== 'incoming' ? (
        <View style={[s.self, { top: insets.top + space[4] }]}>
          <RTCView streamURL={p.local.toURL()} mirror={p.frontCamera} objectFit="cover" zOrder={1} style={{ flex: 1 }} accessibilityLabel="Your camera" />
        </View>
      ) : null}

      <View style={{ flex: 1 }} />

      {p.phase === 'incoming' ? (
        <View style={[s.controls, { paddingBottom: insets.bottom + space[8], justifyContent: 'space-evenly' }]}>
          <RoundButton label="Decline" icon="call" rotate tone="danger" onPress={p.onDecline} />
          {callsSupported ? <RoundButton label="Answer" icon={video ? 'videocam' : 'call'} tone="accept" onPress={p.onAnswer} /> : null}
        </View>
      ) : (
        <View style={[s.controls, { paddingBottom: insets.bottom + space[6] }]}>
          <RoundButton label={p.muted ? 'Unmute' : 'Mute'} icon={p.muted ? 'mic-off' : 'mic'} on={p.muted} onPress={p.onMute} />
          {video ? (
            <RoundButton
              label={p.cameraOff ? 'Camera on' : 'Camera off'}
              icon={p.cameraOff ? 'videocam-off' : 'videocam'}
              on={p.cameraOff}
              onPress={p.onCamera}
            />
          ) : null}
          {video ? <RoundButton label="Switch camera" icon="camera-reverse" onPress={p.onFlip} disabled={p.cameraOff} /> : null}
          <RoundButton label={p.speaker ? 'Speaker off' : 'Speaker'} icon={p.speaker ? 'volume-high' : 'ear'} on={p.speaker} onPress={p.onSpeaker} />
          <RoundButton label="Hang up" icon="call" rotate tone="danger" onPress={p.onHangUp} />
        </View>
      )}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 4 }}>
        <LinearGradient {...gradient(c)} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

function RoundButton({
  label,
  icon,
  onPress,
  on,
  tone,
  rotate,
  disabled,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  on?: boolean;
  tone?: 'danger' | 'accept';
  rotate?: boolean;
  disabled?: boolean;
}) {
  const bg = tone === 'danger' ? '#E5484D' : tone === 'accept' ? '#1FA971' : on ? '#FFFFFF' : 'rgba(255,255,255,0.16)';
  const fg = on && !tone ? '#0B0C14' : '#FFFFFF';
  const size = tone ? 68 : 56;
  return (
    <View style={{ alignItems: 'center', gap: 6, opacity: disabled ? 0.4 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: on, disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <View style={rotate ? { transform: [{ rotate: '135deg' }] } : undefined}>
          <Icon name={icon} size={tone ? 30 : 24} color={fg} />
        </View>
      </Pressable>
      <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  name: { color: '#FFFFFF', fontSize: 28, fontWeight: '800', textAlign: 'center', letterSpacing: -0.4 },
  status: { color: 'rgba(255,255,255,0.78)', fontSize: 16, fontWeight: '500' },
  self: {
    position: 'absolute',
    right: space[4],
    width: 112,
    height: 160,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  controls: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space[4], gap: space[2] },
});
