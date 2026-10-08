import { useEventListener } from 'expo';
import { router, useFocusEffect } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, Text, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import { hls360 } from '../../../packages/shared/src/data-saver';
import type { Conversation, MediaItem, Post } from '../../../packages/shared/src/types';
import {
  betterClock,
  clockSample,
  driftFix,
  expectedPositionMs,
  isNewerPlayback,
  WATCH_HEARTBEAT_MS,
  WATCH_MAX_MEMBERS,
  type WatchPlayback,
  type WatchQueueItem,
  type WatchReaction,
  type WatchSession,
  type WatchSkipReason,
  type WatchSummary,
} from '../../../packages/shared/src/watch';
import { client, errorMessage, mediaUrl } from './api';
import { useT, type Translator } from './i18n';
import { tr } from './locale';
import { REACTION_ICON } from './rooms';
import { useRealtime, useSession } from './session';
import { radius, space } from './theme';
import { Avatar, BottomSheet, Button, Icon, Notice, useColors, userText } from './ui';

/**
 * Watch together on the phone: the chat picker that starts a session from a reel or a video
 * post, the banner a chat shows while one runs, and the sync engine the watch screen
 * (app/watch/[id].tsx) plays with. The shared clock and drift rules are in
 * packages/shared/src/watch.ts; this file only applies them to an expo-video player.
 */

type Api = Awaited<ReturnType<typeof client>>;
type Control = Parameters<Api['watch']['control']>[1];

/** The video in a post (a reel or a video post), if it has one. */
export const videoOf = (p: Post): MediaItem | undefined => p.media.find((m) => m.kind === 'video');

/** Whether a post can go in a watch together queue: published, not locked, with a video. */
export const canWatch = (p: Post) => !p.status && !p.locked && !!videoOf(p);

/** What a player loads: on Data saver the lowest MP4 (or the 360p stream), otherwise the web MP4, as reels do. */
export const watchSource = (m: MediaItem, saver: boolean) =>
  mediaUrl(saver ? (m.variants?.mp4_360 ?? hls360(m) ?? m.variants?.mp4 ?? m.url) : (m.variants?.mp4 ?? m.url));

/** A small picture for a post: its first photo, or its video's poster. Sensitive media gets none. */
export function postThumb(p: Post): string | null {
  const image = p.media.find((m) => m.kind === 'image' && !m.sensitive);
  if (image) return mediaUrl(image.variants?.thumb ?? image.variants?.medium ?? image.url);
  const video = p.media.find((m) => m.kind === 'video' && !m.sensitive);
  const poster = video?.variants?.thumb ?? video?.posterUrl;
  return poster ? mediaUrl(poster) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The post id in a pasted link: a reel (`/reels?start=<id>` or `/reels/<id>`), a post
 * (`/p/<id>`), or a bare id. Null for anything else.
 */
export function postIdFromLink(text: string): string | null {
  const s = text.trim();
  if (UUID.test(s)) return s.toLowerCase();
  const m = /[?&]start=([0-9a-f-]{36})/i.exec(s) ?? /\/(?:p|post|posts|reels?)\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(s);
  return m && UUID.test(m[1]!) ? m[1]!.toLowerCase() : null;
}

/** The note for items that didn't go in the queue (or were passed over), one line per reason. */
export function skippedNotes(reasons: readonly WatchSkipReason[], { t, tp }: Pick<Translator, 't' | 'tp'>): string[] {
  const hidden = reasons.filter((r) => r === 'not_visible').length;
  const out: string[] = hidden ? [tp('watch.skipped', hidden)] : [];
  for (const r of new Set(reasons)) if (r !== 'not_visible') out.push(t(`watch.skip.${r}` as MessageKey));
  return out;
}

/** Open the watch screen; `skipped` notes (from starting it) show there once. */
export function openWatch(id: string, skipped: readonly WatchSkipReason[] = []) {
  const params: Record<string, string> = { id };
  if (skipped.length) params.skipped = [...new Set(skipped)].join(',');
  router.push({ pathname: '/watch/[id]', params });
}

/** Start watching together in a chat (or join the session already running there) and open it. */
export async function startWatch(conversationId: string, postIds: string[] = []) {
  const r = await (await client()).watch.start(conversationId, postIds);
  openWatch(
    r.session.id,
    r.skipped.map((s) => s.reason),
  );
}

/** Watch together works in one-to-one chats and groups of up to 8 people. */
export const watchableChat = (c: Pick<Conversation, 'kind' | 'members'>) => c.kind === 'direct' || c.kind === 'group';
export const chatTooBig = (c: Pick<Conversation, 'members'>) => c.members.length > WATCH_MAX_MEMBERS;

const chatName = (c: Conversation, meId: string | undefined) =>
  c.title ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(', ') ||
    tr('m.chat.justYou'));

