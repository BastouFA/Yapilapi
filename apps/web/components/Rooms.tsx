'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Badge, Button, Dialog, EmptyState, Icon, Menu, Skeleton, TextField, type MenuAction } from '@yapilapi/design-system';
import {
  ROOM_HEARTBEAT_MS,
  ROOM_MAX_LISTENERS,
  ROOM_MAX_SPEAKERS,
  ROOM_REACTIONS,
  ROOM_SPEAKING_LEVEL,
  ROOM_TITLE_MAX,
  roomMeshLinks,
  speechLevel,
  type RoomDetail,
  type RoomMediaSession,
  type RoomParticipant,
  type RoomReaction,
  type RoomSignalData,
  type MessageKey,
  type PluralKey,
  type RoomSummary,
} from '@yapilapi/shared';
import type { RoomEnvelope } from '@yapilapi/api-client';
import { api, ApiError, errorMessage } from '@/lib/api';
import { localInput } from '@/lib/schedule';
import { useRealtime, useSession } from '@/app/providers';

/** Labels for the reaction icons (screen readers and tooltips). */
export const REACTION_LABEL: Record<RoomReaction, MessageKey> = {
  heart: 'm.rooms.react.heart',
  star: 'm.rooms.react.star',
  sparkle: 'm.rooms.react.sparkle',
  check: 'm.rooms.react.check',
  music: 'm.rooms.react.music',
};

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;
type TP = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

/** "Ama, Kofi and Lea" in the reader's language. */
const nameList = (names: string[], locale: string) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);

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

// ── Formatting ──────────────────────────────────────────────────────────
export function roomDuration(seconds: number | null, t: T): string {
  if (seconds === null) return '';
  if (seconds < 60) return t('m.rooms.underMinute');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? t('m.rooms.hours', { hours: h, minutes: m }) : t('m.rooms.minutes', { count: m });
}

