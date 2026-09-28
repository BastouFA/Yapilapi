import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import type { RoomEnvelope } from '../../../packages/api-client/src/index';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { ROOM_HEARTBEAT_MS, roomMeshLinks, type RoomSignalData } from '../../../packages/shared/src/rooms';
import type { RoomReaction } from '../../../packages/shared/src/constants';
import type { RoomDetail, RoomMediaSession, RoomSummary } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { tr, type Translate } from './locale';
import { useRealtime, useSession } from './session';
import { useMicInUse } from './yaps';
import type { IconName } from './ui';
import { audio, rtc } from './webrtc';

/** The design-system reaction icons, drawn with their Ionicons counterparts. */
export const REACTION_ICON: Record<RoomReaction, IconName> = {
  heart: 'heart',
  star: 'star',
  sparkle: 'sparkles',
  check: 'checkmark-circle',
  music: 'musical-notes',
};
export const REACTION_LABEL: Record<RoomReaction, MessageKey> = {
  heart: 'm.rooms.react.heart',
  star: 'm.rooms.react.star',
  sparkle: 'm.rooms.react.sparkle',
  check: 'm.rooms.react.check',
  music: 'm.rooms.react.music',
};

export function roomDuration(seconds: number | null, t: Translate): string {
  if (seconds === null) return '';
  if (seconds < 60) return t('m.rooms.underMinute');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? t('m.rooms.hours', { hours: h, minutes: m }) : t('m.rooms.minutes', { count: m });
}

export function roomStatusLabel(r: RoomSummary, t: Translate): string {
  return r.status === 'live'
    ? t('m.rooms.live')
    : r.status === 'scheduled'
      ? t('m.rooms.scheduled')
      : r.status === 'cancelled'
        ? t('m.rooms.cancelled')
        : t('m.rooms.ended');
}

export const everyone = (r: RoomDetail) => [...r.speakers, ...r.listeners];

/** Audio level above which someone counts as speaking (WebRTC stats report 0..1). */
const SPEAKING_STAT_LEVEL = 0.05;

interface Peer {
  pc: RTCPeerConnection;
  sid: string;
  key: string;
}

type Floating = { id: number; kind: RoomReaction };

/**
 * One audio room on the phone: react-native-webrtc, the same mesh protocol as the web app
 * (packages/shared/src/rooms.ts). Speakers send to everyone, listeners only receive; the API
 * relays offers, answers and ICE candidates and sends `room.state` on every change. The room
 * is left when the screen closes. Needs a development build (Expo Go has no WebRTC).
 */