/**
 * "Watch together" from a reel or a video post: `open([postId])` shows the chats to pick from,
 * and `{sheet}` goes somewhere in what the component renders.
 */
export function useWatchStart() {
  const [postIds, setPostIds] = useState<string[] | null>(null);
  const open = useCallback((ids: string[]) => setPostIds(ids), []);
  const close = useCallback(() => setPostIds(null), []);
  const sheet = postIds ? <ChatPicker postIds={postIds} onClose={close} /> : null;
  return { open, sheet };
}

function ChatPicker({ postIds, onClose }: { postIds: string[]; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void client()
      .then((api) => api.conversations.list())
      .then(
        (r) => live && setChats(r.items.filter(watchableChat)),
        (e) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, []);

  async function pick(chat: Conversation) {
    if (busy) return;
    setBusy(chat.id);
    setError(null);
    try {
      const r = await (await client()).watch.start(chat.id, postIds);
      onClose();
      openWatch(
        r.session.id,
        r.skipped.map((s) => s.reason),
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <BottomSheet visible title={t('watch.pickChat')} subtitle={t('watch.pickChatHint')} onClose={onClose} gap={space[2]}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {chats === null && !error ? <ActivityIndicator accessibilityLabel={t('common.loading')} color={c.yapi} style={{ padding: space[4] }} /> : null}
      {chats && !chats.length ? <Text style={{ color: c.inkMuted, lineHeight: 20, paddingVertical: space[2] }}>{t('watch.noChats')}</Text> : null}
      {chats?.map((chat) => {
        const big = chatTooBig(chat);
        const name = chatName(chat, me?.id);
        const other = chat.kind === 'direct' ? chat.members.find((m) => m.id !== me?.id) : undefined;
        return (
          <Pressable
            key={chat.id}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityHint={big ? t('watch.chatTooBig') : undefined}
            accessibilityState={{ disabled: big || !!busy, busy: busy === chat.id }}
            disabled={big || !!busy}
            onPress={() => void pick(chat)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              minHeight: 56,
              paddingHorizontal: space[2],
              borderRadius: radius.md,
              backgroundColor: pressed ? c.surfaceSunken : 'transparent',
              opacity: big ? 0.5 : 1,
            })}
          >
            <Avatar name={name} url={other?.avatarUrl} size={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={[{ color: c.ink, fontSize: 15, fontWeight: '600' }, userText]}>
                {name}
              </Text>
              {big ? <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>{t('watch.chatTooBig')}</Text> : null}
            </View>
            {busy === chat.id ? <ActivityIndicator color={c.yapi} /> : <Icon name="tv-outline" size={20} color={big ? c.inkMuted : c.yapi} />}
          </Pressable>
        );
      })}
    </BottomSheet>
  );
}

/**
 * The session running in a chat, kept fresh: on open, when coming back to the chat, and when
 * one starts or ends there.
 */
export function useChatWatch(conversationId: string) {
  const [summary, setSummary] = useState<WatchSummary | null>(null);
  const load = useCallback(async () => {
    try {
      setSummary((await (await client()).watch.forChat(conversationId)).session);
    } catch {
      // The banner is extra: the chat works without it.
    }
  }, [conversationId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const current = useRef<string | null>(null);
  current.current = summary?.id ?? null;
  useRealtime((e) => {
    if ((e.type === 'watch.started' || e.type === 'watch.ended') && e.data?.conversationId === conversationId) void load();
    else if (e.type === 'watch.updated' && current.current && e.data?.sessionId === current.current) void load();
    else if (e.type === 'app.foreground') void load();
  });
  return { summary, reload: load };
}

/** At the top of a chat while a session runs: "Watching together now", how many, and Join. */
export function WatchBanner({ summary }: { summary: WatchSummary }) {
  const c = useColors();
  const { t, tp } = useT();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        paddingStart: space[4],
        paddingEnd: space[3],
        paddingVertical: space[2],
        backgroundColor: c.yapiSoft,
        borderBottomWidth: 1,
        borderBottomColor: c.line,
      }}
    >
      <Icon name="tv-outline" size={20} color={c.yapi} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontWeight: '700', fontSize: 14 }}>{t('watch.now')}</Text>
        {summary.watching.length ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{tp('watch.watching', summary.watching.length)}</Text> : null}
      </View>
      <Button label={t('watch.join')} size="sm" icon="play" onPress={() => openWatch(summary.id)} />
    </View>
  );
}

