'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Avatar, Button, Icon, useModalFocus, type IconName } from '@yapilapi/design-system';
import type { CallInfo } from '@yapilapi/api-client';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';

type Phase = 'idle' | 'incoming' | 'outgoing' | 'active';
interface CallsCtx {
  start: (conversationId: string, kind: 'audio' | 'video') => Promise<void>;
  /** The call on this device now (ringing, calling or going), if any. */
  current: { conversationId: string; kind: 'audio' | 'video' } | null;
}
const Ctx = createContext<CallsCtx>({ start: async () => {}, current: null });
export const useCalls = () => useContext(Ctx);

/**
 * Peer-to-peer calls (mesh, up to 8 people). The API relays offers, answers and
 * ICE candidates over the realtime socket; audio and video never pass through it
 * (a TURN relay carries them when a network blocks direct connections).
 * The caller sends an offer to each person when they answer.
 *
 * The screen shows who you're calling or who's calling you, rings (and buzzes on phones), counts
 * the minutes once you're connected and says "Reconnecting…" while a connection is being repaired.
 */
export function CallsProvider({ children }: { children: React.ReactNode }) {
  const { me, toast, t } = useSession();
  const [call, setCall] = useState<CallInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [remotes, setRemotes] = useState<Record<string, MediaStream>>({});
  // Connection state per person: 'connected', or anything else while it's (re)connecting.
  const [links, setLinks] = useState<Record<string, RTCPeerConnectionState>>({});
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [since, setSince] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [cameras, setCameras] = useState(0);
  const local = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  // The people this device sent the offer to: it's the one to restart the connection if it fails.
  const offered = useRef(new Set<string>());
  // ICE candidates can arrive before the offer or answer they belong to; hold them until then.
  const pending = useRef(new Map<string, RTCIceCandidateInit[]>());
  const ice = useRef<RTCIceServer[]>([]);
  const localVideo = useRef<HTMLVideoElement>(null);
  const callRef = useRef<CallInfo | null>(null);
  // Answering on this device: the server's "answered" for you may arrive before the answer returns.
  const answering = useRef(false);
  const overlay = useRef<HTMLDivElement>(null);
  callRef.current = call;
  // Keep keyboard focus in the call UI while it's up. No Escape: that shouldn't hang up.
  // A voice call while watching together sits in a small bar, so the video and its controls stay usable.
  const pathname = usePathname();
  const compact = !!call && call.kind === 'audio' && phase !== 'idle' && phase !== 'incoming' && !!pathname?.startsWith('/watch/');
  useModalFocus(overlay, phase !== 'idle' && !!call && !compact);

  const cleanup = useCallback(() => {
    peers.current.forEach((p) => p.close());
    peers.current.clear();
    offered.current.clear();
    pending.current.clear();
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    setRemotes({});
    setLinks({});
    setPeople([]);
    setSince(null);
    setCall(null);
    setPhase('idle');
    setMuted(false);
    setCameraOff(false);
    setFacing('user');
  }, []);

  // Who's in the call: names and faces from the chat.
  const conversationId = call?.conversationId;
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    api.conversations.get(conversationId).then(
      (r) => live && setPeople(r.conversation.members),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [conversationId]);

  async function getMedia(kind: 'audio' | 'video') {
    local.current = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: kind === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    if (localVideo.current) localVideo.current.srcObject = local.current;
    if (kind === 'video')
      void navigator.mediaDevices
        .enumerateDevices()
        .then((d) => setCameras(d.filter((x) => x.kind === 'videoinput').length))
        .catch(() => {});
  }
  // Your own camera: the preview appears once the call screen (and its video element) does.
  useEffect(() => {
    if (localVideo.current && local.current && localVideo.current.srcObject !== local.current) localVideo.current.srcObject = local.current;
  }, [phase, call, remotes]);

  /** Send a fresh offer to someone (`restart` repairs a connection that failed, over new routes). */
  const offerTo = useCallback(async (callId: string, pc: RTCPeerConnection, userId: string, restart = false) => {
    offered.current.add(userId);
    const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    await api.calls.signal(callId, userId, 'offer', offer);
  }, []);

  const peerFor = useCallback(
    (callId: string, userId: string) => {
      let pc = peers.current.get(userId);
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers: ice.current });
      local.current?.getTracks().forEach((t) => pc!.addTrack(t, local.current!));
      pc.onicecandidate = (e) => e.candidate && void api.calls.signal(callId, userId, 'candidate', e.candidate.toJSON()).catch(() => {});
      pc.ontrack = (e) => setRemotes((r) => ({ ...r, [userId]: e.streams[0] ?? new MediaStream([e.track]) }));
      let restarts = 0;
      pc.onconnectionstatechange = () => {
        const state = pc!.connectionState;
        setLinks((l) => ({ ...l, [userId]: state }));
        if (state === 'connected') {
          restarts = 0;
          setSince((s) => s ?? Date.now());
        }
        // A network change (Wi-Fi to mobile data) or a blocked route: try new routes twice before giving up.
        if (state === 'failed') {
          if (offered.current.has(userId) && restarts < 2) {
            restarts++;
            void offerTo(callId, pc!, userId, true).catch(() => {});
          } else if (!offered.current.has(userId) && restarts < 2) restarts++;
          else toast(t('m.calls.dropped'));
        }
      };
      peers.current.set(userId, pc);
      return pc;
    },
    [toast, t, offerTo],
  );

  const start = useCallback(
    async (conversationId: string, kind: 'audio' | 'video') => {
      // Microphone (and camera) first, as on the phone: the other person's phone only rings once
      // we can actually talk. Anything failing after the call exists ends it for them too.
      let started: string | null = null;
      try {
        await getMedia(kind);
        const r = await api.calls.start(conversationId, kind);
        started = r.call.id;
        ice.current = r.iceServers;
        setCall(r.call);
        setPhase('outgoing');
      } catch (e) {
        toast(e instanceof DOMException ? t(kind === 'video' ? 'calls.allowToCall' : 'calls.allowMicToCall') : errorMessage(e));
        if (started) await api.calls.end(started).catch(() => {});
        cleanup();
      }
    },
    [cleanup, toast, t],
  );

  async function answer() {
    if (!call) return;
    answering.current = true;
    try {
      // Camera and microphone first, so the caller's offer (sent as soon as we answer) finds them ready.
      await getMedia(call.kind);
      ice.current = (await api.calls.get(call.id)).iceServers;
      const r = await api.calls.answer(call.id);
      ice.current = r.iceServers;
      setPhase('active');
    } catch (e) {
      toast(e instanceof DOMException ? t(call.kind === 'video' ? 'calls.allowToAnswer' : 'calls.allowMicToAnswer') : errorMessage(e));
      await api.calls.decline(call.id).catch(() => {});
      cleanup();
    } finally {
      answering.current = false;
    }
  }

  async function hangUp() {
    if (call) await api.calls.end(call.id).catch(() => {});
    cleanup();
  }

  function toggleMute() {
    local.current?.getAudioTracks().forEach((t) => (t.enabled = muted));
    setMuted(!muted);
  }

  function toggleCamera() {
    local.current?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
    setCameraOff(!cameraOff);
  }

  /** Front or back camera on phones: the new camera's picture replaces the old one for everyone. */
  async function switchCamera() {
    const stream = local.current;
    if (!stream) return;
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } } });
      const track = fresh.getVideoTracks()[0]!;
      track.enabled = !cameraOff;
      for (const pc of peers.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        await sender?.replaceTrack(track);
      }
      stream.getVideoTracks().forEach((old) => {
        stream.removeTrack(old);
        old.stop();
      });
      stream.addTrack(track);
      if (localVideo.current) localVideo.current.srcObject = stream;
      setFacing(next);
    } catch {
      /* no other camera */
    }
  }

  useRealtime(async (e) => {
    const cur = callRef.current;
    if (e.type === 'call.incoming') {
      // Already on a call: the caller hears that you're busy.
      if (cur) return void api.calls.decline(e.data.id, true).catch(() => {});
      setCall(e.data);
      setPhase('incoming');
      return;
    }
    if (!cur || e.data?.callId !== cur.id) return;
    // Answered on your other device: this one stops ringing.
    if (e.type === 'call.answered' && e.data.userId === me?.id && phase === 'incoming' && !answering.current) {
      toast(t('calls.answeredElsewhere'));
      cleanup();
      return;
    }
    // Someone joined: everyone already in the call (the caller included) connects to them, so in a
    // group each person reaches every other.
    if (e.type === 'call.answered' && e.data.userId !== me?.id && (phase === 'active' || cur.callerId === me?.id)) {
      setPhase('active');
      await offerTo(cur.id, peerFor(cur.id, e.data.userId), e.data.userId);
    }
    // The call is over for everyone (the last other person left, or nobody answered).
    if (e.type === 'call.ended') {
      if (phase !== 'idle')
        toast(
          e.data.status === 'missed'
            ? t(phase === 'incoming' ? 'm.calls.missed' : 'm.calls.noAnswer')
            : e.data.status === 'declined'
              ? t('m.calls.declined')
              : t('m.calls.ended'),
        );
      cleanup();
      return;
    }
    if (e.type === 'call.signal') {
      const pc = peerFor(cur.id, e.data.from);
      const flush = async () => {
        for (const c of pending.current.get(e.data.from) ?? []) await pc.addIceCandidate(c).catch(() => {});
        pending.current.delete(e.data.from);
      };
      if (e.data.type === 'offer') {
        await pc.setRemoteDescription(e.data.data);
        await flush();
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await api.calls.signal(cur.id, e.data.from, 'answer', ans);
      } else if (e.data.type === 'answer') {
        await pc.setRemoteDescription(e.data.data);
        await flush();
      } else if (e.data.type === 'candidate') {
        if (pc.remoteDescription) await pc.addIceCandidate(e.data.data).catch(() => {});
        else pending.current.set(e.data.from, [...(pending.current.get(e.data.from) ?? []), e.data.data]);
      }
    }
    if (e.type === 'call.declined' || e.type === 'call.left') {
      peers.current.get(e.data.userId)?.close();
      peers.current.delete(e.data.userId);
      setRemotes((r) => {
        const n = { ...r };
        delete n[e.data.userId];
        return n;
      });
      if (cur.participants.length === 2) {
        toast(e.type === 'call.declined' ? (e.data.busy ? t('calls.otherBusy') : t('m.calls.declined')) : t('m.calls.ended'));
        cleanup();
      }
    }
  });

  // Ringing times out on the server after 45 seconds; mirror it here.
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing') return;
    const id = setTimeout(() => {
      toast(phase === 'incoming' ? t('m.calls.missed') : t('m.calls.noAnswer'));
      void hangUp();
    }, 45_000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // The ring: a ringtone (and a buzz on phones) for a call coming in, the ringback tone while calling.
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing') return;
    return ring(phase);
  }, [phase]);

  // The minutes on the call, once someone is connected.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);

  const others = people.filter((p) => p.id !== me?.id && (call?.participants.includes(p.id) || p.id === call?.callerId));
  const caller = people.find((p) => p.id === call?.callerId);
  const shown = phase === 'incoming' && caller ? [caller] : others;
  const names = shown.map((p) => p.displayName).join(', ') || t('m.calls.someone');
  const connected = Object.values(links).some((s) => s === 'connected');
  const repairing = !!since && !connected;
  const status =
    phase === 'incoming'
      ? t(call?.kind === 'video' ? 'm.calls.incoming.video' : 'm.calls.incoming.audio')
      : phase === 'outgoing'
        ? t('m.calls.calling')
        : repairing
          ? t('calls.reconnecting')
          : since
            ? clock(Date.now() - since)
            : t('m.calls.connecting');
  const showVideo = call?.kind === 'video' && phase === 'active' && Object.keys(remotes).length > 0;

  return (
    <Ctx.Provider value={{ start, current: call && phase !== 'idle' ? { conversationId: call.conversationId, kind: call.kind } : null }}>
      {children}
      {compact && call ? (
        <div className="call-bar" role="region" aria-label={t('m.calls.call')}>
          {Object.entries(remotes).map(([uid, stream]) => (
            <RemoteVideo key={uid} stream={stream} audioOnly />
          ))}
          <Icon name="phone" size={18} />
          <span className="call-bar__status" role="status">
            {names} · {status}
          </span>
          <Button size="sm" variant="secondary" onClick={toggleMute}>
            {muted ? t('m.calls.unmute') : t('m.calls.mute')}
          </Button>
          <Button size="sm" variant="danger" onClick={hangUp}>
            {t('m.calls.hangUp')}
          </Button>
        </div>
      ) : phase !== 'idle' && call ? (
        <div
          className={`call${showVideo ? ' call--video' : ''}`}
          role="dialog"
          aria-modal
          aria-label={phase === 'incoming' ? t('calls.incoming') : t('m.calls.call')}
          aria-describedby="call-status"
          ref={overlay}
          tabIndex={-1}
        >
          {showVideo ? (
            <div className="call__grid" data-count={Object.keys(remotes).length}>
              {Object.entries(remotes).map(([uid, stream]) => (
                <RemoteVideo key={uid} stream={stream} audioOnly={false} />
              ))}
            </div>
          ) : (
            // Voice calls (and video ones until the picture arrives): who it is, big.
            <>
              {Object.entries(remotes).map(([uid, stream]) => (
                <RemoteVideo key={uid} stream={stream} audioOnly />
              ))}
            </>
          )}
          <div className="call__who">
            {!showVideo ? (
              <span className={`call__faces${phase === 'incoming' || phase === 'outgoing' ? ' call__faces--ringing' : ''}`} aria-hidden>
                {(shown.length ? shown : [null]).slice(0, 3).map((p, i) => (
                  <Avatar key={p?.id ?? i} name={p?.displayName ?? t('m.calls.someone')} src={p?.avatarUrl} size="xl" />
                ))}
              </span>
            ) : null}
            <bdi className="call__name">{names}</bdi>
            <p className="call__status" id="call-status" role="status">
              {status}
            </p>
          </div>
          {call.kind === 'video' && phase !== 'incoming' ? (
            <video
              ref={localVideo}
              className={`call__self${facing === 'user' ? ' call__self--mirror' : ''}`}
              autoPlay
              muted
              playsInline
              aria-label={t('m.calls.yourCamera')}
            />
          ) : null}
          {phase === 'incoming' ? (
            <div className="call__controls">
              <CallButton
                icon="phone"
                label={t('m.common.decline')}
                tone="end"
                onClick={async () => (await api.calls.decline(call.id).catch(() => {}), cleanup())}
              />
              <CallButton icon={call.kind === 'video' ? 'video' : 'phone'} label={t('m.calls.answer')} tone="answer" onClick={() => void answer()} />
            </div>
          ) : (
            <div className="call__controls">
              <CallButton icon={muted ? 'mic-off' : 'mic'} label={muted ? t('m.calls.unmute') : t('m.calls.mute')} pressed={muted} onClick={toggleMute} />
              {call.kind === 'video' ? (
                <CallButton
                  icon="video"
                  label={cameraOff ? t('m.calls.cameraOn') : t('m.calls.cameraOff')}
                  pressed={cameraOff}
                  struck={cameraOff}
                  onClick={toggleCamera}
                />
              ) : null}
              {call.kind === 'video' && cameras > 1 ? <CallButton icon="switch" label={t('m.calls.switchCamera')} onClick={() => void switchCamera()} /> : null}
              <CallButton icon="phone" label={t('m.calls.hangUp')} tone="end" onClick={() => void hangUp()} />
            </div>
          )}
        </div>
      ) : null}
    </Ctx.Provider>
  );
}

