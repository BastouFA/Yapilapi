'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, Badge, Button, CaptionTracks, captionTrackMode, ChatBubble, EmptyState, Icon, Skeleton, videoCrossOrigin } from '@yapilapi/design-system';
import {
  noticeText,
  betterClock,
  clockSample,
  driftFix,
  expectedPositionMs,
  formatReelTime,
  isNewerPlayback,
  messagePreviewOf,
  videoPoster,
  videoSrc,
  watchItemName,
  youtubeWatchUrl,
  WATCH_HEARTBEAT_MS,
  WATCH_REACTIONS,
  type MediaItem,
  type Message,
  type PublicUser,
  type WatchPlayback,
  type WatchQueueItem,
  type WatchReaction,
  type WatchSession,
  type WatchSkipReason,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';
import { REACTION_LABEL } from '@/components/Rooms';
import { previewText, SystemLine } from '@/components/ChatExtras';
import { useCalls } from '@/components/Calls';
import { addNotes, chatName, playbackNotes, postThumb, watchDeviceId } from '@/components/WatchTogether';
import { AddSheet, UploadProgress, useDropFile, useWatchUpload, WatchSuggestions, type Addition } from '@/components/WatchAdd';
import { MEDIA_EVENTS, PhotoClock, YouTubeMedia, type WatchMedia } from '@/components/watch-players';

// The watch screen and its sync engine. Only /watch/[id] loads this file; the picker and the
// banner in a chat are in WatchTogether.tsx, adding to the queue in WatchAdd.tsx, and the photo
// and YouTube players in watch-players.ts.

// ── The sync engine ──────────────────────────────────────────────────────

type Status = 'loading' | 'ready' | 'ended' | 'failed';
type Floating = { id: number; kind: WatchReaction; at: number };
type Control =
  | { action: 'play' | 'pause'; positionMs?: number; atServerMs?: number }
  | { action: 'seek'; positionMs: number; atServerMs?: number }
  | { action: 'next'; fromItemId?: string }
  | { action: 'jump'; itemId: string };

/** A leave still on its way: joining again waits for it, so the two never cross. */
let leaving: Promise<unknown> = Promise.resolve();

/** Events from the player for this long after the sync engine moved it are the engine's, not the viewer's. */
const QUIET_MS = 900;

const loadedItem = (v: WatchMedia | null) => v?.dataset.item ?? null;

/**
 * Keeps this player in step with everyone else's.
 *
 * The server holds one shared playback (item, playing, position at a server moment, seq). This
 * player estimates the server's clock from the round trip of every request that answers with
 * `serverTime`, keeps the newest playback it has seen (isNewerPlayback), and every second works
 * out where the video should be: small drift is fixed by playing a little faster or slower,
 * large drift by seeking (YouTube's player and photos only seek). The host's player is the clock:
 * it reports its position with each heartbeat and only moves itself when the shared state changes.
 *
 * Only explicit actions (the buttons on the watch screen, or play/pause from the system's media
 * keys) send controls; whatever the engine does to the player itself never does.
 *
 * Sound: when the browser won't start a video with sound until you tap (iPhones), it plays muted
 * in step with everyone and "Tap for sound" turns it on. One device per person: the screen opened
 * last plays; this one then shows "Watching on another device" with "Watch here".
 */
export function useWatchSync(id: string) {
  const { me, t, tp, toast, dataSaver } = useSession();
  const [session, setSession] = useState<WatchSession | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [playback, setPlayback] = useState<WatchPlayback | null>(null);
  const [reactions, setReactions] = useState<Floating[]>([]);
  const [video, setVideoEl] = useState<WatchMedia | null>(null);
  // Data saver: videos wait until you press play. Browsers that won't play at all until you
  // interact wait for a press too.
  const [started, setStartedState] = useState(false);
  const [blocked, setBlockedState] = useState(false);
  const [muted, setMutedState] = useState(false);
  /** Muted by us because the browser wanted a tap before sound. */
  const [soundHeld, setSoundHeld] = useState(false);
  /** Another of your devices is the one playing. */
  const [elsewhere, setElsewhereState] = useState(false);
  /** "Ada joined", "Sam left", "Ada reacted": a short note in the player. */
  const [note, setNote] = useState<{ id: number; text: string } | null>(null);

  const device = useRef('');
  const videoRef = useRef<WatchMedia | null>(null);
  const clock = useRef<{ offset: number; rtt: number } | null>(null);
  const aged = useRef(0);
  const pb = useRef<WatchPlayback | null>(null);
  const sess = useRef<WatchSession | null>(null);
  const meId = useRef(me?.id);
  meId.current = me?.id;
  const saver = useRef(dataSaver.active);
  saver.current = dataSaver.active;
  const startedRef = useRef(false);
  const blockedRef = useRef(false);
  const mutedRef = useRef(false);
  const elsewhereRef = useRef(false);
  const quietUntil = useRef(0);
  /** Your own control is on its way: the drift check waits for the answer instead of undoing it. */
  const pending = useRef(0);
  const endedFor = useRef<string | null>(null);
  const refetchedFor = useRef<string | null>(null);
  /** Watching: joined, and not left or ended. */
  const alive = useRef(false);
  /** The screen is open (a join that comes back after it closed leaves again). */
  const mounted = useRef(false);
  const reactionId = useRef(0);
  const noteId = useRef(0);

  const bindVideo = useCallback((el: WatchMedia | null) => {
    if (el) el.muted = mutedRef.current;
    videoRef.current = el;
    setVideoEl(el);
  }, []);

  const markStarted = () => {
    startedRef.current = true;
    setStartedState(true);
  };
  const setBlocked = (b: boolean) => {
    blockedRef.current = b;
    setBlockedState(b);
  };
  const setMuted = (m: boolean) => {
    mutedRef.current = m;
    setMutedState(m);
    if (videoRef.current) videoRef.current.muted = m;
    if (!m) setSoundHeld(false);
  };
  const setElsewhere = (e: boolean) => {
    elsewhereRef.current = e;
    setElsewhereState(e);
  };
  const say = (text: string) => {
    const nid = ++noteId.current;
    setNote({ id: nid, text });
    setTimeout(() => setNote((n) => (n?.id === nid ? null : n)), 4000);
  };
  /** Waiting for a press before playing (Data saver, or the browser wants one). */
  const holding = () => (saver.current && !startedRef.current) || blockedRef.current || elsewhereRef.current;

  // Clock: the server's time now, from the best round trip seen.
  const serverNow = () => Date.now() + (clock.current?.offset ?? 0);
  const sample = (sentAt: number, serverTime: number | undefined) => {
    if (typeof serverTime !== 'number') return;
    const s = clockSample(sentAt, Date.now(), serverTime);
    const next = betterClock(clock.current, s, aged.current);
    if (next === s) aged.current = 0;
    clock.current = next;
  };

  // What the engine does to the player: never mistaken for the viewer's own actions.
  const quiet = () => (quietUntil.current = performance.now() + QUIET_MS);
  const enginePlay = (v: WatchMedia) => {
    quiet();
    void v.play().then(
      () => blockedRef.current && setBlocked(false),
      (e: unknown) => {
        if ((e as Error)?.name !== 'NotAllowedError') return;
        // No sound without a tap (iPhones): play muted, in step, and offer "Tap for sound".
        if (!v.muted) {
          setMuted(true);
          setSoundHeld(true);
          quiet();
          void v.play().then(
            () => blockedRef.current && setBlocked(false),
            (e2: unknown) => (e2 as Error)?.name === 'NotAllowedError' && setBlocked(true),
          );
        } else setBlocked(true);
      },
    );
  };
  const enginePause = (v: WatchMedia) => {
    quiet();
    v.pause();
  };
  const engineSeek = (v: WatchMedia, ms: number) => {
    quiet();
    v.currentTime = ms / 1000;
  };

  /**
   * Bring the player to the shared playback. `hard` after a change of state (play, pause, seek,
   * new item) or a new video loading; otherwise the regular drift check, which the host skips
   * while playing because its player is the clock.
   */
  const syncNow = (hard: boolean) => {
    const v = videoRef.current;
    const p = pb.current;
    if (!v || !p || !p.itemId || loadedItem(v) !== p.itemId || v.readyState < 1 || elsewhereRef.current) return;
    if (!hard && performance.now() < pending.current) return;
    const durationMs = Number.isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : null;
    const expected = expectedPositionMs(p, serverNow(), durationMs);
    const local = v.currentTime * 1000;
    const host = sess.current?.hostId === meId.current;
    const canNudge = v.canNudge !== false;
    if (p.playing) {
      if (holding()) return;
      if (!host || hard) {
        // After a change of state, jump straight there; otherwise catch up gently.
        const fix = driftFix(local, expected, !hard, canNudge);
        if (fix.kind === 'seek') engineSeek(v, fix.toMs);
        if (canNudge) v.playbackRate = host ? 1 : fix.rate;
      } else if (canNudge) v.playbackRate = 1;
      if (v.paused && !v.ended) enginePlay(v);
    } else {
      if (canNudge) v.playbackRate = 1;
      if (!v.paused) enginePause(v);
      const fix = driftFix(local, expected, false, canNudge);
      if (fix.kind === 'seek') engineSeek(v, fix.toMs);
    }
  };

  const applyPlayback = (next: WatchPlayback) => {
    const prev = pb.current;
    if (!isNewerPlayback(next, prev)) return;
    pb.current = next;
    setPlayback(next);
    if (prev?.itemId !== next.itemId) quiet();
    if (!prev || prev.seq !== next.seq || prev.itemId !== next.itemId) syncNow(true);
  };

  const markEnded = () => {
    alive.current = false;
    setStatus('ended');
    const v = videoRef.current;
    if (v && !v.paused) enginePause(v);
  };

  /** Stop here: another of your devices plays now. */
  const goElsewhere = () => {
    if (elsewhereRef.current) return;
    setElsewhere(true);
    const v = videoRef.current;
    if (v && !v.paused) enginePause(v);
  };

  const applySession = (s: WatchSession) => {
    const prev = sess.current;
    sess.current = s;
    setSession(s);
    if (prev && s.hostId && prev.hostId !== s.hostId) {
      if (s.hostId === meId.current) toast(t('watch.youHostNow'));
      else {
        const host = s.watching.find((u) => u.id === s.hostId) ?? s.members.find((u) => u.id === s.hostId);
        if (host) toast(t('watch.hostPassed', { name: host.displayName }));
      }
    }
    // Who came and went, in the player (not in the chat).
    if (prev) {
      const before = new Set(prev.watching.map((u) => u.id));
      const now = new Set(s.watching.map((u) => u.id));
      const came = s.watching.filter((u) => !before.has(u.id) && u.id !== meId.current);
      const went = prev.watching.filter((u) => !now.has(u.id) && u.id !== meId.current);
      const parts = [...came.map((u) => t('watch.joinedNote', { name: u.displayName })), ...went.map((u) => t('watch.leftNote', { name: u.displayName }))];
      if (parts.length) say(parts.join(' · '));
    }
    if (s.status === 'ended') markEnded();
    else applyPlayback(s.playback);
  };

  /** A failed request: ended sessions end here too; not watching any more means join again (unless another device of yours plays). */
  const failed = async (e: unknown, quietly = false, item = false) => {
    if (e instanceof ApiError && (e.status === 410 || e.code === 'watch_ended')) return markEnded();
    if (e instanceof ApiError && e.code === 'watch_not_watching') return elsewhereRef.current ? undefined : void (await join(true));
    // A queue item that moved on in the meantime: read the session again (it says if it's gone).
    if (e instanceof ApiError && e.status === 404 && item) return void (await refresh());
    if (e instanceof ApiError && e.status === 404) return markEnded();
    if (!quietly) toast(errorMessage(e));
  };

  /** Join (or, `again`, rejoin after being dropped: a failure then leaves the screen as it is). This device plays from now on. */
  const join = async (again = false) => {
    await leaving;
    const sentAt = Date.now();
    try {
      const r = await api.watch.join(id, device.current);
      if (!mounted.current) {
        leaving = api.watch.leave(id, device.current).catch(() => {});
        return;
      }
      sample(sentAt, r.session.serverTime);
      alive.current = true;
      setElsewhere(false);
      applySession(r.session);
      if (r.session.status === 'active') setStatus('ready');
      syncNow(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 410 || e.code === 'watch_ended')) markEnded();
      else if (!again) {
        alive.current = false;
        setStatus('failed');
      }
    }
  };

  const refresh = async () => {
    const sentAt = Date.now();
    try {
      const r = await api.watch.get(id);
      sample(sentAt, r.session.serverTime);
      applySession(r.session);
    } catch (e) {
      await failed(e, true);
    }
  };

  const heartbeat = async () => {
    if (!alive.current) return;
    // Older clock samples slowly lose their advantage, so a better one replaces them.
    aged.current += 50;
    const v = videoRef.current;
    const p = pb.current;
    let body: { positionMs?: number; itemId?: string | null; seq?: number; atServerMs?: number; device?: string } = { device: device.current };
    // The host's player is the clock: where it is, on which item, following which state.
    if (
      !elsewhereRef.current &&
      sess.current?.hostId === meId.current &&
      p?.playing &&
      p.itemId &&
      v &&
      loadedItem(v) === p.itemId &&
      !v.paused &&
      v.readyState >= 2
    )
      body = { ...body, positionMs: Math.round(v.currentTime * 1000), itemId: p.itemId, seq: p.seq, atServerMs: Math.round(serverNow()) };
    const sentAt = Date.now();
    try {
      const r = await api.watch.heartbeat(id, body);
      sample(sentAt, r.serverTime);
      if (r.here === false) goElsewhere();
    } catch (e) {
      await failed(e, true);
    }
  };

  const control = async (c: Control) => {
    if (!alive.current || elsewhereRef.current) return;
    const sentAt = Date.now();
    pending.current = performance.now() + 4000;
    try {
      const r = await api.watch.control(id, c);
      pending.current = 0;
      sample(sentAt, r.serverTime);
      applyPlayback(r.playback);
      const n = playbackNotes(t, tp, r.skipped);
      if (n) toast(n);
    } catch (e) {
      // Back to the shared playback: what you did didn't go through.
      pending.current = 0;
      syncNow(true);
      await failed(e, false, c.action === 'jump');
    }
  };

  const float = (kind: WatchReaction, userId?: string) => {
    const rid = ++reactionId.current;
    setReactions((list) => [...list.slice(-11), { id: rid, kind, at: Math.random() }]);
    setTimeout(() => setReactions((list) => list.filter((x) => x.id !== rid)), 2600);
    // Reactions can't float over YouTube's player: said in the player's note instead.
    const cur = pb.current?.itemId ? sess.current?.queue.find((q) => q.id === pb.current!.itemId) : null;
    const who = userId && userId !== meId.current ? sess.current?.watching.find((u) => u.id === userId) : null;
    if (cur?.kind === 'youtube' && who) say(t('watch.reacted', { name: who.displayName }));
  };

  // The latest versions, for timers and realtime events (no stale closures).
  const fns = useRef({ join, refresh, heartbeat, syncNow, applyPlayback, applySession, markEnded, float, goElsewhere });
  fns.current = { join, refresh, heartbeat, syncNow, applyPlayback, applySession, markEnded, float, goElsewhere };
  const notes = useRef({ t, tp, toast });
  notes.current = { t, tp, toast };

  // Join on open; leave when the screen goes away or the page is closed.
  useEffect(() => {
    mounted.current = true;
    device.current = watchDeviceId();
    void fns.current.join();
    const onHide = () => {
      if (!alive.current) return;
      void fetch(`/api/v1/watch/${id}/leave`, {
        method: 'POST',
        keepalive: true,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device: device.current }),
      }).catch(() => {});
    };
    // Back from the browser's page cache: join again.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void fns.current.join(true);
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      mounted.current = false;
      if (alive.current) {
        alive.current = false;
        leaving = api.watch.leave(id, device.current).catch(() => {});
      }
    };
  }, [id]);

  // While watching: the drift check every second, a heartbeat every few seconds, and a catch-up
  // when the page comes back into view.
  useEffect(() => {
    if (status !== 'ready') return;
    const tick = setInterval(() => fns.current.syncNow(false), 1000);
    const beat = setInterval(() => void fns.current.heartbeat(), WATCH_HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void fns.current.heartbeat();
      void fns.current.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(tick);
      clearInterval(beat);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status]);

  useRealtime((e) => {
    if (!e.type.startsWith('watch.') || e.data?.sessionId !== id) return;
    const f = fns.current;
    if (e.type === 'watch.ended') return f.markEnded();
    if (e.type === 'watch.device') {
      if (e.data.deviceId !== device.current) f.goElsewhere();
      return;
    }
    if (!alive.current) return;
    if (e.type === 'watch.playback') {
      f.applyPlayback(e.data.playback as WatchPlayback);
      const skipped = (e.data.skipped ?? []) as WatchSkipReason[];
      const n = skipped.length ? playbackNotes(notes.current.t, notes.current.tp, skipped) : null;
      if (n) notes.current.toast(n);
    }
    if (e.type === 'watch.updated') void f.refresh();
    if (e.type === 'watch.reaction' && (WATCH_REACTIONS as readonly string[]).includes(e.data.kind)) f.float(e.data.kind as WatchReaction, e.data.userId);
  });

  // A new item before the queue here knows it: read the session again (once per item).
  const itemId = playback?.itemId ?? null;
  const known = !itemId || !!session?.queue.some((q) => q.id === itemId);
  useEffect(() => {
    if (known || !itemId || refetchedFor.current === itemId) return;
    refetchedFor.current = itemId;
    void fns.current.refresh();
  }, [known, itemId]);

  const current: WatchQueueItem | null = (itemId && session?.queue.find((q) => q.id === itemId)) || null;
  // An upload on screen that is still being made ready: look again every few seconds.
  const preparing = current?.kind === 'upload' && !current.ready;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => void fns.current.refresh(), 3000);
    return () => clearInterval(timer);
  }, [preparing]);
  // Another item on screen (its video may already be loaded, when it's the same file): line it up.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (currentId) fns.current.syncNow(true);
  }, [currentId]);
  const isHost = !!session && session.hostId === me?.id;
  const saverWaiting = dataSaver.active && !started;
  const needsTap = !!current && !!video && !!playback?.playing && (saverWaiting || blocked) && !elsewhere;

  /** Your position right now, when your player has this item. */
  const localMs = () => {
    const v = videoRef.current;
    return v && pb.current?.itemId && loadedItem(v) === pb.current.itemId && v.readyState >= 1 ? Math.round(v.currentTime * 1000) : undefined;
  };

  return {
    session,
    status,
    playback,
    current,
    isHost,
    reactions,
    video,
    bindVideo,
    saverWaiting,
    needsTap,
    muted,
    soundHeld,
    elsewhere,
    note: note?.text ?? null,
    applySession,
    retry: () => {
      setStatus('loading');
      void join();
    },
    /** "Watch here": this device plays from now on (your other one stops). */
    watchHere: () => {
      markStarted();
      void join(true);
    },
    /** Sound on or off, on this device only. Inside the tap, so the browser allows sound. */
    toggleSound: () => {
      const v = videoRef.current;
      const next = !mutedRef.current;
      setMuted(next);
      if (!next && v && pb.current?.playing && v.paused && !elsewhereRef.current) {
        quiet();
        void v.play().catch(() => {});
      }
    },
    /** Play or pause for everyone. */
    togglePlay: () => {
      const p = pb.current;
      const v = videoRef.current;
      if (!p?.itemId) return toast(t('watch.nothingOn'));
      markStarted();
      if (blockedRef.current) setBlocked(false);
      if (p.playing) {
        if (v) enginePause(v);
        void control({ action: 'pause', positionMs: localMs(), atServerMs: Math.round(serverNow()) });
      } else {
        // Inside the press, so the browser lets it play with sound.
        if (v) enginePlay(v);
        void control({ action: 'play', positionMs: localMs(), atServerMs: Math.round(serverNow()) });
      }
    },
    /** Join in with what's playing (after Data saver or the browser held it): nothing is sent. */
    tapToJoin: () => {
      markStarted();
      setBlocked(false);
      const v = videoRef.current;
      if (!v) return;
      quiet();
      void v.play().then(
        () => fns.current.syncNow(true),
        (e: unknown) => {
          if ((e as Error)?.name === 'NotAllowedError') setBlocked(true);
        },
      );
    },
    seek: (ms: number) => {
      if (!pb.current?.itemId) return;
      markStarted();
      const v = videoRef.current;
      if (v && loadedItem(v) === pb.current.itemId) engineSeek(v, ms);
      void control({ action: 'seek', positionMs: Math.max(0, Math.round(ms)), atServerMs: Math.round(serverNow()) });
    },
    next: () => void control({ action: 'next', fromItemId: pb.current?.itemId ?? undefined }),
    jump: (queueItemId: string) => {
      markStarted();
      void control({ action: 'jump', itemId: queueItemId });
    },
    react: (kind: WatchReaction) => {
      if (!alive.current) return;
      api.watch.react(id, kind).catch((e) => void failed(e));
    },
    leave: async () => {
      if (alive.current) {
        alive.current = false;
        leaving = api.watch.leave(id, device.current).catch(() => {});
        await leaving;
      }
    },
    end: async () => {
      try {
        await api.watch.end(id);
        markEnded();
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    /** Events from the player itself. */
    videoEvents: {
      onLoadedMetadata: () => syncNow(true),
      onEnded: () => {
        const p = pb.current;
        const v = videoRef.current;
        if (!p?.itemId || loadedItem(v) !== p.itemId || endedFor.current === p.itemId || elsewhereRef.current) return;
        endedFor.current = p.itemId;
        void control({ action: 'next', fromItemId: p.itemId });
      },
      // Play or pause from outside the screen's buttons (media keys, picture in picture) counts
      // as the viewer's; the engine's own moves are ignored.
      onPlay: () => {
        const v = videoRef.current;
        const p = pb.current;
        if (!v || !p?.itemId || performance.now() < quietUntil.current || loadedItem(v) !== p.itemId) return;
        if (p.playing) {
          if (holding()) {
            markStarted();
            setBlocked(false);
            syncNow(true);
          }
          return;
        }
        void control({ action: 'play', positionMs: localMs(), atServerMs: Math.round(serverNow()) });
      },
      onPause: () => {
        const v = videoRef.current;
        const p = pb.current;
        if (!v || !p?.itemId || !p.playing || v.ended || document.hidden) return;
        if (performance.now() < quietUntil.current || loadedItem(v) !== p.itemId || v.readyState < 2) return;
        void control({ action: 'pause', positionMs: localMs(), atServerMs: Math.round(serverNow()) });
      },
    },
  };
}

type Sync = ReturnType<typeof useWatchSync>;

// ── Players ─────────────────────────────────────────────────────────────

/** Wires the engine's events onto a photo or YouTube player, always to the latest handlers. */
function useMediaEvents(media: WatchMedia | null, events: Sync['videoEvents']) {
  const latest = useRef(events);
  latest.current = events;
  useEffect(() => {
    if (!media) return;
    const handlers = {
      loadedmetadata: () => latest.current.onLoadedMetadata(),
      ended: () => latest.current.onEnded(),
      play: () => latest.current.onPlay(),
      pause: () => latest.current.onPause(),
    } satisfies Record<(typeof MEDIA_EVENTS)[number], () => void>;
    for (const ev of MEDIA_EVENTS) media.addEventListener(ev, handlers[ev]);
    return () => {
      for (const ev of MEDIA_EVENTS) media.removeEventListener(ev, handlers[ev]);
    };
  }, [media]);
}

/** A photo on screen for everyone: it stays WATCH_PHOTO_MS while playing, then the queue moves on. */
function PhotoStage({ item, media, w }: { item: WatchQueueItem; media: MediaItem; w: Sync }) {
  const [clock, setClock] = useState<PhotoClock | null>(null);
  const bind = w.bindVideo;
  useEffect(() => {
    const c = new PhotoClock(item.id);
    setClock(c);
    bind(c);
    return () => {
      bind(null);
      c.destroy();
    };
  }, [item.id, bind]);
  useMediaEvents(clock, w.videoEvents);
  // Told once its events are wired: the engine lines it up.
  useEffect(() => {
    if (clock) w.videoEvents.onLoadedMetadata();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock]);
  const src = media.variants?.large ?? media.variants?.medium ?? media.url;
  return <img className="watch-stage__photo" src={src} alt={media.altText ?? ''} decoding="async" />;
}

/**
 * A YouTube video in YouTube's own player, nothing drawn over it. When YouTube won't play it here
 * (the owner turned embedding off, or it's age-restricted or gone), it says so with a way to
 * open it on YouTube.
 */
function YouTubeStage({ item, videoId, w }: { item: WatchQueueItem; videoId: string; w: Sync }) {
  const { t } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState<YouTubeMedia | null>(null);
  /** YouTube's error code (101 and 150: the owner doesn't allow it outside YouTube; -1: its player didn't load). */
  const [error, setError] = useState<number | null>(null);
  const bind = w.bindVideo;
  useEffect(() => {
    if (!host.current) return;
    setError(null);
    // YouTube won't play it here: nothing to keep in step on this device (the others carry on).
    const p = new YouTubeMedia(host.current, videoId, item.id, (code) => {
      setError(code);
      bind(null);
    });
    setPlayer(p);
    bind(p);
    const el = host.current;
    return () => {
      bind(null);
      p.destroy();
      el.replaceChildren();
    };
  }, [item.id, videoId, bind]);
  useMediaEvents(player, w.videoEvents);
  return (
    <div className="watch-stage__yt" data-yt-error={error ?? undefined}>
      <div ref={host} className="watch-stage__yt-host" hidden={error !== null} />
      {error !== null ? (
        <div className="watch-stage__empty" role="status">
          <Icon name="info" size={28} />
          <p>{t('watch.youtubeBlocked')}</p>
          <a className="yp-btn yp-btn--secondary yp-btn--sm" href={youtubeWatchUrl(videoId)} target="_blank" rel="noopener noreferrer">
            {t('watch.openYoutube')}
          </a>
        </div>
      ) : null}
    </div>
  );
}

// ── The watch screen ─────────────────────────────────────────────────────

/** The video's position and a slider to move it for everyone. */
function Scrubber({ video, onSeek, disabled }: { video: WatchMedia | null; onSeek: (ms: number) => void; disabled: boolean }) {
  const { t } = useSession();
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    if (!video) return;
    const update = () => {
      setPos(video.currentTime * 1000);
      setDur(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
    };
    update();
    const events = ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'emptied'] as const;
    events.forEach((ev) => video.addEventListener(ev, update));
    return () => events.forEach((ev) => video.removeEventListener(ev, update));
  }, [video]);
  const value = drag ?? pos;
  const max = Math.max(1, Math.round(dur));
  const commit = () => {
    if (drag === null) return;
    clearTimeout(keyTimer.current);
    onSeek(drag);
    setDrag(null);
  };
  // Keys move 5 seconds (10 with Page Up and Page Down) and add up while pressed again: everyone
  // is moved once, a moment after the last press, not once per press from the old position.
  const keyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(keyTimer.current), []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const steps: Record<string, number> = { ArrowRight: 5000, ArrowUp: 5000, ArrowLeft: -5000, ArrowDown: -5000, PageUp: 10000, PageDown: -10000 };
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? max : e.key in steps ? Math.max(0, Math.min(max, value + steps[e.key]!)) : null;
    if (to === null) return;
    e.preventDefault();
    setDrag(to);
    clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      onSeek(to);
      setDrag(null);
    }, 400);
  };
  return (
    <div className="watch-scrub">
      <span className="watch-scrub__time" aria-hidden>
        {formatReelTime(value)}
      </span>
      <input
        type="range"
        className="watch-scrub__range"
        min={0}
        max={max}
        step={500}
        value={Math.min(Math.round(value), max)}
        disabled={disabled || !dur}
        aria-label={t('watch.seek')}
        aria-valuetext={t('watch.progress', { position: formatReelTime(value), duration: formatReelTime(dur) })}
        onChange={(e) => setDrag(Number(e.currentTarget.value))}
        onPointerUp={commit}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
      <span className="watch-scrub__time" aria-hidden>
        {formatReelTime(dur)}
      </span>
    </div>
  );
}

