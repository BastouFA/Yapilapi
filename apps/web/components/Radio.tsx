'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Avatar, Button, Icon, useDataSaver } from '@yapilapi/design-system';
import {
  baseLanguage,
  clipBytes,
  listenFinished,
  needsTranslation,
  nextVoiceRate,
  parseStationId,
  radioBack,
  radioOutcome,
  readResume,
  RADIO_GAP_MS,
  RADIO_PAGE,
  RADIO_REFILL_AT,
  stationId,
  type MessageKey,
  type Post,
  type RadioResume,
  type RadioStation,
  type RadioStationInfo,
  type VoiceRate,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { recordFeedEvent } from '@/lib/feed-events';

/**
 * Yap Radio (docs/product/yap-radio.md): press play once and listen hands-free, one Yap after
 * another. One audio element for the whole app shell, so it keeps playing from page to page;
 * the bar at the bottom (RadioBar) and the Radio page (/radio) show and steer it. Listening is
 * reported with the surface 'radio' (a quick skip tells the recommender "not this"), the operating
 * system's media controls work through the Media Session API, and where you were is kept on this
 * device to carry on next time.
 */

const RESUME_KEY = 'yp.radio.resume';
const LANGUAGE_KEY = 'yp.radio.myLanguage';
/** How often where you are is written down while playing. */
const KEEP_MS = 5000;

export interface RadioState {
  station: RadioStationInfo | null;
  queue: Post[];
  index: number;
  current: Post | null;
  playing: boolean;
  /** Asking for Yaps (the first ones, or more at the end of the queue). */
  loading: boolean;
  /** Nothing (more) to play on this station. */
  ended: boolean;
  /** Near you with no place to go by. */
  needsPlace: boolean;
  error: string | null;
  positionMs: number;
  durationMs: number;
  rate: VoiceRate;
  /** When the sleep timer stops the radio (ms since the epoch), or null. */
  sleepAt: number | null;
  /** "Listen in my language": play Yaps you don't understand read out in your language. */
  myLanguage: boolean;
  /** This Yap is playing read out in your language. */
  spoken: boolean;
  /** About how much was downloaded this session. */
  bytes: number;
  following: ReadonlySet<string>;
  /** A Yap was left unfinished on this device last time. */
  resume: RadioResume | null;
}

export interface Radio extends RadioState {
  /** Start a station (or, with none, carry on where you left off, else For you). */
  play: (station?: RadioStation) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  stop: () => void;
  changeRate: () => void;
  setSleep: (minutes: number | null) => void;
  setMyLanguage: (on: boolean) => void;
  like: () => void;
  follow: () => void;
  /** The station's name in the listener's language. */
  stationName: (s: RadioStationInfo | RadioStation | null) => string;
}

const RadioContext = createContext<Radio | null>(null);

/** The radio, from anywhere inside the app shell (null outside it, or while it's turned off). */
export function useRadio(): Radio | null {
  return useContext(RadioContext);
}

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function store(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage: the radio works without remembering.
  }
}

const NAMES: Record<string, MessageKey> = { for_you: 'feed.for_you', friends: 'feed.friends', near: 'map.title', topics: 'onboarding.topics' };

/** Where a listen stood when it ended: what was heard, how far it got, and whether its finish was sent. */
interface Listen {
  postId: string;
  heardMs: number;
  furthestMs: number;
  last: number;
  completed: boolean;
}

