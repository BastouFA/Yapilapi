import * as Notifications from 'expo-notifications';
import { LinearGradient } from 'expo-linear-gradient';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, Easing, Linking, Modal, Platform, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import type { CallInfo } from '../../../packages/api-client/src/index';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { tr } from './locale';
import { configureCallNotifications } from './push';
import { useRealtime, useSession } from './session';
import { useMicInUse } from './yaps';
import { useReducedMotion } from './motion';
import { gradient, radius, space } from './theme';
import { Avatar, Icon, useColors, userText, type IconName } from './ui';
import { audio, callsSupported, rtc } from './webrtc';

type Phase = 'idle' | 'incoming' | 'outgoing' | 'active';
type Kind = 'audio' | 'video';
type SignalData = Record<string, unknown>;
type Person = { id: string; name: string; avatarUrl: string | null };

interface CallsCtx {
  /** Start a call in a conversation. Resolves once ringing (or after explaining why it can't). */
  start: (conversationId: string, kind: Kind) => Promise<void>;
  supported: boolean;
}
const Ctx = createContext<CallsCtx>({ start: async () => {}, supported: false });
export const useCalls = () => useContext(Ctx);

const RING_MS = 45_000;
// Two buzzes every 2.2 seconds while a call rings, like the web app. Android reads the pattern as
// wait, buzz, wait, buzz…; iPhones buzz for a fixed 400 ms and read it as the pauses between buzzes.
const RING_BUZZ = Platform.OS === 'android' ? [0, 400, 150, 400, 1250] : [0, 550, 1650];

class PermissionError extends Error {}
class UnsupportedError extends Error {}