/** The chat beside the video: the conversation itself, newest at the bottom. `onUnread` hears of messages from others. */
function WatchChat({ conversationId, group, onUnread }: { conversationId: string; group: boolean; onUnread?: () => void }) {
  const { me, t, toast, locale } = useSession();
  const [messages, setMessages] = useState<(Message & { pending?: boolean })[] | null>(null);
  const [body, setBody] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let live = true;
    api.conversations.messages(conversationId).then(
      (r) => {
        if (!live) return;
        setMessages(r.items);
        void api.conversations.read(conversationId).catch(() => {});
      },
      () => live && setMessages([]),
    );
    return () => {
      live = false;
    };
  }, [conversationId]);

  useRealtime((e) => {
    if (e.data?.conversationId !== conversationId) return;
    if (e.type === 'message.created') {
      const m = e.data as Message;
      setMessages((cur) => {
        if (!cur || cur.some((x) => x.id === m.id)) return cur;
        const i = m.clientId ? cur.findIndex((x) => x.clientId === m.clientId) : -1;
        return i >= 0 ? cur.map((x, j) => (j === i ? m : x)) : [...cur, m];
      });
      if (m.sender.id !== me?.id) {
        void api.conversations.read(conversationId).catch(() => {});
        if (m.kind !== 'system') onUnread?.();
      }
    }
    if (e.type === 'message.deleted' || e.type === 'message.hidden') setMessages((cur) => cur?.filter((x) => x.id !== e.data.id) ?? cur);
    if (e.type === 'message.unsent') setMessages((cur) => cur?.map((x) => (x.id === e.data.id ? { ...x, unsent: true, body: '', attachments: [] } : x)) ?? cur);
    if (e.type === 'message.edited')
      setMessages((cur) => cur?.map((x) => (x.id === e.data.id ? { ...x, body: e.data.body, editedAt: e.data.editedAt } : x)) ?? cur);
    if (e.type === 'message.system') setMessages((cur) => cur?.map((x) => (x.id === e.data.id ? { ...x, system: e.data.system } : x)) ?? cur);
  });

  // Follow the newest message, unless you scrolled up to read.
  const lastId = messages?.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text || !me) return;
    const clientId = crypto.randomUUID();
    const optimistic: Message & { pending: boolean } = {
      id: clientId,
      conversationId,
      sender: { id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl, mode: me.mode },
      body: text,
      replyToId: null,
      attachments: [],
      createdAt: new Date().toISOString(),
      clientId,
      pending: true,
    };
    stick.current = true;
    setMessages((cur) => [...(cur ?? []), optimistic]);
    setBody('');
    try {
      const { message, notice, noticeCode } = await api.conversations.send(conversationId, text, clientId);
      setMessages((cur) => cur?.map((x) => (x.clientId === clientId ? message : x)) ?? cur);
      const n = noticeText({ code: noticeCode, message: notice }, t);
      if (n) toast(n);
    } catch (err) {
      setMessages((cur) => cur?.filter((x) => x.clientId !== clientId) ?? cur);
      setBody(text);
      toast(errorMessage(err));
    }
  }

  return (
    <>
      <div className="watch-chat__head">
        <h2 className="watch-section__title">{t('watch.chat')}</h2>
        <Link href={`/inbox/${conversationId}`} className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('watch.back')}
        </Link>
      </div>
      <div
        className="watch-chat__list"
        ref={list}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('watch.chat')}
        tabIndex={0}
        onScroll={() => {
          const el = list.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages === null ? (
          <Skeleton height={120} />
        ) : (
          messages.slice(-80).map((m) => {
            if (m.kind === 'system') return <SystemLine key={m.id} message={m} meId={me?.id} />;
            const mine = m.sender.id === me?.id;
            // Cards the server wrote (a game, a location, an offer) and story replies are said in your language.
            const card = m.game || m.location || m.offer || m.storyReply;
            const text = m.unsent ? t('m.chat.unsent') : m.body && !card ? m.body : previewText(t, messagePreviewOf(m), { meId: me?.id, locale });
            return (
              <ChatBubble
                key={m.id}
                locale={locale}
                mine={mine}
                sender={group ? m.sender.displayName : undefined}
                body={text}
                pending={m.pending}
                time={new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(m.createdAt))}
              />
            );
          })
        )}
      </div>
      <form className="watch-chat__composer" onSubmit={(e) => void send(e)}>
        <label htmlFor="watch-msg" className="yp-visually-hidden">
          {t('watch.chatPlaceholder')}
        </label>
        <textarea
          id="watch-msg"
          rows={1}
          placeholder={t('watch.chatPlaceholder')}
          value={body}
          maxLength={4000}
          aria-describedby="watch-chat-note"
          onChange={(e) => setBody(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" size="sm" icon="send" disabled={!body.trim()} aria-label={t('watch.send')}>
          <span className="watch-chat__send">{t('watch.send')}</span>
        </Button>
      </form>
      <p className="muted watch-chat__note" id="watch-chat-note">
        {t('watch.chatNote')}
      </p>
    </>
  );
}

