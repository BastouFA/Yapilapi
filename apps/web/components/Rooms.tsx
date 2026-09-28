'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button } from '@yapilapi/design-system';
import {
  ROOM_HEARTBEAT_MS,
  ROOM_SPEAKING_LEVEL,
  roomMeshLinks,
  speechLevel,
  type RoomDetail,
  type RoomMediaSession,
  type RoomReaction,
  type RoomSignalData,
  type MessageKey,
  type PluralKey,
} from '@yapilapi/shared';
import type { RoomEnvelope } from '@yapilapi/api-client';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';

// The room screen and a community's rooms are in RoomView.tsx: this file is in every page's
// layout, so it keeps only what stays connected while you browse.

/** Labels for the reaction icons (screen readers and tooltips). */
export const REACTION_LABEL: Record<RoomReaction, MessageKey> = {
  heart: 'm.rooms.react.heart',
  star: 'm.rooms.react.star',
  sparkle: 'm.rooms.react.sparkle',
  check: 'm.rooms.react.check',
  music: 'm.rooms.react.music',
};

export type T = (key: MessageKey, vars?: Record<string, string | number>) => string;
export type TP = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

/** "Ama, Kofi and Lea" in the reader's language. */
export const nameList = (names: string[], locale: string) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);

interface Floating {
  id: number;
  kind: RoomReaction;
}

interface RoomsCtx {
  /** The room you're in, as everyone in it sees it. */
  room: RoomDetail | null;
  canHost: boolean;
  /** People whose audio is above the speaking level right now. */
  speaking: ReadonlySet<string>;
  reactions: Floating[];
  joining: string | null;
  join: (id: string) => Promise<boolean>;
  leave: () => Promise<void>;
  /** Run a room action for the room you're in; errors become a toast. */
  act: (fn: (roomId: string) => Promise<unknown>) => Promise<boolean>;
}

const Ctx = createContext<RoomsCtx>({
  room: null,
  canHost: false,
  speaking: new Set(),
  reactions: [],
  joining: null,
  join: async () => false,
  leave: async () => {},
  act: async () => false,
});
export const useRooms = () => useContext(Ctx);

interface Peer {
  pc: RTCPeerConnection;
  sid: string;
  /** roomMeshLinks key when we offered; 'in' when the other side did. */
  key: string;
}

export const everyone = (r: RoomDetail) => [...r.speakers, ...r.listeners];

/**
 * Audio rooms: the room you're in stays connected while you browse the app
 * (a mini-bar shows it), so the connection lives here, above the pages.
 *
 * Audio is a WebRTC mesh (see packages/shared/src/rooms.ts for the protocol):
 * speakers send to everyone, listeners only receive. The API relays signaling
 * and sends `room.state` whenever anything changes; each client rebuilds its
 * own connections from that state.
 */