function explain(e: unknown, action: 'call' | 'answer') {
  if (e instanceof UnsupportedError) return Alert.alert(tr('m.calls.unsupported.title'), tr('m.calls.unsupported.body'));
  if (e instanceof PermissionError)
    return Alert.alert(e.message, tr('m.calls.blocked.body'), [
      { text: tr('m.common.notNow'), style: 'cancel' },
      { text: tr('m.common.openSettings'), onPress: () => void Linking.openSettings() },
    ]);
  Alert.alert(action === 'call' ? tr('m.calls.startFailed') : tr('m.calls.answerFailed'), errorMessage(e));
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
  const { t, lang } = useT();
  const [call, setCall] = useState<CallInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  // Yaps don't play out loud during a call (or while one rings).
  useMicInUse(phase !== 'idle');
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [frontCamera, setFrontCamera] = useState(true);
  const [speaker, setSpeaker] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // Connection state per person: 'connected', or anything else while it's (re)connecting.
  const [links, setLinks] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, Person>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const localRef = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  // The people this phone sent the offer to: it's the one to restart the connection if it fails.
  const offered = useRef(new Set<string>());
  const pendingCandidates = useRef(new Map<string, SignalData[]>());
  const ice = useRef<RTCIceServer[]>([]);
  const callRef = useRef<CallInfo | null>(null);
  callRef.current = call;
  const starting = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  // This device is in the call: it placed it, or you answered here. Every device you're signed in on
  // rings and gets the signals, and only this one may reply: another that replied too could beat you
  // to it, and the caller would end up connected to a screen nobody's looking at.
  const joined = useRef(false);
  phaseRef.current = phase;

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 3500);
  }, []);

  const cleanup = useCallback(() => {
    joined.current = false;
    callRef.current = null;
    peers.current.forEach((p) => p.close());
    peers.current.clear();
    offered.current.clear();
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
    setLinks({});
    setNames({});
    setKeepAlive(false);
  }, [setKeepAlive]);

  /** Camera and microphone. A call without a microphone is not a call, so that is required. */
  async function getMedia(kind: Kind) {
    if (!rtc) throw new UnsupportedError();
    let stream: MediaStream;
    try {
      stream = await rtc.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' ? { facingMode: 'user' } : false });
    } catch {
      throw new PermissionError(kind === 'video' ? tr('m.calls.blocked.both') : tr('m.calls.blocked.mic'));
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      stream.release();
      throw new PermissionError(tr('m.calls.blocked.mic'));
    }
    if (kind === 'video' && !stream.getVideoTracks().length) {
      setCameraOff(true);
      flash(tr('m.calls.cameraBlocked'));
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
      setNames(Object.fromEntries(conversation.members.map((m) => [m.id, { id: m.id, name: m.displayName, avatarUrl: m.avatarUrl }])));
    } catch {
      /* names are a nicety */
    }
  }, []);

  /** Send a fresh offer to someone (`restart` repairs a connection that failed, over new routes). */
  const offerTo = useCallback(async (callId: string, pc: RTCPeerConnection, userId: string, restart = false) => {
    offered.current.add(userId);
    const offer = await pc.createOffer(restart ? { iceRestart: true } : {});
    await pc.setLocalDescription(offer);
    await (await client()).calls.signal(callId, userId, 'offer', { type: offer.type, sdp: offer.sdp });
  }, []);

  const peerFor = useCallback(
    (callId: string, userId: string) => {
      let pc = peers.current.get(userId);
      if (pc) return pc;
      const RTC = rtc!;
      // The API's servers as they come (STUN, TURN with several urls each). The package rewrites the
      // objects it's given, so each connection gets its own copies.
      const iceServers = ice.current.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }));
      const created = new RTC.RTCPeerConnection({ iceServers: iceServers as never });
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
      let restarts = 0;
      created.onconnectionstatechange = () => {
        const state = created.connectionState;
        // A connection replaced or closed after the person left says nothing about the call.
        if (peers.current.get(userId) !== created) return;
        setLinks((l) => ({ ...l, [userId]: state }));
        if (state === 'connected') {
          restarts = 0;
          setConnectedAt((t) => t ?? Date.now());
        }
        // A network change (Wi-Fi to mobile data) or a blocked route: the side that sent the offer
        // tries new routes twice before giving up; the other side waits for those offers.
        if (state === 'failed') {
          if (restarts < 2) {
            restarts++;
            if (offered.current.has(userId)) void offerTo(callId, created, userId, true).catch(() => {});
          } else flash(tr('m.calls.dropped'));
        }
      };
      peers.current.set(userId, created);
      return created;
    },
    [flash, offerTo],
  );

  async function flushCandidates(userId: string, pc: RTCPeerConnection) {
    const queued = pendingCandidates.current.get(userId) ?? [];
    pendingCandidates.current.delete(userId);
    for (const c of queued) await pc.addIceCandidate(new rtc!.RTCIceCandidate(c as never)).catch(() => {});
  }

  const start = useCallback(
    async (conversationId: string, kind: Kind) => {
      if (callRef.current || starting.current) return void Alert.alert(tr('m.calls.busy'));
      starting.current = true;
      try {
        await getMedia(kind);
        const r = await (await client()).calls.start(conversationId, kind);
        ice.current = r.iceServers;
        joined.current = true;
        callRef.current = r.call;
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
    stopRinging();
    joined.current = true;
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

  // The ringtone (when the native audio module is there) and a buzz until the call is answered or over.
  const ringIncoming = useCallback(
    (c: CallInfo) => {
      // Now, not at the next render: the events after this one mustn't miss it.
      callRef.current = c;
      setCall(c);
      setPhase('incoming');
      void loadNames(c);
      audio.ring();
      Vibration.vibrate(RING_BUZZ, true);
    },
    [loadNames],
  );
  function stopRinging() {
    audio.stopRing();
    Vibration.cancel();
  }

  useRealtime(async (e) => {
    if (!me) return;
    if (!rtc) {
      // Without WebRTC we can still show the ring screen, which explains what is needed.
      if (e.type === 'call.incoming' && !callRef.current) ringIncoming(e.data);
      if (callRef.current && e.data?.callId === callRef.current.id && ['call.left', 'call.declined', 'call.ended'].includes(e.type)) cleanup();
      return;
    }
    const cur = callRef.current;
    if (e.type === 'call.incoming') {
      if (cur)
        return void client().then(
          (api) => api.calls.decline(e.data.id, true).catch(() => {}),
          () => {},
        ); // busy: the caller is told you're on another call
      ringIncoming(e.data);
      return;
    }
    if (!cur || e.data?.callId !== cur.id) return;
    try {
      // Someone joined: everyone already in the call (the caller included) connects to them, so in a
      // group each person reaches every other.
      if (e.type === 'call.answered' && e.data.userId !== me.id) {
        if (cur.callerId !== me.id && phaseRef.current !== 'active') return;
        setPhase('active');
        await offerTo(cur.id, peerFor(cur.id, e.data.userId), e.data.userId);
      }
      if (e.type === 'call.answered' && e.data.userId === me.id && !joined.current) {
        // Answered on another device.
        cleanup();
        return;
      }
      if (e.type === 'call.signal') {
        if (!joined.current) return;
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
          // Only one answer fits an offer: an old app on another device may still send a second.
          if (pc.signalingState !== 'have-local-offer') return;
          await pc.setRemoteDescription(new rtc.RTCSessionDescription(data as never));
          await flushCandidates(from, pc);
        } else if (e.data.type === 'candidate') {
          if (pc.remoteDescription) await pc.addIceCandidate(new rtc.RTCIceCandidate(data as never)).catch(() => {});
          else pendingCandidates.current.set(from, [...(pendingCandidates.current.get(from) ?? []), data]);
        }
      }
      // The call is over for everyone (the last other person left, or nobody answered).
      if (e.type === 'call.ended') {
        const was = phaseRef.current;
        flash(
          e.data.status === 'missed'
            ? tr(was === 'incoming' ? 'm.calls.missed' : 'm.calls.noAnswer')
            : e.data.status === 'declined'
              ? tr('m.calls.declined')
              : tr('m.calls.ended'),
        );
        cleanup();
        return;
      }
      if (e.type === 'call.declined' || e.type === 'call.left') {
        const uid = e.data.userId as string;
        if (uid === me.id) {
          // Declined or ended on another of my devices.
          if (phaseRef.current === 'incoming') cleanup();
          return;
        }
        const pc = peers.current.get(uid);
        peers.current.delete(uid);
        pc?.close();
        offered.current.delete(uid);
        const without = <T,>(r: Record<string, T>) => {
          const n = { ...r };
          delete n[uid];
          return n;
        };
        setRemotes(without);
        setLinks(without);
        if (cur.participants.length === 2) {
          flash(e.type === 'call.declined' ? (e.data.busy ? tr('calls.otherBusy') : tr('m.calls.declined')) : tr('m.calls.ended'));
          cleanup();
        }
      }
    } catch {
      flash(tr('m.calls.problem'));
    }
  });

  // Ringing times out on the server after 45 seconds; mirror it here, like the web app.
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing') return;
    const id = setTimeout(() => {
      flash(phase === 'incoming' ? tr('m.calls.missed') : tr('m.calls.noAnswer'));
      void hangUp();
    }, RING_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Push: the call_incoming category (Answer / Decline, in the app's language) and taps on call notifications.
  useEffect(() => {
    void configureCallNotifications();
  }, [lang]);
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
        if (c.status !== 'ringing') return flash(tr('m.calls.missed'));
        ringIncoming(c);
        if (resp.actionIdentifier === 'answer') void answer(c);
      } catch {
        flash(tr('m.calls.over'));
      }
    };
    // Offline or signed out in the meantime: nothing to open (and no unhandled failure).
    void Notifications.getLastNotificationResponseAsync()
      .then(handle)
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => void handle(r).catch(() => {}));
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, flash, ringIncoming]);

  // Who's in the call, from the chat: the caller while it rings here, everyone else once it's going.
  const someone = (id: string): Person => names[id] ?? { id, name: t('m.calls.someone'), avatarUrl: null };
  const others = call ? [...new Set([call.callerId, ...call.participants])].filter((id) => id !== me?.id) : [];
  const shown = (phase === 'incoming' && call && call.callerId !== me?.id ? [call.callerId] : others).map(someone);
  const connected = Object.values(links).some((l) => l === 'connected');

  /** Front or back camera: the same track switches over, so nothing needs renegotiating. */
  async function flipCamera() {
    const track = localRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = frontCamera ? 'environment' : 'user';
    try {
      await track.applyConstraints({ facingMode: next });
    } catch {
      return; // one camera only
    }
    setFrontCamera((track.getSettings().facingMode ?? next) === 'user');
  }

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
            people={shown}
            local={local}
            remotes={remotes}
            muted={muted}
            cameraOff={cameraOff}
            frontCamera={frontCamera}
            speaker={speaker}
            connectedAt={connectedAt}
            repairing={!!connectedAt && !connected}
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
            onFlip={() => void flipCamera()}
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
    <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, start: 16, end: 16, alignItems: 'center' }}>
      <View accessibilityLiveRegion="polite" style={{ backgroundColor: c.ink, borderRadius: radius.full, paddingHorizontal: 18, paddingVertical: 10 }}>
        <Text style={{ color: c.ground, fontWeight: '600' }}>{text}</Text>
      </View>
    </View>
  );
}