/** A small picture for a queue item. */
function itemThumb(item: WatchQueueItem): string | null {
  if (item.kind === 'post') return postThumb(item.post);
  if (item.kind === 'youtube') return item.youtube.thumbnailUrl;
  const m = item.media;
  return m.kind === 'video' ? (m.variants?.thumb ?? m.posterUrl ?? null) : (m.variants?.thumb ?? m.variants?.medium ?? m.url);
}

/** A queued or playing item: its picture, what it is, and who added it. */
function QueueRow({ item, actions }: { item: WatchQueueItem; actions?: React.ReactNode }) {
  const { t } = useSession();
  const thumb = itemThumb(item);
  const sensitive = item.kind === 'post' ? item.post.media.some((m) => m.sensitive) : item.kind === 'upload' && !!item.media.sensitive;
  const name = watchItemName(item, { youtube: t('watch.youtube'), upload: t('m.chat.video') });
  const caption =
    item.kind === 'post' ? item.post.body : item.kind === 'youtube' ? t('watch.youtube') : item.media.kind === 'image' ? t('m.post.photo') : t('m.chat.video');
  return (
    <div className="watch-queue__row">
      <span className="watch-queue__thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" className={sensitive ? 'yp-blurred' : undefined} /> : <Icon name="play" size={18} />}
      </span>
      <span className="watch-queue__text">
        <bdi className="watch-queue__author">{name}</bdi>
        {caption ? (
          <span className="watch-queue__caption" dir="auto">
            {caption}
          </span>
        ) : null}
        {item.kind === 'upload' && !item.ready ? <span className="muted watch-queue__by">{t('watch.preparing')}</span> : null}
        {item.addedBy ? <span className="muted watch-queue__by">{t('watch.addedBy', { name: item.addedBy.displayName })}</span> : null}
      </span>
      {actions ? <span className="watch-queue__actions">{actions}</span> : null}
    </div>
  );
}