/** A round call button with its name under it. */
function CallButton({
  icon,
  label,
  onClick,
  tone,
  pressed,
  struck,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: 'answer' | 'end';
  pressed?: boolean;
  struck?: boolean;
}) {
  return (
    <button
      type="button"
      className={`call__btn${tone ? ` call__btn--${tone}` : ''}${struck ? ' call__btn--struck' : ''}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="call__btn-face" aria-hidden>
        <Icon name={icon} size={26} />
      </span>
      <span className="call__btn-label">{label}</span>
    </button>
  );
}

function RemoteVideo({ stream, audioOnly }: { stream: MediaStream; audioOnly: boolean }) {
  const { t } = useSession();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    // iPhones can hold back playback that wasn't started by a tap: ask again.
    void v.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} autoPlay playsInline className={audioOnly ? 'call__audio' : 'call__remote'} aria-label={t('calls.participant')} />;
}

/** 0:42, 12:05, 1:02:09. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The sound of a call ringing, made in the browser: a two-tone ringtone with a buzz for a call
 * coming in, the long ringback tone while you call. Returns a function that stops it. Silent where
 * the browser won't play sound before a tap (the screen still shows the call).
 */
function ring(kind: 'incoming' | 'outgoing'): () => void {
  let audio: AudioContext | null = null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audio = AC ? new AC() : null;
  } catch {
    audio = null;
  }
  const beep = (freqs: number[], seconds: number, volume: number) => {
    if (!audio || audio.state === 'closed') return;
    const at = audio.currentTime;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.02);
    gain.gain.setValueAtTime(volume, at + seconds - 0.05);
    gain.gain.linearRampToValueAtTime(0, at + seconds);
    gain.connect(audio.destination);
    for (const f of freqs) {
      const osc = audio.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + seconds);
    }
  };
  const once = () => {
    if (kind === 'incoming') {
      beep([660, 880], 0.4, 0.12);
      setTimeout(() => beep([660, 880], 0.4, 0.12), 550);
      try {
        navigator.vibrate?.([400, 150, 400]);
      } catch {
        /* no vibration */
      }
    } else beep([440, 480], 1.6, 0.06);
  };
  once();
  const timer = setInterval(once, kind === 'incoming' ? 2200 : 4000);
  return () => {
    clearInterval(timer);
    try {
      navigator.vibrate?.(0);
    } catch {
      /* no vibration */
    }
    void audio?.close().catch(() => {});
  };
}