/** 0:42, 12:05, 1:02:09. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? clock(now - since) : null;
}

function CallView(p: {
  call: CallInfo;
  phase: Phase;
  people: Person[];
  local: MediaStream | null;
  remotes: Record<string, MediaStream>;
  muted: boolean;
  cameraOff: boolean;
  frontCamera: boolean;
  speaker: boolean;
  connectedAt: number | null;
  repairing: boolean;
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
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const elapsed = useElapsed(p.connectedAt);
  const video = p.call.kind === 'video';
  const remote = Object.values(p.remotes).find((s) => s.getVideoTracks().length);
  const RTCView = rtc?.RTCView;
  // A video call fills the screen with the other person's picture once it arrives; until then (and
  // for voice calls) it's their faces, big, in the middle.
  const showVideo = video && !!remote && !!RTCView && p.phase === 'active';
  const ringing = p.phase === 'incoming' || p.phase === 'outgoing';
  const title = p.people.map((x) => x.name).join(', ') || t('m.calls.someone');
  const status =
    p.phase === 'incoming'
      ? t(video ? 'm.calls.incoming.video' : 'm.calls.incoming.audio')
      : p.phase === 'outgoing'
        ? t('m.calls.calling')
        : p.repairing
          ? t('calls.reconnecting')
          : (elapsed ?? t('m.calls.connecting'));
  const faces = p.people.length ? p.people.slice(0, 3) : [{ id: '', name: title, avatarUrl: null }];
  const faceSize = faces.length > 1 ? 88 : 112;

  return (
    <View style={{ flex: 1, backgroundColor: '#0B0C14' }}>
      {showVideo && remote && RTCView ? (
        <RTCView streamURL={remote.toURL()} objectFit="cover" zOrder={0} style={StyleSheet.absoluteFill} accessibilityLabel={title} />
      ) : (
        <LinearGradient colors={['#3A1624', '#151726', '#0B0C14']} style={StyleSheet.absoluteFill} />
      )}

      {showVideo ? (
        // Name and time in a pill at the top, over the picture.
        <View style={{ paddingTop: insets.top + space[3], alignItems: 'center', paddingHorizontal: space[4] }}>
          <View style={s.pill}>
            <Text style={[s.pillName, userText]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={s.pillStatus} accessibilityLiveRegion="polite">
              {status}
            </Text>
          </View>
          {p.notice ? <Text style={[s.status, s.notice]}>{p.notice}</Text> : null}
        </View>
      ) : (
        <View
          style={{ flex: 1, paddingTop: insets.top + space[6], alignItems: 'center', justifyContent: 'center', gap: space[3], paddingHorizontal: space[6] }}
        >
          <View style={{ flexDirection: 'row', marginBottom: space[3] }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {faces.map((x, i) => (
              <Face key={x.id || i} person={x} size={faceSize} ringing={ringing} first={i === 0} />
            ))}
          </View>
          <Text style={[s.name, userText]} numberOfLines={2}>
            {title}
          </Text>
          <Text style={s.status} accessibilityLiveRegion="polite">
            {status}
          </Text>
          {p.notice ? <Text style={[s.status, s.notice]}>{p.notice}</Text> : null}
          {!callsSupported ? <Text style={[s.status, { textAlign: 'center' }]}>{t('m.calls.unsupported.note')}</Text> : null}
        </View>
      )}

      {video && p.local && RTCView && !p.cameraOff && p.phase !== 'incoming' ? (
        <View style={[s.self, { bottom: insets.bottom + 150 }]}>
          <RTCView
            streamURL={p.local.toURL()}
            mirror={p.frontCamera}
            objectFit="cover"
            zOrder={1}
            style={{ flex: 1 }}
            accessibilityLabel={t('m.calls.yourCamera')}
          />
        </View>
      ) : null}

      {showVideo ? <View style={{ flex: 1 }} /> : null}

      {p.phase === 'incoming' ? (
        <View style={[s.controls, { paddingBottom: insets.bottom + space[8], justifyContent: 'space-evenly' }]}>
          <RoundButton label={t('m.common.decline')} icon="call" rotate tone="danger" onPress={p.onDecline} />
          {callsSupported ? <RoundButton label={t('m.calls.answer')} icon={video ? 'videocam' : 'call'} tone="accept" onPress={p.onAnswer} /> : null}
        </View>
      ) : (
        <View style={[s.controls, { paddingBottom: insets.bottom + space[6] }]}>
          <RoundButton label={p.muted ? t('m.calls.unmute') : t('m.calls.mute')} icon={p.muted ? 'mic-off' : 'mic'} on={p.muted} onPress={p.onMute} />
          {video ? (
            <RoundButton
              label={p.cameraOff ? t('m.calls.cameraOn') : t('m.calls.cameraOff')}
              icon={p.cameraOff ? 'videocam-off' : 'videocam'}
              on={p.cameraOff}
              onPress={p.onCamera}
            />
          ) : null}
          {video ? <RoundButton label={t('m.calls.switchCamera')} icon="camera-reverse" onPress={p.onFlip} disabled={p.cameraOff} /> : null}
          <RoundButton
            label={p.speaker ? t('m.calls.speakerOff') : t('m.calls.speaker')}
            icon={p.speaker ? 'volume-high' : 'ear'}
            on={p.speaker}
            onPress={p.onSpeaker}
          />
          <RoundButton label={t('m.calls.hangUp')} icon="call" rotate tone="danger" onPress={p.onHangUp} />
        </View>
      )}
      <View pointerEvents="none" style={{ position: 'absolute', start: 0, end: 0, bottom: 0, height: 4 }}>
        <LinearGradient {...gradient(c)} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/** A face in the call; while it rings, a ring in the brand colour pulses out from it (not with Reduce Motion). */