/** A phone-width screen (the chat is a sheet there). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 819px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

/** Who's watching right now, in the player: faces (the host first), with a short note when someone comes or goes. */
function Presence({ watching, hostId, note }: { watching: PublicUser[]; hostId: string | null; note: string | null }) {
  const { t, tp } = useSession();
  return (
    <div className="watch-presence">
      <span className="watch-presence__faces" role="img" aria-label={`${t('watch.people')}: ${watching.map((u) => u.displayName).join(', ')}`}>
        {watching.slice(0, 5).map((u) => (
          <span key={u.id} className={u.id === hostId ? 'watch-presence__face watch-presence__face--host' : 'watch-presence__face'}>
            <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
          </span>
        ))}
      </span>
      <span className="muted watch-presence__count">{tp('watch.watching', watching.length)}</span>
      <span className="watch-presence__note" role="status">
        {note}
      </span>
    </div>
  );
}

/**
 * The watch screen: who's watching, the video in step with everyone (a post, an upload, a photo
 * or a YouTube video), reactions, what's up next (and the sheet to add more), and the chat beside
 * it on wide screens; on phones the chat is a sheet over the lower part that opens and closes.
 */
export function WatchScreen({ id }: { id: string }) {
  const { me, t, toast, locale, dataSaver } = useSession();
  const router = useRouter();
  const calls = useCalls();
  const w = useWatchSync(id);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const narrow = useNarrow();
  const { session, current, playback, isHost, video } = w;

  async function add(a: Addition): Promise<boolean> {
    setAdding(true);
    try {
      const r = await api.watch.add(id, a.postIds ?? [], { mediaIds: a.mediaIds, links: a.links });
      w.applySession(r.session);
      if (r.added.length) toast(t('watch.added'));
      const n = addNotes(t, r.skipped);
      if (n) toast(n);
      return r.added.length > 0;
    } catch (err) {
      toast(errorMessage(err));
      return false;
    } finally {
      setAdding(false);
    }
  }
  const upload = useWatchUpload(add);
  const drop = useDropFile((f) => void upload.send(f));

  const media = current?.kind === 'post' ? (current.post.media.find((m) => m.kind === 'video') ?? null) : current?.kind === 'upload' ? current.media : null;
  const captions = media?.captions ?? [];
  const photo = current?.kind === 'upload' && current.media.kind === 'image';
  const ready = current?.kind !== 'upload' || current.ready;
  // The smaller file on Data saver (pressing play to join in doesn't switch files mid-way).
  const src = media && !photo && ready ? videoSrc(media, dataSaver.active) : undefined;

  // Captions: the one in your language (or the first), when turned on.
  useEffect(() => {
    if (!(video instanceof HTMLVideoElement)) return;
    const tracks = Array.from(video.textTracks);
    const lang = locale.split('-')[0];
    const pick = tracks.find((tr) => tr.language.split('-')[0] === lang) ?? tracks[0];
    for (const tr of tracks) tr.mode = captionTrackMode(tr, captionsOn && tr === pick);
  }, [video, captionsOn, locale, src, captions.length]);

  const bindVideoEl = w.bindVideo;
  const videoRefCb = useCallback((el: HTMLVideoElement | null) => bindVideoEl(el), [bindVideoEl]);

  if (w.status === 'loading' && !session)
    return (
      <div className="yp-shell__inner yp-shell__inner--wide watch-page" aria-busy>
        <p className="muted" role="status">
          {t('watch.syncing')}
        </p>
        <Skeleton height={360} />
      </div>
    );

  if (w.status === 'ended')
    return (
      <div className="yp-shell__inner watch-page">
        <EmptyState
          level={1}
          title={t('watch.ended')}
          action={
            <div className="row" style={{ justifyContent: 'center' }}>
              {session ? (
                <Button
                  onClick={async () => {
                    // Your own session nobody else joined comes back as it was; otherwise a new one starts.
                    try {
                      const r = await api.watch.start(session.conversationId, [], { device: watchDeviceId() });
                      router.replace(`/watch/${r.session.id}`);
                      if (r.session.id === id) w.retry();
                    } catch (err) {
                      toast(errorMessage(err));
                    }
                  }}
                >
                  {t('watch.startAgain')}
                </Button>
              ) : null}
              <Link href={session ? `/inbox/${session.conversationId}` : '/inbox'} className="yp-btn yp-btn--secondary">
                {t('watch.back')}
              </Link>
            </div>
          }
        />
      </div>
    );

  if (w.status === 'failed' || !session)
    return (
      <div className="yp-shell__inner watch-page">
        <EmptyState
          level={1}
          title={t('watch.loadFailed')}
          action={
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button variant="secondary" onClick={w.retry}>
                {t('m.common.retry')}
              </Button>
              <Link href="/inbox" className="yp-btn yp-btn--ghost">
                {t('watch.back')}
              </Link>
            </div>
          }
        />
      </div>
    );

  const upNext = session.queue.filter((q) => q.status === 'queued');
  const notWatching = session.members.filter((m) => !session.watching.some((u) => u.id === m.id));
  const playing = !!playback?.playing && !w.needsTap;
  const title = chatName({ title: session.conversationTitle, members: session.members }, me?.id);
  const queuedPosts = new Set(session.queue.flatMap((q) => (q.kind === 'post' ? [q.post.id] : [])));
  const youtube = current?.kind === 'youtube';
  const canCall = session.members.length > 1 && session.members.length <= 8;
  const onCall = !!calls.current;

  async function remove(itemId: string) {
    try {
      w.applySession((await api.watch.remove(id, itemId)).session);
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  // On phones the chat is a sheet in <body> (fixed to the screen, out of the page's layout).
  const chat = (
    <aside className={`watch-chat${narrow ? ' watch-chat--sheet' : ''}${chatOpen ? ' watch-chat--open' : ''}`} id="watch-chat" aria-label={t('watch.chat')}>
      {narrow ? (
        <button type="button" className="watch-chat__close yp-action" aria-label={t('m.common.close')} onClick={() => setChatOpen(false)}>
          <Icon name="chevron-down" />
        </button>
      ) : null}
      <WatchChat conversationId={session.conversationId} group={session.members.length > 2} onUnread={() => !chatOpen && setUnread((n) => n + 1)} />
    </aside>
  );

  const stage = w.elsewhere ? (
    <div className="watch-stage__empty watch-stage__elsewhere">
      <Icon name="device" size={28} />
      <p>
        <strong>{t('watch.elsewhere')}</strong>
      </p>
      <p>{t('watch.elsewhereHint')}</p>
      <Button onClick={w.watchHere}>{t('watch.watchHere')}</Button>
    </div>
  ) : !current ? (
    <div className="watch-stage__empty">
      <Icon name="play" size={28} />
      <p>{t('watch.queueEmpty')}</p>
      <Button variant="secondary" icon="plus" onClick={() => setAddOpen(true)}>
        {t('watch.add')}
      </Button>
    </div>
  ) : !ready ? (
    <div className="watch-stage__empty" role="status">
      <span className="yp-btn__spin watch-stage__spin" aria-hidden />
      <p>{t('watch.preparing')}</p>
    </div>
  ) : current.kind === 'youtube' ? (
    <YouTubeStage key={current.id} item={current} videoId={current.youtube.videoId} w={w} />
  ) : photo && media ? (
    <PhotoStage key={current.id} item={current} media={media} w={w} />
  ) : src ? (
    <video
      ref={videoRefCb}
      className="watch-stage__video"
      data-item={current.id}
      src={src}
      poster={media ? videoPoster(media, dataSaver.active) : undefined}
      preload={w.saverWaiting ? 'none' : 'auto'}
      playsInline
      muted={w.muted}
      crossOrigin={videoCrossOrigin(captions)}
      aria-label={`${t('watch.nowPlaying')}: ${watchItemName(current, { youtube: t('watch.youtube'), upload: t('m.chat.video') })}`}
      {...w.videoEvents}
    >
      <CaptionTracks captions={captions} mediaId={media?.id} />
    </video>
  ) : null;

  return (
    <div className={`yp-shell__inner yp-shell__inner--wide watch-page${chatOpen ? ' watch-page--chat' : ''}`}>
      <div className="yp-topbar watch-top">
        <div className="row watch-top__title">
          <Link href={`/inbox/${session.conversationId}`} className="yp-action" aria-label={t('watch.back')}>
            <Icon name="arrow-left" />
          </Link>
          <div className="watch-top__names">
            <h1>{t('watch.title')}</h1>
            {title ? <bdi className="muted watch-top__chat">{title}</bdi> : null}
          </div>
        </div>
        <div className="row watch-top__actions">
          {isHost ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (confirm(t('watch.endConfirm'))) void w.end();
              }}
            >
              {t('watch.end')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            icon="logout"
            onClick={async () => {
              await w.leave();
              toast(t('watch.left'));
              router.push(`/inbox/${session.conversationId}`);
            }}
          >
            {t('watch.leave')}
          </Button>
        </div>
      </div>

      <div className="watch-layout">
        <section className="watch-player" aria-label={t('watch.nowPlaying')}>
          <Presence watching={session.watching} hostId={session.hostId} note={w.note} />
          <div className={`watch-stage${youtube ? ' watch-stage--embed' : ''}${drop.over ? ' watch-stage--drop' : ''}`} {...drop.props}>
            {stage}
            {/* Nothing is drawn over YouTube's player: its reactions are said in the note above. */}
            {!youtube ? (
              <div className="watch-floats" aria-hidden>
                {w.reactions.map((r) => (
                  <span key={r.id} className="watch-floats__item" style={{ insetInlineStart: `${8 + Math.round(r.at * 72)}%` }}>
                    <Icon name={r.kind} size={30} filled={r.kind === 'heart' || r.kind === 'star'} />
                  </span>
                ))}
              </div>
            ) : null}
            {w.needsTap && !youtube ? (
              <div className="watch-stage__overlay">
                <Button icon="play" onClick={w.tapToJoin}>
                  {t('watch.playToJoin')}
                </Button>
              </div>
            ) : null}
            {w.soundHeld && !w.needsTap && !youtube && !photo && !!video && !w.elsewhere ? (
              <button type="button" className="watch-sound-pill" onClick={w.toggleSound}>
                <Icon name="volume-off" size={18} />
                {t('watch.tapForSound')}
              </button>
            ) : null}
          </div>
          {/* Outside YouTube's player, so nothing covers it. */}
          {youtube && !!video && (w.needsTap || w.soundHeld) && !w.elsewhere ? (
            <div className="row watch-embed-taps">
              {w.needsTap ? (
                <Button icon="play" onClick={w.tapToJoin}>
                  {t('watch.playToJoin')}
                </Button>
              ) : (
                <Button variant="secondary" icon="volume-off" onClick={w.toggleSound}>
                  {t('watch.tapForSound')}
                </Button>
              )}
            </div>
          ) : null}
          {upload.state ? <UploadProgress state={upload.state} /> : null}
          {w.saverWaiting ? <p className="muted watch-note">{t('watch.dataSaverNote')}</p> : null}

          <div className="watch-controls" role="group" aria-label={t('watch.title')}>
            <button
              type="button"
              className="watch-ctl watch-ctl--main"
              aria-label={playing ? t('watch.pause') : t('watch.play')}
              title={playing ? t('watch.pause') : t('watch.play')}
              disabled={!current || w.elsewhere}
              onClick={w.needsTap ? w.tapToJoin : w.togglePlay}
            >
              <Icon name={playing ? 'pause' : 'play'} size={22} />
            </button>
            {!photo ? (
              <Scrubber video={current ? video : null} onSeek={w.seek} disabled={!current || w.needsTap || w.elsewhere || !ready} />
            ) : (
              <span className="watch-scrub" />
            )}
            <button
              type="button"
              className="watch-ctl"
              // One name with a pressed state (pressed: sound on), like the reels' sound button.
              aria-label={t('m.reels.sound')}
              title={w.muted ? t('m.reels.soundOn') : t('m.reels.soundOff')}
              aria-pressed={!w.muted}
              disabled={w.elsewhere}
              onClick={w.toggleSound}
            >
              <Icon name={w.muted ? 'volume-off' : 'volume'} size={20} />
            </button>
            {captions.length ? (
              <button
                type="button"
                className="watch-ctl watch-ctl--text"
                aria-pressed={captionsOn}
                title={t('reel.captions.show')}
                onClick={() => setCaptionsOn((c) => !c)}
              >
                CC<span className="yp-visually-hidden"> {t('reel.captions.show')}</span>
              </button>
            ) : null}
          </div>
          <div className="watch-actions">
            <Button size="sm" variant="secondary" iconRight="chevron-right" disabled={!upNext.length || w.elsewhere} onClick={w.next}>
              {t('watch.next')}
            </Button>
            <Button size="sm" variant="secondary" icon="plus" onClick={() => setAddOpen(true)}>
              {t('watch.add')}
            </Button>
            {canCall && !onCall ? (
              <Button size="sm" variant="secondary" icon="phone" onClick={() => void calls.start(session.conversationId, 'audio')}>
                {t('watch.voiceCall')}
              </Button>
            ) : null}
            <button
              type="button"
              className="yp-btn yp-btn--secondary yp-btn--sm watch-chat-toggle"
              aria-expanded={chatOpen}
              aria-controls="watch-chat"
              onClick={() => {
                setChatOpen((o) => !o);
                setUnread(0);
              }}
            >
              <Icon name="message" size={16} />
              {t('watch.chat')}
              {unread > 0 && !chatOpen ? (
                <span className="watch-chat-toggle__dot">
                  <span className="yp-visually-hidden">{t('watch.chatNew')}</span>
                </span>
              ) : null}
            </button>
          </div>

          <div className="watch-reacts" role="group" aria-label={t('watch.react')}>
            {WATCH_REACTIONS.map((k) => (
              <button key={k} type="button" className="watch-react" aria-label={t(REACTION_LABEL[k])} title={t(REACTION_LABEL[k])} onClick={() => w.react(k)}>
                <Icon name={k} size={22} />
              </button>
            ))}
          </div>
          {!upNext.length ? <WatchSuggestions sessionId={id} queued={queuedPosts} busy={adding} onAdd={(pid) => void add({ postIds: [pid] })} /> : null}
        </section>

        {narrow ? createPortal(chat, document.body) : chat}

        <div className="watch-details">
          <section className="watch-section" aria-labelledby="watch-queue-title">
            <h2 id="watch-queue-title" className="watch-section__title">
              {t('watch.queue')}
            </h2>
            {current ? (
              <div className="watch-queue__now">
                <span className="watch-queue__label">{t('watch.nowPlaying')}</span>
                <QueueRow item={current} />
              </div>
            ) : null}
            {upNext.length ? (
              <ol className="watch-queue">
                {upNext.map((q) => {
                  const name = watchItemName(q, { youtube: t('watch.youtube'), upload: t('m.chat.video') });
                  return (
                    <li key={q.id}>
                      <QueueRow
                        item={q}
                        actions={
                          <>
                            <button
                              type="button"
                              className="watch-ctl"
                              aria-label={`${t('watch.playNow')}: ${name}`}
                              title={t('watch.playNow')}
                              disabled={w.elsewhere}
                              onClick={() => w.jump(q.id)}
                            >
                              <Icon name="play" size={18} />
                            </button>
                            {q.addedBy?.id === me?.id || isHost ? (
                              <button
                                type="button"
                                className="watch-ctl"
                                aria-label={`${t('watch.remove')}: ${name}`}
                                title={t('watch.remove')}
                                onClick={() => void remove(q.id)}
                              >
                                <Icon name="x" size={18} />
                              </button>
                            ) : null}
                          </>
                        }
                      />
                    </li>
                  );
                })}
              </ol>
            ) : null}
            <Button variant="secondary" icon="plus" onClick={() => setAddOpen(true)}>
              {t('watch.add')}
            </Button>
          </section>

          <section className="watch-section" aria-labelledby="watch-people-title">
            <h2 id="watch-people-title" className="watch-section__title">
              {t('watch.people')}
            </h2>
            <ul className="watch-people">
              {session.watching.map((u) => (
                <li key={u.id}>
                  <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                  <bdi className="watch-people__name">{u.id === me?.id ? t('m.rooms.you', { name: u.displayName }) : u.displayName}</bdi>
                  {u.id === session.hostId ? <Badge tone="neutral">{t('watch.host')}</Badge> : null}
                </li>
              ))}
            </ul>
            {notWatching.length ? (
              <>
                <h3 className="watch-section__sub">{t('watch.notWatching')}</h3>
                <ul className="watch-people watch-people--away">
                  {notWatching.map((u) => (
                    <li key={u.id}>
                      <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                      <bdi className="watch-people__name">{u.displayName}</bdi>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </div>
      </div>

      <AddSheet open={addOpen} onClose={() => setAddOpen(false)} queued={queuedPosts} busy={adding} add={add} upload={upload} />
    </div>
  );
}