/** A reaction rising over the video for a moment; with Reduce Motion it only fades in and out where it is. */
export function FloatingReaction({ kind, x, reduce }: { kind: WatchReaction; x: number; reduce: boolean }) {
  const c = useColors();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const a = Animated.timing(v, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [v]);
  const opacity = v.interpolate({ inputRange: [0, 0.12, 0.7, 1], outputRange: [0, 1, 1, 0] });
  const transform = reduce
    ? []
    : [
        { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -150] }) },
        { scale: v.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0.6, 1.1, 1] }) },
      ];
  return (
    <Animated.View style={{ position: 'absolute', bottom: space[4], start: `${x}%`, opacity, transform }}>
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(5,6,11,0.45)', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={REACTION_ICON[kind]} size={26} color={kind === 'heart' ? '#FF5C7A' : c.onYapi} />
      </View>
    </Animated.View>
  );
}

// ── The sync engine ─────────────────────────────────────────────────────

type Floating = { id: number; kind: WatchReaction; x: number };

/** How long a seek or play we made ourselves counts as ours (its end-of-video event isn't someone pressing Next). */
const GUARD_MS = 800;
/** Drift is checked this often while the video plays. */
const DRIFT_TICK_MS = 1000;
/** A clock sample ages this much per heartbeat, so a newer one eventually replaces it. */
const CLOCK_AGE_MS = 50;

/**
 * Plays one watch together session in sync with everyone else.
 *
 * - Joins on open, leaves when the screen closes (or with `leave`).
 * - Estimates the server's clock from the round trip of every request that returns
 *   `serverTime`, keeping the least uncertain sample (`betterClock`).
 * - Keeps the shared playback, taking a new one only when it's newer (`isNewerPlayback`), and
 *   brings the player in line: the right item, playing or paused, at the right place.
 * - Every second while playing, people who aren't the host correct drift (a small nudge of the
 *   speed, or a seek when far off); the host's player is the clock and only moves on a new state.
 * - Heartbeats every WATCH_HEARTBEAT_MS; the host's carry its position.
 * - Only the buttons on the watch screen send play, pause, seek and next. What the sync does to
 *   the player itself never sends anything (`guard`), so players can't bounce changes back and forth.
 * - With Data saver on, nothing loads until the person presses play (`needsTap`).
 */