export function RadioProvider({ children }: { children: ReactNode }) {
  const { t, flags, me, locale, voice, toast } = useSession();
  const saver = useDataSaver();
  const on = flags.YAPS !== false && flags.YAP_RADIO !== false && !!me;

  const audio = useRef<HTMLAudioElement | null>(null);
  const [station, setStation] = useState<RadioStationInfo | null>(null);
  const [queue, setQueue] = useState<Post[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ended, setEnded] = useState(false);
  const [needsPlace, setNeedsPlace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [rate, setRate] = useState<VoiceRate>(1);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  const [myLanguage, setMyLanguageState] = useState(false);
  const [src, setSrc] = useState<{ postId: string; url: string; spoken: boolean } | null>(null);
  const [bytes, setBytes] = useState(0);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [resume, setResume] = useState<RadioResume | null>(null);

  // What the event handlers need without waiting for a render.
  const cursor = useRef<string | null>(null);
  const fetching = useRef(false);
  const stationRef = useRef<RadioStation | null>(null);
  const queueRef = useRef<Post[]>([]);
  const indexRef = useRef(0);
  const listen = useRef<Listen | null>(null);
  const seekTo = useRef<number | null>(null);
  const gap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoplay = useRef(false);
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;
  queueRef.current = queue;
  indexRef.current = index;
  const current = queue[index] ?? null;

  useEffect(() => {
    setResume(readResume(readStored(RESUME_KEY)));
    setMyLanguageState(readStored<boolean>(LANGUAGE_KEY) === true);
  }, []);

  const stationName = useCallback(
    (s: RadioStationInfo | RadioStation | null) => {
      if (!s) return t('radio.title');
      const title = 'title' in s ? s.title : null;
      if (title) return title;
      if (s.kind === 'topics' && s.key) return `#${s.key}`;
      const key = NAMES[s.kind];
      return key ? t(key) : t('radio.title');
    },
    [t],
  );

  // ── Listening, for the recommender ────────────────────────────────────
  /** The current listen is over: what was heard, a finish, or a quick skip when the listener skipped. */
  const endListen = useCallback((skipped: boolean) => {
    const l = listen.current;
    listen.current = null;
    if (!l) return;
    if (l.heardMs > 0) recordFeedEvent({ postId: l.postId, surface: 'radio', kind: 'listen', valueMs: l.heardMs });
    const el = audio.current;
    const total = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : 0;
    if (skipped && radioOutcome(l.heardMs, l.furthestMs, total) === 'skip') recordFeedEvent({ postId: l.postId, surface: 'radio', kind: 'skip' });
  }, []);

  const keep = useCallback(() => {
    const s = stationRef.current;
    const p = queueRef.current[indexRef.current];
    const el = audio.current;
    if (!s || !p || !el) return;
    const r: RadioResume = { station: stationId(s), postId: p.id, positionMs: Math.round(el.currentTime * 1000), at: Date.now() };
    store(RESUME_KEY, r);
    setResume(r);
  }, []);

  // ── The queue ─────────────────────────────────────────────────────────
  const fetchMore = useCallback(
    async (s: RadioStation, first: { start?: string | null } | null) => {
      if (fetching.current) return;
      fetching.current = true;
      setLoading(true);
      try {
        const page = await api.radio.next(s, { cursor: first ? null : cursor.current, limit: RADIO_PAGE, start: first?.start ?? null });
        if (stationRef.current !== s) return;
        cursor.current = page.nextCursor;
        setStation(page.station);
        setNeedsPlace(!!page.needsPlace);
        setFollowing((f) => new Set([...f, ...page.following]));
        const seen = new Set(first ? [] : queueRef.current.map((p) => p.id));
        const fresh = page.items.filter((p) => !seen.has(p.id));
        const nextQueue = first ? fresh : [...queueRef.current, ...fresh];
        queueRef.current = nextQueue;
        setQueue(nextQueue);
        // Nothing to play at all, or nothing more where the queue was waiting at its end.
        if (first ? !fresh.length : indexRef.current >= nextQueue.length) {
          setEnded(true);
          // Started from a profile, a tag or a place: say so there (the Radio page says it itself).
          if (first && pathRef.current !== '/radio') toast(t(page.needsPlace ? 'radio.nearNone' : 'radio.empty'));
        }
      } catch (e) {
        if (stationRef.current === s) setError(errorMessage(e));
      } finally {
        fetching.current = false;
        setLoading(false);
      }
    },
    [toast, t],
  );

  const play = useCallback(
    (wanted?: RadioStation) => {
      const kept = readResume(readStored(RESUME_KEY));
      const s = wanted ?? parseStationId(kept?.station) ?? { kind: 'for_you', key: null };
      const resumeHere = kept && kept.station === stationId(s) ? kept : null;
      endListen(true);
      if (gap.current) clearTimeout(gap.current);
      stationRef.current = s;
      cursor.current = null;
      queueRef.current = [];
      indexRef.current = 0;
      setQueue([]);
      setIndex(0);
      setStation({ kind: s.kind, key: s.key ?? null, title: null });
      setEnded(false);
      setNeedsPlace(false);
      setError(null);
      setPositionMs(0);
      seekTo.current = resumeHere?.positionMs ?? null;
      autoplay.current = true;
      audio.current?.pause();
      void fetchMore(s, { start: resumeHere?.postId ?? null });
    },
    [endListen, fetchMore],
  );

  const go = useCallback(
    (to: number, skipped: boolean) => {
      if (gap.current) clearTimeout(gap.current);
      endListen(skipped);
      autoplay.current = true;
      seekTo.current = null;
      setPositionMs(0);
      const q = queueRef.current;
      if (to >= q.length) {
        // The end of what's here: more if there is more, otherwise the station is done.
        if (cursor.current && stationRef.current) {
          indexRef.current = to;
          setIndex(to);
          void fetchMore(stationRef.current, null);
        } else {
          setEnded(true);
          setPlaying(false);
          audio.current?.pause();
        }
        return;
      }
      indexRef.current = Math.max(0, to);
      setIndex(Math.max(0, to));
    },
    [endListen, fetchMore],
  );

  const next = useCallback(() => go(indexRef.current + 1, true), [go]);
  const previous = useCallback(() => {
    const el = audio.current;
    if (radioBack((el?.currentTime ?? 0) * 1000, indexRef.current) === 'restart') {
      if (el) el.currentTime = 0;
      setPositionMs(0);
      return;
    }
    go(indexRef.current - 1, false);
  }, [go]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!stationRef.current) return play();
    if (!el || !src) return;
    if (el.paused) {
      autoplay.current = true;
      void el.play().catch(() => setPlaying(false));
    } else el.pause();
  }, [play, src]);

  const stop = useCallback(() => {
    keep();
    endListen(false);
    if (gap.current) clearTimeout(gap.current);
    audio.current?.pause();
    stationRef.current = null;
    queueRef.current = [];
    setQueue([]);
    setIndex(0);
    setStation(null);
    setSrc(null);
    setPlaying(false);
    setSleepAt(null);
    setEnded(false);
  }, [endListen, keep]);

  const seek = useCallback((ms: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    setPositionMs(Math.max(0, ms));
  }, []);

  // More before the queue runs out (on Data saver, only once it has: go() asks then).
  useEffect(() => {
    const s = stationRef.current;
    if (!s || saver || !cursor.current || fetching.current) return;
    if (queue.length - index - 1 <= RADIO_REFILL_AT) void fetchMore(s, null);
  }, [index, queue.length, saver, fetchMore]);

  // The Yap to play: its clip, or its words read out in your language.
  const speakOn = myLanguage && voice.listen;
  useEffect(() => {
    if (!current?.voice) return;
    const clip = current.voice;
    const target = baseLanguage(locale);
    const spoken =
      speakOn &&
      clip.transcript.status === 'ready' &&
      !!clip.transcript.text &&
      current.author.id !== me?.id &&
      needsTranslation(clip.transcript.lang, locale, me?.translation?.languages);
    if (!spoken) {
      setSrc({ postId: current.id, url: clip.url, spoken: false });
      return;
    }
    let live = true;
    api.voice.speech(clip.id, target).then(
      (r) => live && setSrc({ postId: current.id, url: r.url, spoken: true }),
      () => live && setSrc({ postId: current.id, url: clip.url, spoken: false }),
    );
    return () => {
      live = false;
    };
  }, [current, speakOn, locale, me?.id, me?.translation?.languages]);

  // A new source: load it and, when the radio is on, play it.
  useEffect(() => {
    const el = audio.current;
    if (!el || !src) return;
    el.playbackRate = rate;
    if (seekTo.current !== null) {
      const at = seekTo.current / 1000;
      seekTo.current = null;
      el.addEventListener('loadedmetadata', () => (el.currentTime = Math.min(at, Math.max(0, el.duration - 1))), { once: true });
    }
    if (autoplay.current) void el.play().catch(() => setPlaying(false));
    // `rate` changes on its own below; a new source only here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  // Another sound starting on the page (a Yap card, a video) pauses the radio.
  useEffect(() => {
    const onPlay = (e: Event) => {
      const el = audio.current;
      if (el && e.target !== el && e.target instanceof HTMLMediaElement && !el.paused) el.pause();
    };
    document.addEventListener('play', onPlay, true);
    return () => document.removeEventListener('play', onPlay, true);
  }, []);

  // Where you are, kept while playing and when it pauses or the page goes.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(keep, KEEP_MS);
    window.addEventListener('pagehide', keep);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', keep);
    };
  }, [playing, keep]);

  // The sleep timer.
  useEffect(() => {
    if (!sleepAt) return;
    const timer = setInterval(() => {
      if (Date.now() < sleepAt) return;
      audio.current?.pause();
      setSleepAt(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [sleepAt]);

  // ── The operating system's controls (lock screen, headphones, media keys) ──
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!current) {
      ms.metadata = null;
      return;
    }
    const art = current.author.avatarUrl ? [{ src: current.author.avatarUrl, sizes: '256x256' }] : [];
    try {
      ms.metadata = new MediaMetadata({
        title: current.body.trim() || t('radio.title'),
        artist: current.author.displayName,
        album: stationName(station),
        artwork: art,
      });
    } catch {
      // Older browsers without MediaMetadata: the controls still work.
    }
  }, [current, station, stationName, t]);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = current
      ? [
          ['play', () => void audio.current?.play().catch(() => {})],
          ['pause', () => audio.current?.pause()],
          ['nexttrack', () => next()],
          ['previoustrack', () => previous()],
          ['stop', () => stop()],
          ['seekbackward', () => seek(((audio.current?.currentTime ?? 0) - 10) * 1000)],
          ['seekforward', () => seek(((audio.current?.currentTime ?? 0) + 10) * 1000)],
        ]
      : (['play', 'pause', 'nexttrack', 'previoustrack', 'stop', 'seekbackward', 'seekforward'] as MediaSessionAction[]).map((a) => [a, null]);
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // An action this browser doesn't know.
      }
    }
    ms.playbackState = current ? (playing ? 'playing' : 'paused') : 'none';
  }, [current, playing, next, previous, stop, seek]);

  // ── Keyboard: space, ← → and j k, when nothing else on the page takes the key ──
  useEffect(() => {
    if (!current) return;
    // Pages that play their own media keep their keys.
    if (/^\/(reels|live|watch|together|rooms)\b/.test(path)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      const inRadio = !!el?.closest?.('[data-radio-keys]');
      const free = !el || el === document.body || inRadio;
      if (!free || (inRadio && el?.matches?.('input, textarea, select, [contenteditable="true"], [role="slider"], button, a'))) return;
      const k = e.key;
      if (k === ' ' || k === 'Spacebar') toggle();
      else if (k === 'ArrowRight' || k === 'j' || k === 'J') next();
      else if (k === 'ArrowLeft' || k === 'k' || k === 'K') previous();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, path, toggle, next, previous]);

  // Off (an admin turned it off, or signed out): silence.
  useEffect(() => {
    if (!on && stationRef.current) stop();
  }, [on, stop]);

  const setSleep = useCallback((minutes: number | null) => setSleepAt(minutes ? Date.now() + minutes * 60_000 : null), []);
  const setMyLanguage = useCallback((v: boolean) => {
    setMyLanguageState(v);
    store(LANGUAGE_KEY, v);
  }, []);
  const changeRate = useCallback(() => setRate((r) => nextVoiceRate(r)), []);

  const like = useCallback(() => {
    const p = queueRef.current[indexRef.current];
    if (!p) return;
    const liked = !p.viewer.liked;
    const patch = (on: boolean) =>
      setQueue((q) =>
        q.map((x) =>
          x.id === p.id
            ? {
                ...x,
                viewer: { ...x.viewer, liked: on },
                counts: { ...x.counts, likes: x.counts.likes === undefined ? undefined : Math.max(0, x.counts.likes + (on ? 1 : -1)) },
              }
            : x,
        ),
      );
    patch(liked);
    (liked ? api.posts.like(p.id) : api.posts.unlike(p.id)).catch((e) => {
      patch(!liked);
      toast(errorMessage(e));
    });
  }, [toast]);

  const follow = useCallback(() => {
    const p = queueRef.current[indexRef.current];
    if (!p) return;
    const id = p.author.id;
    const was = following.has(id);
    const set = (on: boolean) =>
      setFollowing((f) => {
        const n = new Set(f);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });
    set(!was);
    (was ? api.users.unfollow(id) : api.users.follow(id)).catch((e) => {
      set(was);
      toast(errorMessage(e));
    });
  }, [following, toast]);

  // The next Yap, loaded ahead off Data saver (only that one; none on Data saver or while it's read out).
  const upcoming = !saver && !src?.spoken ? (queue[index + 1]?.voice?.url ?? null) : null;

  const value = useMemo<Radio | null>(
    () =>
      on
        ? {
            station,
            queue,
            index,
            current,
            playing,
            loading,
            ended,
            needsPlace,
            error,
            positionMs,
            durationMs,
            rate,
            sleepAt,
            myLanguage,
            spoken: !!src?.spoken && src.postId === current?.id,
            bytes,
            following,
            resume,
            play,
            toggle,
            next,
            previous,
            seek,
            stop,
            changeRate,
            setSleep,
            setMyLanguage,
            like,
            follow,
            stationName,
          }
        : null,
    [
      on,
      station,
      queue,
      index,
      current,
      playing,
      loading,
      ended,
      needsPlace,
      error,
      positionMs,
      durationMs,
      rate,
      sleepAt,
      myLanguage,
      src,
      bytes,
      following,
      resume,
      play,
      toggle,
      next,
      previous,
      seek,
      stop,
      changeRate,
      setSleep,
      setMyLanguage,
      like,
      follow,
      stationName,
    ],
  );

  return (
    <RadioContext.Provider value={value}>
      {children}
      {on ? (
        <>
          <audio
            ref={audio}
            src={src?.url}
            preload="auto"
            data-testid="radio-audio"
            hidden
            onPlay={() => {
              setPlaying(true);
              const p = queueRef.current[indexRef.current];
              if (p && listen.current?.postId !== p.id) {
                listen.current = { postId: p.id, heardMs: 0, furthestMs: 0, last: audio.current?.currentTime ?? 0, completed: false };
                recordFeedEvent({ postId: p.id, surface: 'radio', kind: 'impression' });
                recordFeedEvent({ postId: p.id, surface: 'radio', kind: 'listen_start' });
                setBytes((b) => b + clipBytes(p));
              } else if (listen.current) listen.current.last = audio.current?.currentTime ?? 0;
            }}
            onPause={() => {
              setPlaying(false);
              keep();
            }}
            onLoadedMetadata={(e) => setDurationMs(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration * 1000 : 0)}
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              const now = el.currentTime;
              setPositionMs(now * 1000);
              const l = listen.current;
              if (!l) return;
              const step = now - l.last;
              l.last = now;
              // Real listening (not a jump): counts as heard, at the speed chosen.
              if (step > 0 && step < 1.5) {
                l.heardMs += (step * 1000) / (el.playbackRate || 1);
                l.furthestMs = Math.max(l.furthestMs, now * 1000);
              }
              const total = Number.isFinite(el.duration) ? el.duration * 1000 : 0;
              if (!l.completed && total > 0 && listenFinished(l.furthestMs, total)) {
                l.completed = true;
                recordFeedEvent({ postId: l.postId, surface: 'radio', kind: 'listen_complete' });
              }
            }}
            onEnded={() => {
              setPlaying(false);
              // A short quiet, then the next one.
              gap.current = setTimeout(() => go(indexRef.current + 1, false), RADIO_GAP_MS);
            }}
            onError={() => {
              // A clip that won't play: on to the next one.
              if (src) gap.current = setTimeout(() => go(indexRef.current + 1, false), RADIO_GAP_MS);
            }}
          />
          {upcoming ? <audio src={upcoming} preload="auto" hidden aria-hidden data-testid="radio-next" /> : null}
        </>
      ) : null}
    </RadioContext.Provider>
  );
}