export function RoomsProvider({ children }: { children: React.ReactNode }) {
  const { me, toast, t } = useSession();
  const [room, setRoomState] = useState<RoomDetail | null>(null);
  const [canHost, setCanHost] = useState(false);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
  const [reactions, setReactions] = useState<Floating[]>([]);
  const [joining, setJoining] = useState<string | null>(null);

  const roomRef = useRef<RoomDetail | null>(null);
  const meRef = useRef<string | null>(null);
  meRef.current = me?.id ?? null;
  const session = useRef<RoomMediaSession | null>(null);
  const peers = useRef(new Map<string, Peer>());
  const pending = useRef(new Map<string, RTCIceCandidateInit[]>());
  const local = useRef<MediaStream | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const reactionId = useRef(0);

  const setRoom = useCallback((r: RoomDetail | null) => {
    roomRef.current = r;
    setRoomState(r);
  }, []);

  /** Room work runs one step at a time, in order. */
  const enqueue = useCallback((fn: () => Promise<void> | void) => {
    queue.current = queue.current.then(fn).catch(() => {});
    return queue.current;
  }, []);

  const closePeer = useCallback((uid: string) => {
    const p = peers.current.get(uid);
    if (!p) return;
    p.pc.close();
    peers.current.delete(uid);
    pending.current.delete(p.sid);
    setStreams((s) => {
      if (!(uid in s)) return s;
      const n = { ...s };
      delete n[uid];
      return n;
    });
  }, []);

  const teardown = useCallback(() => {
    for (const uid of [...peers.current.keys()]) closePeer(uid);
    pending.current.clear();
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    setLocalStream(null);
    session.current = null;
    setRoom(null);
    setCanHost(false);
    setSpeaking(new Set());
  }, [closePeer, setRoom]);

  const sync = useRef<() => Promise<void>>(async () => {});

  const newPeer = useCallback(
    (roomId: string, uid: string, sid: string, key: string): Peer => {
      const s = session.current!;
      const pc = new RTCPeerConnection({ iceServers: s.iceServers, iceTransportPolicy: s.iceTransportPolicy });
      if (local.current) local.current.getTracks().forEach((t) => pc.addTrack(t, local.current!));
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.onicecandidate = (e) => {
        if (e.candidate) void api.rooms.signal(roomId, uid, 'candidate', { sid, candidate: e.candidate.toJSON() } satisfies RoomSignalData).catch(() => {});
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        setStreams((cur) => ({ ...cur, [uid]: stream }));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState !== 'failed' || peers.current.get(uid)?.pc !== pc) return;
        // Try again: whoever offers will offer afresh.
        closePeer(uid);
        setTimeout(() => void enqueue(() => sync.current()), 1500);
      };
      const peer = { pc, sid, key };
      peers.current.set(uid, peer);
      return peer;
    },
    [closePeer, enqueue],
  );

  sync.current = async () => {
    const r = roomRef.current;
    const meId = meRef.current;
    if (!r || r.status !== 'live' || !meId || !session.current) return;
    const people = everyone(r);
    const mine = people.find((p) => p.user.id === meId);
    if (!mine) return;
    // The microphone is only open while you're a speaker.
    if (mine.role === 'speaker' && !local.current) {
      try {
        local.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        setLocalStream(local.current);
      } catch {
        toast(t('m.rooms.micBlocked'));
        await api.rooms.toListener(r.id, meId).catch(() => {});
        return;
      }
    }
    if (mine.role === 'listener' && local.current) {
      local.current.getTracks().forEach((t) => t.stop());
      local.current = null;
      setLocalStream(null);
    }
    local.current?.getAudioTracks().forEach((t) => (t.enabled = !mine.muted));
    const links = roomMeshLinks(meId, people);
    const want = new Set(links.map((l) => l.userId));
    for (const uid of [...peers.current.keys()]) if (!want.has(uid)) closePeer(uid);
    for (const l of links) {
      if (!l.offer) continue; // They offer; their offer replaces whatever we have.
      const cur = peers.current.get(l.userId);
      if (cur && cur.key === l.key) continue;
      if (cur) closePeer(l.userId);
      const sid = crypto.randomUUID();
      const peer = newPeer(r.id, l.userId, sid, l.key);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await api.rooms
        .signal(r.id, l.userId, 'offer', { sid, description: { type: 'offer', sdp: offer.sdp } } satisfies RoomSignalData)
        .catch(() => closePeer(l.userId));
    }
  };

  async function flush(peer: Peer) {
    for (const c of pending.current.get(peer.sid) ?? []) await peer.pc.addIceCandidate(c).catch(() => {});
    pending.current.delete(peer.sid);
  }

  async function onSignal(from: string, type: string, data: RoomSignalData) {
    const r = roomRef.current;
    if (!r || !session.current || !data?.sid) return;
    if (type === 'offer' && data.description) {
      closePeer(from);
      const peer = newPeer(r.id, from, data.sid, 'in');
      await peer.pc.setRemoteDescription(data.description);
      await flush(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await api.rooms.signal(r.id, from, 'answer', { sid: data.sid, description: { type: 'answer', sdp: answer.sdp } } satisfies RoomSignalData);
    } else if (type === 'answer' && data.description) {
      const peer = peers.current.get(from);
      if (peer?.sid !== data.sid || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription(data.description);
      await flush(peer);
    } else if (type === 'candidate' && data.candidate) {
      const peer = peers.current.get(from);
      if (peer?.sid === data.sid && peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else pending.current.set(data.sid, [...(pending.current.get(data.sid) ?? []), data.candidate]);
    }
  }

  const apply = useCallback(
    (env: RoomEnvelope) => {
      if (env.media) session.current = env.media;
      setCanHost(env.canHost);
      setRoom(env.room);
      void enqueue(() => sync.current());
    },
    [enqueue, setRoom],
  );

  const join = useCallback(
    async (id: string) => {
      if (roomRef.current?.id === id) return true;
      setJoining(id);
      try {
        const env = await api.rooms.join(id);
        if (roomRef.current && roomRef.current.id !== id) teardown();
        apply(env);
        return true;
      } catch (e) {
        toast(errorMessage(e));
        return false;
      } finally {
        setJoining(null);
      }
    },
    [apply, teardown, toast],
  );

  const leave = useCallback(async () => {
    const r = roomRef.current;
    teardown();
    if (r) await api.rooms.leave(r.id).catch(() => {});
  }, [teardown]);

  const act = useCallback(
    async (fn: (roomId: string) => Promise<unknown>) => {
      const r = roomRef.current;
      if (!r) return false;
      try {
        await fn(r.id);
        // Show the result straight away, even if the live connection missed the update.
        void heartbeat.current();
        return true;
      } catch (e) {
        toast(errorMessage(e));
        return false;
      }
    },
    [toast],
  );

  useRealtime((e) => {
    const cur = roomRef.current;
    if (!cur) return;
    if (e.type === 'room.state' && e.data?.id === cur.id) {
      const next = e.data as RoomDetail;
      if (next.status !== 'live') {
        teardown();
        toast(t('m.rooms.endedNotice'));
        return;
      }
      setRoom(next);
      if (!everyone(next).some((p) => p.user.id === meRef.current)) void heartbeat.current();
      else void enqueue(() => sync.current());
    }
    if (e.data?.roomId !== cur.id) return;
    if (e.type === 'room.signal') void enqueue(() => onSignal(e.data.from, e.data.type, e.data.data));
    if (e.type === 'room.reaction') {
      const id = ++reactionId.current;
      setReactions((list) => [...list.slice(-11), { id, kind: e.data.kind }]);
      setTimeout(() => setReactions((list) => list.filter((x) => x.id !== id)), 2600);
    }
    if (e.type === 'room.invited') toast(t('m.rooms.invited'));
    if (e.type === 'room.removed') {
      teardown();
      toast(t('m.rooms.removed'));
    }
  });

  // Tell the API we're still here, rejoin after a network gap, and catch up on anything the socket missed.
  const heartbeat = useRef<() => Promise<void>>(async () => {});
  heartbeat.current = async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      await api.rooms.heartbeat(r.id);
      const env = await api.rooms.get(r.id);
      if (roomRef.current?.id === r.id && env.room.status === 'live') apply(env);
    } catch (e) {
      if (roomRef.current?.id !== r.id) return;
      if (e instanceof ApiError && e.code === 'not_in_room') {
        const env = await api.rooms.join(r.id).catch((err) => (toast(errorMessage(err)), null));
        if (env) apply(env);
        else teardown();
      } else if (e instanceof ApiError && (e.status === 403 || e.code === 'room_ended')) {
        teardown();
        toast(e.message);
      }
    }
  };
  const roomId = room?.id ?? null;
  useEffect(() => () => teardown(), [teardown]);
  useEffect(() => {
    if (!roomId) return;
    const id = setInterval(() => void heartbeat.current(), ROOM_HEARTBEAT_MS);
    // Leaving the page: go quietly, so nobody waits on a silent seat.
    const onHide = () =>
      void fetch(`/api/v1/rooms/${roomId}/leave`, {
        method: 'POST',
        keepalive: true,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', onHide);
    };
  }, [roomId]);

  // Speaking indicators: the level of each person's audio, through WebAudio.
  useEffect(() => {
    const sources: [string, MediaStream][] = Object.entries(streams);
    if (localStream && me) sources.push([me.id, localStream]);
    if (!sources.length) {
      setSpeaking((s) => (s.size ? new Set() : s));
      return;
    }
    const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Audio();
    const meters = sources
      .filter(([, s]) => s.getAudioTracks().length)
      .map(([uid, s]) => {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        return { uid, analyser, buf: new Uint8Array(analyser.fftSize) };
      });
    // Someone stays "speaking" through short pauses, so the ring doesn't flicker between words
    // (longer with reduced motion, where it should change as little as possible).
    const hold = matchMedia('(prefers-reduced-motion: reduce)').matches ? 2000 : 700;
    const lastLoud = new Map<string, number>();
    const timer = setInterval(() => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const at = Date.now();
      const now = new Set<string>();
      for (const m of meters) {
        m.analyser.getByteTimeDomainData(m.buf);
        if (speechLevel(m.buf) > ROOM_SPEAKING_LEVEL) lastLoud.set(m.uid, at);
        if (at - (lastLoud.get(m.uid) ?? 0) < hold) now.add(m.uid);
      }
      setSpeaking((prev) => (prev.size === now.size && [...now].every((x) => prev.has(x)) ? prev : now));
    }, 200);
    return () => {
      clearInterval(timer);
      void ctx.close().catch(() => {});
    };
  }, [streams, localStream, me]);

  return (
    <Ctx.Provider value={{ room, canHost, speaking, reactions, joining, join, leave, act }}>
      {children}
      {Object.entries(streams).map(([uid, s]) => (
        <RoomAudio key={uid} stream={s} />
      ))}
      <RoomMiniBar />
    </Ctx.Provider>
  );
}

function RoomAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <audio ref={ref} autoPlay className="room-audio" />;
}

/** Keeps the room you're in within reach while you browse. */
function RoomMiniBar() {
  const { room, speaking, act, leave } = useRooms();
  const { me, t, tp, locale } = useSession();
  const path = usePathname();
  if (!room || !me || path === `/rooms/${room.id}`) return null;
  const mine = everyone(room).find((p) => p.user.id === me.id);
  const talking = room.speakers.filter((p) => speaking.has(p.user.id));
  return (
    <aside className="room-mini" aria-label={t('rooms.audioRoom')}>
      <Link href={`/rooms/${room.id}`} className="room-mini__main">
        <span className={`room-mini__live${talking.length ? ' is-speaking' : ''}`} aria-hidden />
        <span className="room-mini__text">
          <strong>{room.title}</strong>
          <span className="muted">
            {talking.length
              ? t('rooms.speakingNames', {
                  names: nameList(
                    talking.map((p) => p.user.displayName),
                    locale,
                  ),
                })
              : tp('m.rooms.listening', room.listenerCount)}
          </span>
        </span>
      </Link>
      {mine?.role === 'speaker' ? (
        <Button
          size="sm"
          variant="secondary"
          icon={mine.muted ? 'mic-off' : 'mic'}
          aria-label={mine.muted ? t('m.calls.unmute') : t('m.calls.mute')}
          onClick={() => void act((id) => api.rooms.mute(id, !mine.muted))}
        />
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void leave()}>
        {t('communities.leave')}
      </Button>
    </aside>
  );
}