export function useWatchSync(id: string, { saver }: { saver: boolean }) {
  const { t, tp } = useT();
  const { me } = useSession();
  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.5;
  });

  const [session, setSession] = useState<WatchSession | null>(null);
  const [playback, setPlayback] = useState<WatchPlayback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [joined, setJoined] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Floating[]>([]);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [time, setTime] = useState({ positionMs: 0, durationMs: 0 });

  // Everything the timers, events and callbacks read lives in refs, so none of them see stale state.
  const sessionRef = useRef<WatchSession | null>(null);
  const pbRef = useRef<WatchPlayback | null>(null);
  const clock = useRef<{ offset: number; rtt: number } | null>(null);
  const clockAge = useRef(0);
  const loadedItem = useRef<string | null>(null);
  const ready = useRef(false);
  const started = useRef(false);
  const guardUntil = useRef(0);
  const joinedRef = useRef(false);
  const endedRef = useRef(false);
  const mounted = useRef(true);
  const fetching = useRef<Promise<WatchSession | null> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const reactionId = useRef(0);
  /** The item a refetch was last made for because the queue didn't have it. */
  const missing = useRef<string | null>(null);
  const again = useRef(false);
  const meRef = useRef<string | null>(null);
  meRef.current = me?.id ?? null;
  const saverRef = useRef(saver);
  saverRef.current = saver;
  const tRef = useRef({ t, tp });
  tRef.current = { t, tp };

  const later = (fn: () => void, ms: number) => {
    const h = setTimeout(() => {
      timers.current.delete(h);
      if (mounted.current) fn();
    }, ms);
    timers.current.add(h);
  };

  const serverNow = () => Date.now() + (clock.current?.offset ?? 0);
  const sample = (sentAt: number, serverTime: number) => {
    const s = clockSample(sentAt, Date.now(), serverTime);
    const next = betterClock(clock.current, s, clockAge.current * CLOCK_AGE_MS);
    if (next === s) clockAge.current = 0;
    clock.current = next;
  };
  const isHost = () => !!meRef.current && sessionRef.current?.hostId === meRef.current;
  const localMs = () => Math.max(0, Math.round((player.currentTime || 0) * 1000));
  const durationMs = () => (Number.isFinite(player.duration) && player.duration > 0 ? player.duration * 1000 : null);
  /** Something the sync does to the player (not the person): marked so its events send nothing. */
  const ours = (fn: () => void) => {
    guardUntil.current = Date.now() + GUARD_MS;
    try {
      fn();
    } catch {
      // The player was released (the screen is closing).
    }
  };
  const seekTo = (ms: number) => ours(() => void (player.currentTime = ms / 1000));
  const itemOf = (pb: WatchPlayback | null): WatchQueueItem | null => (pb?.itemId ? (sessionRef.current?.queue.find((q) => q.id === pb.itemId) ?? null) : null);

  const flash = useCallback((text: string) => {
    setNotice(text);
    const h = setTimeout(() => {
      timers.current.delete(h);
      if (mounted.current) setNotice((n) => (n === text ? null : n));
    }, 4500);
    timers.current.add(h);
  }, []);
  const flashSkipped = useCallback(
    (reasons: readonly WatchSkipReason[]) => {
      const lines = skippedNotes(reasons, tRef.current);
      if (lines.length) flash(lines.join('\n'));
    },
    [flash],
  );

  const markEnded = () => {
    endedRef.current = true;
    joinedRef.current = false;
    setEnded(true);
    setJoined(false);
    setNeedsTap(false);
    ours(() => player.pause());
  };

  /** Bring the player in line with the shared playback. `hard`: a new state (or a fresh load), so the host lines up too. */
  const align = (hard: boolean) => {
    const pb = pbRef.current;
    if (!pb || endedRef.current || !mounted.current) return;
    if (!pb.itemId) {
      setNeedsTap(false);
      ours(() => player.pause());
      return;
    }
    const item = itemOf(pb);
    if (!item) {
      // A new item we don't have in the queue yet: read the session again (once per item).
      if (missing.current !== pb.itemId) {
        missing.current = pb.itemId;
        void refetch();
      }
      return;
    }
    const allowed = started.current || !saverRef.current;
    setNeedsTap(!allowed);
    if (!allowed) return;
    if (loadedItem.current !== item.id) {
      const media = videoOf(item.post);
      if (!media) return;
      loadedItem.current = item.id;
      ready.current = false;
      setTime({ positionMs: 0, durationMs: 0 });
      ours(() => void player.replaceAsync({ uri: watchSource(media, saverRef.current) }).catch(() => {}));
      // statusChange (readyToPlay) comes back here to seek and play.
      return;
    }
    if (!ready.current) return;
    const expected = expectedPositionMs(pb, serverNow(), durationMs());
    if (pb.playing) {
      if (!isHost() || hard) {
        // After a change of state, jump straight there; otherwise catch up gently.
        const fix = driftFix(localMs(), expected, !hard);
        if (fix.kind === 'seek') {
          seekTo(fix.toMs);
          if (!hard) showSyncing();
        }
      }
      if (!player.playing) ours(() => player.play());
    } else {
      ours(() => {
        if (player.playing) player.pause();
        player.playbackRate = 1;
      });
      const fix = driftFix(localMs(), expected, false);
      if (fix.kind === 'seek') seekTo(fix.toMs);
    }
  };

  const showSyncing = () => {
    setSyncing(true);
    later(() => setSyncing(false), 1500);
  };

  const takePlayback = (pb: WatchPlayback) => {
    const cur = pbRef.current;
    if (!isNewerPlayback(pb, cur)) return false;
    const hard = !cur || pb.seq !== cur.seq || pb.itemId !== cur.itemId;
    pbRef.current = pb;
    setPlayback(pb);
    align(hard);
    return true;
  };

  const takeSession = (s: WatchSession) => {
    const before = sessionRef.current;
    sessionRef.current = s;
    setSession(s);
    if (before && s.hostId && before.hostId !== s.hostId) {
      if (s.hostId === meRef.current) flash(tRef.current.t('watch.youHostNow'));
      else {
        const host = s.watching.find((u) => u.id === s.hostId) ?? s.members.find((u) => u.id === s.hostId);
        if (host) flash(tRef.current.t('watch.hostPassed', { name: host.displayName }));
      }
    }
    if (s.status === 'ended') return markEnded();
    // The queue may now have the item on screen: line up even when the playback itself isn't newer.
    if (!takePlayback(s.playback)) align(false);
  };

  const refetch = (): Promise<WatchSession | null> => {
    if (fetching.current) {
      // A change arrived while reading: read once more after this one.
      again.current = true;
      return fetching.current;
    }
    const run = (async () => {
      try {
        const sent = Date.now();
        const r = await (await client()).watch.get(id);
        sample(sent, r.session.serverTime);
        if (mounted.current) takeSession(r.session);
        return r.session;
      } catch (e) {
        onError(e);
        return null;
      } finally {
        fetching.current = null;
        if (again.current && mounted.current) {
          again.current = false;
          void fns.current.refetch();
        }
      }
    })();
    fetching.current = run;
    return run;
  };

  /** The API says we aren't watching (away too long): join again, unless the person left on purpose. */
  const rejoin = async () => {
    if (endedRef.current || !mounted.current || !joinedRef.current) return;
    try {
      const sent = Date.now();
      const r = await (await client()).watch.join(id);
      sample(sent, r.session.serverTime);
      joinedRef.current = true;
      if (mounted.current) takeSession(r.session);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 410 || e.code === 'watch_ended')) markEnded();
    }
  };

  function onError(e: unknown) {
    if (!mounted.current) return;
    if (e instanceof ApiError && (e.status === 410 || e.code === 'watch_ended')) return markEnded();
    if (e instanceof ApiError && e.code === 'watch_not_watching') return void rejoin();
    flash(errorMessage(e));
  }

  // Keep the latest closures for the timers and the realtime listener.
  const fns = useRef({ align, takePlayback, takeSession, refetch, onError, rejoin });
  fns.current = { align, takePlayback, takeSession, refetch, onError, rejoin };

  const open = useCallback(async () => {
    setError(null);
    try {
      const api = await client();
      const sent = Date.now();
      const r = await api.watch.join(id);
      sample(sent, r.session.serverTime);
      if (!mounted.current) {
        // Closed while joining: leave again.
        void api.watch.leave(id).catch(() => {});
        return;
      }
      joinedRef.current = true;
      setJoined(true);
      fns.current.takeSession(r.session);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 410 || e.code === 'watch_ended')) {
        markEnded();
        // Still read it, for the way back to the chat.
        try {
          const r = await (await client()).watch.get(id);
          sessionRef.current = r.session;
          if (mounted.current) setSession(r.session);
        } catch {
          // Nothing more to show.
        }
        return;
      }
      if (mounted.current) setError(errorMessage(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Join on open; leave (and stop every timer) when the screen closes.
  useEffect(() => {
    mounted.current = true;
    started.current = !saverRef.current;
    void open();
    const pending = timers.current;
    return () => {
      mounted.current = false;
      for (const h of pending) clearTimeout(h);
      pending.clear();
      if (joinedRef.current && !endedRef.current) {
        joinedRef.current = false;
        void client()
          .then((api) => api.watch.leave(id))
          .catch(() => {});
      }
    };
  }, [id, open]);

  // Heartbeats: "still here", and the host's position (only while its own player really plays the shared item).
  useEffect(() => {
    if (!joined || ended) return;
    const beat = async () => {
      clockAge.current++;
      const pb = pbRef.current;
      let body: { positionMs?: number; itemId?: string | null; seq?: number; atServerMs?: number } = {};
      let playingNow = false;
      try {
        playingNow = player.playing;
      } catch {
        return;
      }
      if (isHost() && pb?.playing && pb.itemId && loadedItem.current === pb.itemId && ready.current && playingNow)
        body = { positionMs: localMs(), itemId: pb.itemId, seq: pb.seq, atServerMs: Math.round(serverNow()) };
      try {
        const sent = Date.now();
        const r = await (await client()).watch.heartbeat(id, body);
        sample(sent, r.serverTime);
      } catch (e) {
        fns.current.onError(e);
      }
    };
    const h = setInterval(() => void beat(), WATCH_HEARTBEAT_MS);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, ended, id]);

  // Drift: every second while the shared playback plays.
  useEffect(() => {
    if (!joined || ended) return;
    const h = setInterval(() => {
      const pb = pbRef.current;
      if (!pb?.playing || !pb.itemId || loadedItem.current !== pb.itemId || !ready.current) return;
      if (saverRef.current && !started.current) return;
      try {
        const dur = durationMs();
        const local = localMs();
        // At the very end: let it finish (the end moves everyone to the next item).
        if (dur && local >= dur - 300) return;
        if (!player.playing) ours(() => player.play());
        if (isHost()) {
          if (player.playbackRate !== 1) player.playbackRate = 1;
          return;
        }
        const expected = expectedPositionMs(pb, serverNow(), dur);
        if (dur && expected >= dur - 300) return;
        const fix = driftFix(local, expected, true);
        if (fix.kind === 'seek') {
          seekTo(fix.toMs);
          showSyncing();
        } else if (player.playbackRate !== fix.rate) player.playbackRate = fix.rate;
      } catch {
        // The player was released.
      }
    }, DRIFT_TICK_MS);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, ended]);

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && !ready.current && loadedItem.current) {
      ready.current = true;
      fns.current.align(true);
    }
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => setLocalPlaying(isPlaying));
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    const d = durationMs();
    setTime({ positionMs: Math.round(currentTime * 1000), durationMs: d ? Math.round(d) : 0 });
  });
  // The video ran to its end: move everyone on (once, however many players get there together).
  useEventListener(player, 'playToEnd', () => {
    if (Date.now() < guardUntil.current) return;
    const pb = pbRef.current;
    if (!pb?.playing || !pb.itemId || loadedItem.current !== pb.itemId) return;
    void control({ action: 'next', fromItemId: pb.itemId });
  });

  useRealtime((e) => {
    const d = e.data;
    if (e.type === 'app.foreground') {
      if (joinedRef.current) void fns.current.refetch();
      return;
    }
    if (!d || d.sessionId !== id) return;
    if (e.type === 'watch.playback' && d.playback) {
      fns.current.takePlayback(d.playback as WatchPlayback);
      if (Array.isArray(d.skipped) && d.skipped.length) flashSkipped(d.skipped as WatchSkipReason[]);
    } else if (e.type === 'watch.updated') void fns.current.refetch();
    else if (e.type === 'watch.ended') markEnded();
    else if (e.type === 'watch.reaction' && d.kind && REACTION_ICON[d.kind as WatchReaction]) {
      const rid = ++reactionId.current;
      setReactions((list) => [...list.slice(-9), { id: rid, kind: d.kind as WatchReaction, x: 8 + Math.random() * 72 }]);
      later(() => setReactions((list) => list.filter((x) => x.id !== rid)), 2600);
    }
  });

  // ── What the person does ──
  async function control(c: Control) {
    try {
      const api = await client();
      const sent = Date.now();
      const r = await api.watch.control(id, c);
      sample(sent, r.serverTime);
      if (!mounted.current) return;
      fns.current.takePlayback(r.playback);
      if (r.skipped.length) flashSkipped(r.skipped);
    } catch (e) {
      fns.current.onError(e);
    }
  }

  /** Where the person is: their player's position when it has the shared item, or where the shared playback says. */
  const positionNow = () => {
    const pb = pbRef.current;
    if (pb?.itemId && loadedItem.current === pb.itemId && ready.current) return localMs();
    return pb ? Math.round(expectedPositionMs(pb, serverNow())) : 0;
  };

  const play = useCallback(async () => {
    const pb = pbRef.current;
    started.current = true;
    setNeedsTap(false);
    if (!pb?.itemId) return flash(tRef.current.t('watch.nothingOn'));
    if (ready.current && loadedItem.current === pb.itemId) ours(() => player.play());
    else fns.current.align(true);
    await control({ action: 'play', positionMs: positionNow(), atServerMs: Math.round(serverNow()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash, player]);

  const pause = useCallback(async () => {
    if (!pbRef.current?.itemId) return;
    ours(() => player.pause());
    await control({ action: 'pause', positionMs: positionNow(), atServerMs: Math.round(serverNow()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  const seekBy = useCallback(
    async (deltaMs: number) => {
      if (!pbRef.current?.itemId) return;
      const dur = durationMs();
      const target = Math.max(0, Math.min(positionNow() + deltaMs, dur ? dur - 500 : Number.POSITIVE_INFINITY));
      if (ready.current) seekTo(target);
      await control({ action: 'seek', positionMs: Math.round(target), atServerMs: Math.round(serverNow()) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player],
  );

  const next = useCallback(async () => {
    const itemId = pbRef.current?.itemId;
    await control(itemId ? { action: 'next', fromItemId: itemId } : { action: 'next' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jump = useCallback(async (itemId: string) => {
    started.current = true;
    await control({ action: 'jump', itemId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Data saver: start this player (the shared playback goes on as it is). */
  const joinPlayback = useCallback(() => {
    started.current = true;
    setNeedsTap(false);
    fns.current.align(true);
  }, []);

  const react = useCallback(
    async (kind: WatchReaction) => {
      try {
        await (await client()).watch.react(id, kind);
      } catch (e) {
        fns.current.onError(e);
      }
    },
    [id],
  );

  /** Add posts by id; says what went in and what was skipped. True when something was added. */
  const add = useCallback(
    async (postIds: string[]) => {
      try {
        const r = await (await client()).watch.add(id, postIds);
        fns.current.takeSession(r.session);
        const lines = [
          ...(r.added.length ? [tRef.current.t('watch.added')] : []),
          ...skippedNotes(
            r.skipped.map((s) => s.reason),
            tRef.current,
          ),
        ];
        if (lines.length) flash(lines.join('\n'));
        return r.added.length > 0;
      } catch (e) {
        fns.current.onError(e);
        return false;
      }
    },
    [id, flash],
  );

  const remove = useCallback(
    async (itemId: string) => {
      try {
        fns.current.takeSession((await (await client()).watch.remove(id, itemId)).session);
      } catch (e) {
        fns.current.onError(e);
      }
    },
    [id],
  );

  const leave = useCallback(async () => {
    const was = joinedRef.current;
    joinedRef.current = false;
    setJoined(false);
    ours(() => player.pause());
    if (was) await (await client()).watch.leave(id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, player]);

  const end = useCallback(async () => {
    try {
      await (await client()).watch.end(id);
      markEnded();
    } catch (e) {
      fns.current.onError(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const current = playback?.itemId ? (session?.queue.find((q) => q.id === playback.itemId) ?? null) : null;
  const host = !!me && session?.hostId === me.id;

  return {
    player,
    session,
    playback,
    current,
    host,
    error,
    ended,
    joined,
    needsTap,
    syncing,
    notice,
    reactions,
    playing: localPlaying,
    time,
    retry: open,
    flash,
    flashSkipped,
    play,
    pause,
    seekBy,
    next,
    jump,
    joinPlayback,
    react,
    add,
    remove,
    leave,
    end,
  };
}