/** "Play as radio" on a profile, a tag, a place or a squad (or the Radio button on Pulse and in Wander). */
export function PlayAsRadio({ station, label, variant = 'secondary' }: { station: RadioStation; label?: string; variant?: 'primary' | 'secondary' | 'ghost' }) {
  const radio = useRadio();
  const { t } = useSession();
  if (!radio) return null;
  const here = radio.station && stationId(radio.station) === stationId(station) && radio.current;
  return (
    <Button
      size="sm"
      variant={variant}
      icon={here && radio.playing ? 'pause' : 'play'}
      onClick={() => (here ? radio.toggle() : radio.play(station))}
      data-testid="play-as-radio"
    >
      {label ?? t('radio.playAs')}
    </Button>
  );
}

/** The bar across the bottom of every page while the radio has a Yap: who's speaking, play or pause, next, and the way to the Radio page. */
export function RadioBar() {
  const radio = useRadio();
  const { t } = useSession();
  const path = usePathname();
  if (!radio || !radio.station || path === '/radio') return null;
  const p = radio.current;
  if (!p && !radio.loading) return null;
  const share = radio.durationMs > 0 ? Math.min(1, radio.positionMs / radio.durationMs) : 0;
  return (
    <section className="radio-bar" aria-label={t('radio.nowPlaying', { station: radio.stationName(radio.station) })} data-testid="radio-bar" data-radio-keys>
      <div className="radio-bar__progress" aria-hidden style={{ transform: `scaleX(${share})` }} />
      <NextLink href="/radio" className="radio-bar__open" aria-label={t('radio.open')}>
        {p ? <Avatar name={p.author.displayName} src={p.author.avatarUrl} size="sm" /> : <Icon name="volume" size={20} />}
        <span className="radio-bar__text">
          <span className="radio-bar__name" data-testid="radio-bar-name">
            {p?.author.displayName ?? t('radio.title')}
          </span>
          <span className="radio-bar__station">{radio.stationName(radio.station)}</span>
        </span>
      </NextLink>
      <button
        type="button"
        className="radio-bar__btn radio-bar__btn--main"
        onClick={radio.toggle}
        aria-label={radio.playing ? t('voice.pause') : t('voice.play')}
        data-testid="radio-bar-toggle"
      >
        <Icon name={radio.playing ? 'pause' : 'play'} size={20} filled />
      </button>
      <button type="button" className="radio-bar__btn" onClick={radio.next} aria-label={t('radio.next')} data-testid="radio-bar-next">
        <Icon name="skip-next" size={20} filled />
      </button>
      <button type="button" className="radio-bar__btn" onClick={radio.stop} aria-label={t('radio.stop')}>
        <Icon name="x" size={18} />
      </button>
    </section>
  );
}