function when(iso: string, locale: string) {
  return new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function endedLine(r: RoomSummary, t: T, tp: TP) {
  if (r.status === 'cancelled') return t('m.rooms.cancelled');
  return tp('rooms.endedLine', r.peakListeners, { duration: roomDuration(r.durationSeconds, t) });
}

// ── The room screen ─────────────────────────────────────────────────────
export function RoomView({ id }: { id: string }) {
  const rooms = useRooms();
  const { me, locale, t, tp } = useSession();
  const router = useRouter();
  const [env, setEnv] = useState<RoomEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Joining swaps the Join button for the room controls: focus goes to the room's title, not nowhere.
  const title = useRef<HTMLHeadingElement>(null);
  const wasJoined = useRef(false);
  const isJoined = rooms.room?.id === id;
  useEffect(() => {
    if (isJoined && !wasJoined.current && (!document.activeElement || document.activeElement === document.body)) title.current?.focus();
    wasJoined.current = isJoined;
  }, [isJoined]);

  const load = useCallback(
    () =>
      api.rooms.get(id).then(
        (r) => (setEnv(r), setError(null)),
        (e) => setError(errorMessage(e)),
      ),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if (e.type === 'room.state' && e.data?.id === id) setEnv((v) => (v ? { ...v, room: e.data } : v));
    if (e.type === 'room.removed' && e.data?.roomId === id) setEnv((v) => (v ? { ...v, removed: true } : v));
  });

  if (error && !env) return <EmptyState title={t('rooms.notOpen')} body={error} />;
  if (!env || !me) return <Skeleton height={240} />;

  const joined = rooms.room?.id === id;
  const room = joined ? rooms.room! : env.room;
  const canHost = joined ? rooms.canHost : env.canHost;
  const mine = joined ? everyone(room).find((p) => p.user.id === me.id) : undefined;
  const full = room.listenerCount - room.speakerCount >= room.limits.listeners;

  const header = (
    <div className="stack-sm">
      <Link href={`/c/${room.community.slug}`} className="muted">
        {room.community.name}
      </Link>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h1 ref={title} tabIndex={-1} className="profile__name" style={{ margin: 0 }}>
          {room.title}
        </h1>
        {room.status === 'live' ? (
          <Badge tone="danger">{t('m.rooms.live')}</Badge>
        ) : room.status === 'scheduled' ? (
          <Badge tone="warning">{t('m.rooms.scheduled')}</Badge>
        ) : (
          <Badge tone="neutral">{room.status === 'cancelled' ? t('m.rooms.cancelled') : t('m.rooms.ended')}</Badge>
        )}
      </div>
      <span className="muted">
        {room.status === 'scheduled' ? t('rooms.hostedBy', { name: room.createdBy.displayName }) : t('m.rooms.startedBy', { name: room.createdBy.displayName })}
        {room.status === 'live' ? ` · ${tp('m.rooms.listening', room.listenerCount)}` : ''}
      </span>
    </div>
  );

  if (room.status === 'ended' || room.status === 'cancelled')
    return (
      <div className="yp-shell__inner">
        {header}
        <div className="room-ended">
          <Icon name="volume-off" size={28} />
          <p>{endedLine(room, t, tp)}</p>
          <p className="muted">{t('m.rooms.notRecorded')}</p>
        </div>
      </div>
    );

  if (room.status === 'scheduled')
    return (
      <div className="yp-shell__inner">
        {header}
        <ScheduledRoom
          room={room}
          canHost={canHost}
          locale={locale}
          onChange={(r) => setEnv({ ...env, room: { ...env.room, ...r } })}
          onStarted={async () => {
            await load();
            await rooms.join(id);
          }}
        />
      </div>
    );

  if (!joined)
    return (
      <div className="yp-shell__inner">
        {header}
        {env.removed ? <Alert tone="warning">{t('m.rooms.removed')}</Alert> : null}
        {room.speakers.length ? (
          <div className="room-stage" role="group" aria-label={t('m.rooms.speakers')}>
            {room.speakers.map((p) => (
              <SpeakerTile key={p.user.id} p={p} speaking={false} />
            ))}
          </div>
        ) : null}
        {!env.removed ? (
          full ? (
            <Alert tone="info" title={t('m.rooms.full')}>
              {t('m.rooms.fullBody', { speakers: room.limits.speakers, listeners: room.limits.listeners })}
            </Alert>
          ) : (
            <div className="row">
              <Button icon="volume" loading={rooms.joining === id} onClick={() => void rooms.join(id)}>
                {everyone(room).some((p) => p.user.id === me.id) ? t('rooms.rejoin') : t('m.rooms.join')}
              </Button>
            </div>
          )
        ) : null}
      </div>
    );

  const hostActions = (p: RoomParticipant): MenuAction[] => {
    if (!canHost || p.host || p.user.id === me.id) return [];
    const list: MenuAction[] = [];
    if (p.role === 'speaker') {
      if (!p.muted) list.push({ label: t('m.calls.mute'), icon: 'mic-off', onSelect: () => void rooms.act((rid) => api.rooms.muteSpeaker(rid, p.user.id)) });
      list.push({ label: t('m.rooms.toListeners'), icon: 'users', onSelect: () => void rooms.act((rid) => api.rooms.toListener(rid, p.user.id)) });
    } else if (!p.invited) list.push({ label: t('m.rooms.invite'), icon: 'mic', onSelect: () => void rooms.act((rid) => api.rooms.invite(rid, p.user.id)) });
    list.push({ label: t('m.rooms.remove'), icon: 'x-circle', danger: true, onSelect: () => void rooms.act((rid) => api.rooms.remove(rid, p.user.id)) });
    return list;
  };

  const hands = room.listeners.filter((p) => p.handRaised);
  return (
    <div className="yp-shell__inner room">
      {header}
      {mine?.invited ? (
        <Alert tone="info" title={t('m.rooms.invited')}>
          <div className="row" style={{ marginTop: 'var(--space-2)' }}>
            <Button size="sm" icon="mic" onClick={() => void rooms.act((rid) => api.rooms.speak(rid, true))}>
              {t('m.rooms.accept')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void rooms.act((rid) => api.rooms.speak(rid, false))}>
              {t('m.common.notNow')}
            </Button>
          </div>
        </Alert>
      ) : null}

      <section aria-labelledby="room-speakers">
        <h2 id="room-speakers" className="room__heading">
          {t('m.rooms.speakers')} <span className="muted">{t('rooms.seats', { count: room.speakerCount, max: room.limits.speakers })}</span>
        </h2>
        {!room.speakers.length ? <p className="muted">{t('rooms.nobodyOnStage')}</p> : null}
        <div className="room-stage">
          {room.speakers.map((p) => (
            <SpeakerTile key={p.user.id} p={p} speaking={rooms.speaking.has(p.user.id) && !p.muted} actions={hostActions(p)} you={p.user.id === me.id} />
          ))}
        </div>
      </section>

      <div className="room-reactions" aria-hidden>
        {rooms.reactions.map((r) => (
          <span key={r.id} className="room-reactions__float" style={{ insetInlineStart: `${10 + ((r.id * 37) % 70)}%` }}>
            <Icon name={r.kind} size={26} filled={r.kind === 'heart' || r.kind === 'star'} />
          </span>
        ))}
      </div>

      <section aria-labelledby="room-listeners">
        <h2 id="room-listeners" className="room__heading">
          {t('m.rooms.listeners')} <span className="muted">{room.listeners.length}</span>
        </h2>
        {/* Always rendered, so hosts hear hands going up while they're elsewhere in the room. */}
        <p className="muted room__hands" role="status">
          {canHost && hands.length ? tp('rooms.handsRaised', hands.length) : ''}
        </p>
        {room.listeners.length ? (
          <ul className="room-listeners">
            {room.listeners.map((p) => {
              const actions = hostActions(p);
              return (
                <li key={p.user.id}>
                  <Avatar name={p.user.displayName} src={p.user.avatarUrl} size="sm" />
                  <span className="room-listeners__name">{p.user.id === me.id ? t('m.rooms.you', { name: p.user.displayName }) : p.user.displayName}</span>
                  {p.host ? <Badge tone="neutral">{t('m.rooms.host')}</Badge> : null}
                  {p.handRaised ? <Icon name="hand" size={18} label={t('m.rooms.handRaised')} /> : null}
                  {p.invited ? <span className="muted">{t('m.rooms.invitedLabel')}</span> : null}
                  {actions.length ? <Menu label={t('m.rooms.manage', { name: p.user.displayName })} actions={actions} /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{t('m.rooms.nobodyListening')}</p>
        )}
      </section>

      <div className="room-controls" role="group" aria-label={t('rooms.controls')}>
        {mine?.role === 'speaker' ? (
          <>
            <Button
              variant={mine.muted ? 'primary' : 'secondary'}
              icon={mine.muted ? 'mic-off' : 'mic'}
              onClick={() => void rooms.act((rid) => api.rooms.mute(rid, !mine.muted))}
            >
              {mine.muted ? t('m.calls.unmute') : t('m.calls.mute')}
            </Button>
            <Button variant="ghost" onClick={() => void rooms.act((rid) => api.rooms.toListener(rid, me.id))}>
              {t('m.rooms.toListeners')}
            </Button>
          </>
        ) : canHost ? (
          <Button icon="mic" variant="secondary" onClick={() => void rooms.act((rid) => api.rooms.speak(rid, true))}>
            {t('m.rooms.speak')}
          </Button>
        ) : (
          // A toggle: the name stays "Raise hand" and aria-pressed says whether it's up.
          <Button
            icon="hand"
            variant={mine?.handRaised ? 'primary' : 'secondary'}
            aria-pressed={!!mine?.handRaised}
            onClick={() => void rooms.act((rid) => api.rooms.hand(rid, !mine?.handRaised))}
          >
            {t('m.rooms.raiseHand')}
          </Button>
        )}
        <span className="room-controls__reactions" role="group" aria-label={t('m.rooms.reactions')}>
          {ROOM_REACTIONS.map((k) => (
            <button
              key={k}
              type="button"
              className="room-react"
              aria-label={t(REACTION_LABEL[k])}
              title={t(REACTION_LABEL[k])}
              onClick={() => void rooms.act((rid) => api.rooms.react(rid, k))}
            >
              <Icon name={k} size={20} />
            </button>
          ))}
        </span>
        <Button
          variant="ghost"
          icon="logout"
          onClick={async () => {
            await rooms.leave();
            router.push(`/c/${room.community.slug}`);
          }}
        >
          {t('m.rooms.leave')}
        </Button>
        {canHost ? (
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            {t('m.rooms.end')}
          </Button>
        ) : null}
      </div>

      <Dialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title={t('m.rooms.endConfirm')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
              {t('m.rooms.keep')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmEnd(false);
                await rooms.act((rid) => api.rooms.end(rid));
              }}
            >
              {t('m.rooms.end')}
            </Button>
          </>
        }
      >
        <p>{t('m.rooms.endBody')}</p>
      </Dialog>
    </div>
  );
}

function SpeakerTile({ p, speaking, actions = [], you }: { p: RoomParticipant; speaking: boolean; actions?: MenuAction[]; you?: boolean }) {
  const { t } = useSession();
  return (
    <div className={`room-speaker${speaking ? ' is-speaking' : ''}`}>
      <span className="room-speaker__avatar">
        <Avatar name={p.user.displayName} src={p.user.avatarUrl} size="lg" />
        {p.muted ? (
          <span className="room-speaker__muted">
            <Icon name="mic-off" size={14} label={t('m.rooms.muted')} />
          </span>
        ) : null}
      </span>
      <span className="room-speaker__name">{you ? t('m.rooms.you', { name: p.user.displayName }) : p.user.displayName}</span>
      <span className="muted room-speaker__meta">{speaking ? t('m.rooms.speaking') : p.host ? t('m.rooms.host') : t('m.rooms.speaker')}</span>
      {actions.length ? <Menu label={t('m.rooms.manage', { name: p.user.displayName })} actions={actions} /> : null}
    </div>
  );
}

function ScheduledRoom({
  room,
  canHost,
  locale,
  onChange,
  onStarted,
}: {
  room: RoomSummary;
  canHost: boolean;
  locale: string;
  onChange: (r: Partial<RoomSummary>) => void;
  onStarted: () => Promise<void>;
}) {
  const { toast, t } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-sm">
      <p>
        <Icon name="calendar" size={18} /> {room.scheduledFor ? when(room.scheduledFor, locale) : t('rooms.soon')}
      </p>
      <div className="row">
        <Button
          variant={room.remindMe ? 'secondary' : 'primary'}
          icon="bell"
          aria-pressed={room.remindMe}
          onClick={async () => {
            try {
              onChange({ remindMe: (await api.rooms.remind(room.id, !room.remindMe)).remindMe });
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        >
          {t('m.rooms.remind')}
        </Button>
        {canHost ? (
          <>
            <Button
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.rooms.start(room.id);
                  await onStarted();
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('m.rooms.startNow')}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  onChange((await api.rooms.end(room.id)).room);
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('m.rooms.cancel')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── On the community page ───────────────────────────────────────────────
export function CommunityRooms({ slug, isMember }: { slug: string; isMember: boolean }) {
  const { locale, toast, t, tp } = useSession();
  const rooms = useRooms();
  const router = useRouter();
  const [data, setData] = useState<{ items: RoomSummary[]; canStart: boolean; locked?: boolean } | null>(null);
  const [title, setTitle] = useState('');
  const [later, setLater] = useState(false);
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api.communities.rooms(slug).then(setData, (e) => {
        setData({ items: [], canStart: false });
        toast(errorMessage(e));
      }),
    [slug, toast],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <Skeleton height={120} />;
  if (data.locked) return <Alert tone="info">{t('rooms.locked')}</Alert>;
  const live = data.items.filter((r) => r.status === 'live');
  const scheduled = data.items.filter((r) => r.status === 'scheduled');
  const ended = data.items.filter((r) => r.status === 'ended');

  return (
    <div className="stack">
      {data.canStart ? (
        <form
          className="room-new"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api.communities.startRoom(slug, { title: title.trim(), scheduledFor: later && at ? new Date(at).toISOString() : undefined });
              setTitle('');
              setLater(false);
              if (r.room.status === 'live') {
                router.push(`/rooms/${r.room.id}`);
                await rooms.join(r.room.id);
              } else await load();
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label={t('m.rooms.new')}
            placeholder={t('m.rooms.titleLabel')}
            value={title}
            maxLength={ROOM_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="row" style={{ gap: 'var(--space-2)' }}>
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> {t('rooms.scheduleLater')}
          </label>
          {later ? (
            <TextField
              label={t('rooms.startsAt')}
              type="datetime-local"
              value={at}
              min={localInput(new Date())}
              onChange={(e) => setAt(e.target.value)}
              hint={t('rooms.startsAtHint')}
            />
          ) : null}
          <div className="row">
            <Button type="submit" icon="mic" loading={busy} disabled={!title.trim() || (later && !at)}>
              {later ? t('rooms.schedule') : t('m.rooms.start')}
            </Button>
          </div>
          <p className="muted">{t('rooms.startNote', { speakers: ROOM_MAX_SPEAKERS, listeners: ROOM_MAX_LISTENERS })}</p>
        </form>
      ) : null}

      {!data.items.length ? <p className="muted">{t('rooms.empty')}</p> : null}
      {[...live, ...scheduled, ...ended].map((r) => (
        <article key={r.id} className="room-card">
          <div className="room-card__head">
            {r.status === 'live' ? (
              <Badge tone="danger">{t('m.rooms.live')}</Badge>
            ) : r.status === 'scheduled' ? (
              <Badge tone="warning">{t('m.rooms.scheduled')}</Badge>
            ) : (
              <Badge>{t('m.rooms.ended')}</Badge>
            )}
            <Link href={`/rooms/${r.id}`} className="room-card__title">
              {r.title}
            </Link>
          </div>
          <p className="muted room-card__meta">
            {r.status === 'live'
              ? `${tp('m.rooms.listening', r.listenerCount)}${
                  r.speakerPreview.length
                    ? ` · ${t('rooms.onStage', {
                        names: nameList(
                          r.speakerPreview.map((u) => u.displayName),
                          locale,
                        ),
                      })}`
                    : ''
                }`
              : r.status === 'scheduled'
                ? `${r.scheduledFor ? `${when(r.scheduledFor, locale)} · ` : ''}${t('rooms.withHost', { name: r.createdBy.displayName })}`
                : endedLine(r, t, tp)}
          </p>
          {r.status === 'live' && isMember ? (
            <div className="row">
              <Button
                size="sm"
                icon="volume"
                loading={rooms.joining === r.id}
                disabled={r.listenerCount - r.speakerCount >= r.limits.listeners && rooms.room?.id !== r.id}
                onClick={async () => {
                  if (await rooms.join(r.id)) router.push(`/rooms/${r.id}`);
                }}
              >
                {rooms.room?.id === r.id ? t('rooms.open') : r.listenerCount - r.speakerCount >= r.limits.listeners ? t('m.rooms.full') : t('communities.join')}
              </Button>
            </div>
          ) : r.status === 'scheduled' && isMember ? (
            <div className="row">
              <Button
                size="sm"
                variant="secondary"
                icon="bell"
                aria-pressed={r.remindMe}
                onClick={async () => {
                  try {
                    const res = await api.rooms.remind(r.id, !r.remindMe);
                    setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? { ...x, remindMe: res.remindMe } : x)) } : d));
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t('m.rooms.remind')}
              </Button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