function Face({ person, size, ringing, first }: { person: Person; size: number; ringing: boolean; first: boolean }) {
  const c = useColors();
  const reduce = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  const animate = ringing && !reduce;
  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [animate, pulse]);
  const ring = size + 8;
  return (
    <View style={{ width: ring, height: ring, marginStart: first ? 0 : -16, alignItems: 'center', justifyContent: 'center' }}>
      {animate ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            backgroundColor: c.yapi,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, (ring + 48) / ring] }) }],
          }}
        />
      ) : null}
      <View style={{ width: ring, height: ring, borderRadius: ring / 2, backgroundColor: '#0B0C14', alignItems: 'center', justifyContent: 'center' }}>
        <Avatar name={person.name} url={person.avatarUrl} size={size} />
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
    // Each button takes an equal share of the row, so five fit on a small phone and long labels wrap.
    <View style={{ flex: 1, maxWidth: 88, alignItems: 'center', gap: 6, opacity: disabled ? 0.4 : 1 }}>
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
      <Text
        style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600', textAlign: 'center' }}
        numberOfLines={2}
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        {label}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  name: { color: '#FFFFFF', fontSize: 28, fontWeight: '800', textAlign: 'center', letterSpacing: -0.4 },
  status: { color: 'rgba(255,255,255,0.78)', fontSize: 16, fontWeight: '500', fontVariant: ['tabular-nums'] },
  notice: { color: '#FFBE3D', textAlign: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    maxWidth: '100%',
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  pillName: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  pillStatus: { color: 'rgba(255,255,255,0.78)', fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
  self: {
    position: 'absolute',
    end: space[4],
    width: 112,
    height: 160,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  controls: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space[4], gap: space[2] },
});