export function useRoom(roomId: string) {
  const { me, setKeepAlive } = useSession();
  const [env, setEnv] = useState<RoomEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  // Yaps don't play out loud while you're in a room.
  useMicInUse(joined);
  const [joining, setJoining] = useState(false);
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
  const [reactions, setReactions] = useState<Floating[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const joinedRef = useRef(false);
  const roomRef = useRef<RoomDetail | null>(null);
  const meRef = useRef<string | null>(null);
  meRef.current = me?.id ?? null;
  const session = useRef<RoomMediaSession | null>(null);
  const peers = useRef(new Map<string, Peer>());
  const pending = useRef(new Map<string, NonNullable<RoomSignalData['candidate']>[]>());
  const local = useRef<MediaStream | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const reactionId = useRef(0);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  }, []);

  const setRoom = useCallback((room: RoomDetail) => {
    roomRef.current = room;
    setEnv((e) => (e ? { ...e, room } : e));
  }, []);

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
  }, []);

  const teardown = useCallback(() => {
    for (const uid of [...peers.current.keys()]) closePeer(uid);
    pending.current.clear();
    local.current?.getTracks().forEach((t) => t.stop());
    local.current?.release();
    local.current = null;
    session.current = null;
    joinedRef.current = false;
    setJoined(false);
    setSpeaking(new Set());
    audio.stop();
    setKeepAlive(false);
  }, [closePeer, setKeepAlive]);

  const sync = useRef<() => Promise<void>>(async () => {});

  const newPeer = useCallback(
    (uid: string, sid: string, key: string): Peer => {
      const RTC = rtc!;
      const s = session.current!;
      const pc = new RTC.RTCPeerConnection({ iceServers: s.iceServers as never, iceTransportPolicy: s.iceTransportPolicy });
      if (local.current) local.current.getTracks().forEach((t) => pc.addTrack(t, local.current!));
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      // The package's event typings are incomplete, so the handlers describe the fields they use.
      pc.onicecandidate = (e: unknown) => {
        const cand = (e as { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }).candidate;
        if (!cand) return;
        const data: RoomSignalData = { sid, candidate: { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex } };
        void client()
          .then((api) => api.rooms.signal(roomId, uid, 'candidate', data))
          .catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState !== 'failed' || peers.current.get(uid)?.pc !== pc) return;
        closePeer(uid);
        setTimeout(() => void enqueue(() => sync.current()), 1500);
      };
      const peer = { pc, sid, key };
      peers.current.set(uid, peer);
      return peer;
    },
    [closePeer, enqueue, roomId],
  );

  sync.current = async () => {
    const r = roomRef.current;
    const meId = meRef.current;
    if (!r || r.status !== 'live' || !meId || !session.current || !rtc || !joinedRef.current) return;
    const people = everyone(r);
    const mine = people.find((p) => p.user.id === meId);
    if (!mine) return;
    const api = await client();
    if (mine.role === 'speaker' && !local.current) {
      try {
        const stream = await rtc.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!stream.getAudioTracks().length) throw new Error('no microphone');
        local.current = stream;
      } catch {
        flash(tr('m.rooms.micBlocked'));
        await api.rooms.toListener(r.id, meId).catch(() => {});
        return;
      }
    }
    if (mine.role === 'listener' && local.current) {
      local.current.getTracks().forEach((t) => t.stop());
      local.current.release();
      local.current = null;
    }
    local.current?.getAudioTracks().forEach((t) => (t.enabled = !mine.muted));
    const links = roomMeshLinks(meId, people);
    const want = new Set(links.map((l) => l.userId));
    for (const uid of [...peers.current.keys()]) if (!want.has(uid)) closePeer(uid);
    for (const l of links) {
      if (!l.offer) continue;
      const cur = peers.current.get(l.userId);
      if (cur && cur.key === l.key) continue;
      if (cur) closePeer(l.userId);
      const sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const peer = newPeer(l.userId, sid, l.key);
      const offer = await peer.pc.createOffer({});
      await peer.pc.setLocalDescription(offer);
      await api.rooms
        .signal(r.id, l.userId, 'offer', { sid, description: { type: 'offer', sdp: offer.sdp } } satisfies RoomSignalData)
        .catch(() => closePeer(l.userId));
    }
  };

  async function flush(peer: Peer) {
    for (const c of pending.current.get(peer.sid) ?? []) await peer.pc.addIceCandidate(new rtc!.RTCIceCandidate(c as never)).catch(() => {});
    pending.current.delete(peer.sid);
  }

  async function onSignal(from: string, type: string, data: RoomSignalData) {
    if (!rtc || !session.current || !data?.sid || !joinedRef.current) return;
    const api = await client();
    if (type === 'offer' && data.description) {
      closePeer(from);
      const peer = newPeer(from, data.sid, 'in');
      await peer.pc.setRemoteDescription(new rtc.RTCSessionDescription(data.description as never));
      await flush(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await api.rooms.signal(roomId, from, 'answer', { sid: data.sid, description: { type: 'answer', sdp: answer.sdp } } satisfies RoomSignalData);
    } else if (type === 'answer' && data.description) {
      const peer = peers.current.get(from);
      if (peer?.sid !== data.sid || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription(new rtc.RTCSessionDescription(data.description as never));
      await flush(peer);
    } else if (type === 'candidate' && data.candidate) {
      const peer = peers.current.get(from);
      if (peer?.sid === data.sid && peer.pc.remoteDescription) await peer.pc.addIceCandidate(new rtc.RTCIceCandidate(data.candidate as never)).catch(() => {});
      else pending.current.set(data.sid, [...(pending.current.get(data.sid) ?? []), data.candidate]);
    }
  }

  const apply = useCallback(
    (next: RoomEnvelope) => {
      if (next.media) session.current = next.media;
      roomRef.current = next.room;
      setEnv(next);
      void enqueue(() => sync.current());
    },
    [enqueue],
  );

  const load = useCallback(async () => {
    try {
      const next = await (await client()).rooms.get(roomId);
      roomRef.current = next.room;
      setEnv(next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [roomId]);
  useEffect(() => {
    void load();
  }, [load]);

  const join = useCallback(async () => {
    if (!rtc) return void flash(tr('m.rooms.unsupported'));
    setJoining(true);
    try {
      const next = await (await client()).rooms.join(roomId);
      joinedRef.current = true;
      setJoined(true);
      // Rooms play through the loudspeaker, and keep the socket open if the screen locks.
      audio.start('audio');
      audio.speaker(true);
      setKeepAlive(true);
      apply(next);
    } catch (e) {
      flash(errorMessage(e));
    } finally {
      setJoining(false);
    }
  }, [apply, flash, roomId, setKeepAlive]);

  const leave = useCallback(async () => {
    const was = joinedRef.current;
    teardown();
    if (was) await (await client()).rooms.leave(roomId).catch(() => {});
  }, [roomId, teardown]);

  const act = useCallback(
    async (fn: (api: Awaited<ReturnType<typeof client>>) => Promise<unknown>) => {
      try {
        await fn(await client());
        return true;
      } catch (e) {
        flash(errorMessage(e));
        return false;
      }
    },
    [flash],
  );

  // Leave quietly when the screen closes.
  useEffect(
    () => () => {
      if (joinedRef.current) {
        teardown();
        void client()
          .then((api) => api.rooms.leave(roomId))
          .catch(() => {});
      }
    },
    [roomId, teardown],
  );

  useRealtime((e) => {
    if (e.type === 'room.state' && e.data?.id === roomId) {
      const next = e.data as RoomDetail;
      setRoom(next);
      if (!joinedRef.current) return;
      if (next.status !== 'live') {
        teardown();
        flash(tr('m.rooms.endedNotice'));
      } else if (!everyone(next).some((p) => p.user.id === meRef.current)) void heartbeat.current();
      else void enqueue(() => sync.current());
      return;
    }
    if (e.data?.roomId !== roomId) return;
    if (e.type === 'room.removed') {
      teardown();
      setEnv((v) => (v ? { ...v, removed: true } : v));
      flash(tr('m.rooms.removed'));
    }
    if (!joinedRef.current) return;
    if (e.type === 'room.signal') void enqueue(() => onSignal(e.data.from, e.data.type, e.data.data));
    if (e.type === 'room.reaction') {
      const id = ++reactionId.current;
      setReactions((list) => [...list.slice(-7), { id, kind: e.data.kind }]);
      setTimeout(() => setReactions((list) => list.filter((x) => x.id !== id)), 2600);
    }
    if (e.type === 'room.invited') flash(tr('m.rooms.invited'));
    if (e.type === 'app.foreground') void heartbeat.current();
  });

  const heartbeat = useRef<() => Promise<void>>(async () => {});
  heartbeat.current = async () => {
    if (!joinedRef.current) return;
    const api = await client();
    try {
      await api.rooms.heartbeat(roomId);
      const next = await api.rooms.get(roomId);
      if (joinedRef.current && next.room.status === 'live') apply(next);
    } catch (e) {
      const code = (e as { code?: string; status?: number }).code;
      const status = (e as { status?: number }).status;
      if (code === 'not_in_room') {
        try {
          apply(await api.rooms.join(roomId));
        } catch (err) {
          teardown();
          flash(errorMessage(err));
        }
      } else if (status === 403 || code === 'room_ended') {
        teardown();
        flash(errorMessage(e));
        void load();
      }
    }
  };
  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => void heartbeat.current(), ROOM_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [joined]);

  // Speaking indicators from WebRTC stats: incoming audio level per person, and our own microphone.
  useEffect(() => {
    if (!joined) return;
    const timer = setInterval(async () => {
      const now = new Set<string>();
      for (const [uid, p] of peers.current) {
        try {
          const stats = await p.pc.getStats();
          stats.forEach((r: { type?: string; kind?: string; audioLevel?: number }) => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio' && (r.audioLevel ?? 0) > SPEAKING_STAT_LEVEL) now.add(uid);
            if (r.type === 'media-source' && r.kind === 'audio' && (r.audioLevel ?? 0) > SPEAKING_STAT_LEVEL && meRef.current) now.add(meRef.current);
          });
        } catch {
          /* stats are a nicety */
        }
      }
      setSpeaking((prev) => (prev.size === now.size && [...now].every((x) => prev.has(x)) ? prev : now));
    }, 600);
    return () => clearInterval(timer);
  }, [joined]);

  return { env, error, joined, joining, speaking, reactions, notice, join, leave, act, reload: load };
}
