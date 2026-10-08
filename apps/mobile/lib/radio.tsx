// Yap Radio (docs/product/yap-radio.md): press play once and listen hands-free, one Yap after another,
// like radio. One player for the whole app (it keeps going from screen to screen, in the background
// and on the lock screen), the queue, the slim bar above the dock and the "Play as radio" buttons.
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, type AudioStatus } from 'expo-audio';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import type { FeedEventKind } from '../../../packages/shared/src/constants';
import {
  clipBytes,
  parseStationId,
  RADIO_BYTES_PER_MINUTE,
  RADIO_GAP_MS,
  RADIO_PAGE,
  RADIO_REFILL_AT,
  radioBack,
  radioOutcome,
  readResume,
  stationId,
  type RadioPage,
  type RadioSleepMinutes,
  type RadioStation,
  type RadioStationInfo,
} from '../../../packages/shared/src/radio';
import { baseLanguage, needsTranslation } from '../../../packages/shared/src/translation';
import type { Post } from '../../../packages/shared/src/types';
import { listenFinished, nextVoiceRate, type VoiceRate } from '../../../packages/shared/src/voice';
import { client, errorMessage, mediaUrl } from './api';
import { readHere } from './city-map';
import { useDataSaver } from './data-saver';
import { recordFeedEvent } from './feed-events';
import { useFlag } from './flags';
import type { Translate } from './i18n';
import { useT } from './i18n';
import { useSession } from './session';
import { DOCK } from './tour';
import { elevation, radius, space } from './theme';
import { useTranslationSettings } from './translation';
import { Avatar, Button, Icon, TabBarExtraSpace, useColors, userText } from './ui';
import { onVoicePlay, pauseVoice } from './voice';

/** Where the radio was, on this phone (a tiny JSON string, so SecureStore is fine). */
const RESUME_KEY = 'yp.radio.resume';
/** "Listen in my language", on this phone. */
const LANGUAGE_KEY = 'yp.radio.myLanguage';
/** How often where you are is kept while it plays. */
const SAVE_MS = 5000;
/** The bar above the dock: its height and the gap under it. */
const BAR_HEIGHT = 56;
const BAR_GAP = space[2];

/** The radio's sound: on in silent mode, in the background and on the lock screen, alone (other apps pause). */
const radioMode = () =>
  setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix', allowsRecording: false }).catch(() => {});
/** Back to how lib/voice.tsx plays clips (on iOS the fields left out go back to their defaults). */
const normalMode = () => setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false, shouldPlayInBackground: false }).catch(() => {});

/** A station's name: its own (a squad, a person, a place, a #tag) or the main four's. */
export function stationTitle(s: RadioStation & { title?: string | null }, t: Translate): string {
  switch (s.kind) {
    case 'for_you':
      return t('feed.for_you');
    case 'friends':
      return t('feed.friends');
    case 'near':
      return t('map.title');
    case 'topics':
      return s.key ? `#${s.key}` : t('onboarding.topics');
    case 'person':
      return s.title ?? (s.key ? `@${s.key}` : t('radio.title'));
    default:
      return s.title ?? t('radio.title');
  }
}

/** Whether the radio is offered: Yaps and Yap Radio both on (true while the flags are being checked). */
export function useRadioOn() {
  const yaps = useFlag('YAPS');
  const radio = useFlag('YAP_RADIO');
  return yaps !== false && radio !== false;
}

/** The Yap playing now, as the radio follows it for the recommender. */
type Track = {
  postId: string;
  /** Heard (real time, at the speed chosen) since the last `listen` event. */
  pendingMs: number;
  /** Heard in all, for telling a quick skip. */
  totalMs: number;
  furthestMs: number;
  lastAt: number | null;
  /** The clip's length; for a translation read out, known once it has loaded. */
  durationMs: number;
  completed: boolean;
  wasPlaying: boolean;
  ended: boolean;
};

export interface RadioState {
  station: RadioStationInfo | null;
  queue: Post[];
  index: number;
  current: Post | null;
  /** Playing, or about to (between two Yaps, loading the next). */
  playing: boolean;
  positionMs: number;
  durationMs: number;
  rate: VoiceRate;
  /** When the sleep timer stops it (ms since the epoch), or null. */
  sleepUntil: number | null;
  myLanguage: boolean;
  /** The language the current Yap is read out in (its transcript translated), or null for the speaker's own voice. */
  spoken: string | null;
  /** About how many bytes the clips started this session took. */
  bytes: number;
  loading: boolean;
  /** Nothing (more) to hear on this station. */
  empty: boolean;
  /** Near you has no place to go by: say how to give one. */
  needsPlace: boolean;
  error: string | null;
  /** Whether you follow the current Yap's speaker (or asked to). */
  follow: 'none' | 'following' | 'requested';
}

export interface Radio extends RadioState {
  /** Start a station (`ask`: Near you may ask for the location, after a tap). No station: carry on where it was left. */
  play: (station?: RadioStation, opts?: { ask?: boolean }) => Promise<void>;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  /** Jump to a Yap further down the queue. */
  playAt: (index: number) => void;
  seek: (ms: number) => void;
  stop: () => void;
  cycleRate: () => void;
  setSleep: (minutes: RadioSleepMinutes | null) => void;
  setMyLanguage: (on: boolean) => void;
  like: () => Promise<void>;
  /** Follow the current speaker, or unfollow (or take back a request). Throws with the API's message. */
  toggleFollow: () => Promise<void>;
}

const Ctx = createContext<Radio | null>(null);

export function useRadio(): Radio {
  const r = useContext(Ctx);
  if (!r) throw new Error('useRadio needs RadioProvider');
  return r;
}

const record = (postId: string, kind: FeedEventKind, valueMs?: number) =>
  recordFeedEvent(valueMs === undefined ? { postId, surface: 'radio', kind } : { postId, surface: 'radio', kind, valueMs });

const playable = (p: Post) => p.format === 'yap' && !!p.voice;

/**
 * The radio for the whole app: one player that survives navigation. Sits inside the session,
 * the language, Data saver and translation settings (it reads all four).
 */
export function RadioProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const { t, lang } = useT();
  const saver = useDataSaver().active;
  const { settings, voice } = useTranslationSettings();
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // What the handlers read: the latest render's settings.
  const ctx = useRef({ t, lang, saver, languages: settings.languages, listen: voice.listen, meId: me?.id ?? null });
  ctx.current = { t, lang, saver, languages: settings.languages, listen: voice.listen, meId: me?.id ?? null };

  // The radio itself, changed in place by the handlers below (bump() shows a change).
  const e = useRef({
    station: null as RadioStationInfo | null,
    queue: [] as Post[],
    index: -1,
    cursor: null as string | null,
    seen: new Set<string>(),
    /** Speakers you follow (from the pages, then your taps), or asked to follow (a private account). */
    following: new Map<string, 'following' | 'requested'>(),
    /** Raised by every play() and stop(): answers from before are dropped. */
    gen: 0,
    /** Raised by every Yap started: a translation arriving after the next one started is dropped. */
    seq: 0,
    fetching: null as Promise<void> | null,
    here: null as { lat: number; lng: number } | null,
    loading: false,
    empty: false,
    needsPlace: false,
    error: null as string | null,
    spoken: null as string | null,
    bytes: 0,
    track: null as Track | null,
    /** Asked to play (the button shows Pause), even while the next Yap is loading. */
    want: false,
    /** Between two Yaps: the short quiet, or a translation being read out for the next. */
    busy: false,
    pendingSeek: null as number | null,
    lockScreen: false,
    rate: 1 as VoiceRate,
    sleepUntil: null as number | null,
    myLanguage: false,
    advance: null as ReturnType<typeof setTimeout> | null,
    sleep: null as ReturnType<typeof setTimeout> | null,
  }).current;

  useEffect(() => {
    SecureStore.getItemAsync(LANGUAGE_KEY)
      .then((v) => {
        e.myLanguage = v === '1';
        bump();
      })
      .catch(() => {});
  }, [e]);

  const saveResume = () => {
    const post = e.queue[e.index];
    if (!e.station || !post) return;
    let positionMs = 0;
    try {
      positionMs = e.spoken ? 0 : Math.round(player.currentTime * 1000);
    } catch {
      // Released.
    }
    const kept = { station: stationId(e.station), postId: post.id, positionMs, at: Date.now() };
    SecureStore.setItemAsync(RESUME_KEY, JSON.stringify(kept)).catch(() => {});
  };

  /** What was heard since the last `listen` goes. */
  const flushHeard = (tr: Track) => {
    const ms = Math.round(tr.pendingMs);
    tr.pendingMs = 0;
    if (ms >= 250) record(tr.postId, 'listen', ms);
  };

  /** The current Yap is over: what was heard goes, and skipping it quickly tells the recommender "not this". */
  const finishTrack = (skipped: boolean) => {
    const tr = e.track;
    if (!tr) return;
    e.track = null;
    flushHeard(tr);
    if (skipped && !tr.ended && radioOutcome(tr.totalMs, tr.furthestMs, tr.durationMs) === 'skip') record(tr.postId, 'skip');
  };

  const clearAdvance = () => {
    if (e.advance) clearTimeout(e.advance);
    e.advance = null;
  };

  const pausePlayer = () => {
    try {
      player.pause();
    } catch {
      // Released.
    }
  };

  /** Adds a page's Yaps, each once a session. */
  const add = (page: RadioPage) => {
    for (const p of page.items) {
      if (!playable(p) || e.seen.has(p.id)) continue;
      e.seen.add(p.id);
      e.queue.push(p);
    }
    for (const id of page.following ?? []) e.following.set(id, 'following');
    e.cursor = page.nextCursor;
  };

  const nearOpts = () => (e.station?.kind === 'near' && e.here ? { lat: e.here.lat, lng: e.here.lng } : {});

  const fetchMore = (): Promise<void> => {
    if (e.fetching) return e.fetching;
    const station = e.station;
    if (!station || !e.cursor) return Promise.resolve();
    const gen = e.gen;
    const cursor = e.cursor;
    const p: Promise<void> = (async () => {
      try {
        const page = await (await client()).radio.next(station, { cursor, limit: RADIO_PAGE, ...nearOpts() });
        if (gen === e.gen) add(page);
      } catch {
        // Offline for a moment: asked again when the queue runs low or out.
      }
    })().finally(() => {
      if (e.fetching === p) e.fetching = null;
      bump();
    });
    e.fetching = p;
    return p;
  };

  /** Off Data saver the next page comes when a couple of Yaps are left; on it, only when the queue runs out. */
  const refill = () => {
    if (ctx.current.saver) return;
    if (e.queue.length - e.index - 1 <= RADIO_REFILL_AT) void fetchMore();
  };

  /** The language to read a Yap out in, when "Listen in my language" is on and it's in one the listener doesn't understand. */
  const spokenFor = (post: Post): string | null => {
    const c = ctx.current;
    const tr = post.voice?.transcript;
    if (!e.myLanguage || !c.listen || !tr || tr.status !== 'ready' || !tr.text || post.author.id === c.meId) return null;
    return needsTranslation(tr.lang, c.lang, c.languages) ? baseLanguage(c.lang) : null;
  };

  const lockScreenFor = (post: Post) => {
    const line = post.body.trim();
    const meta = {
      title: line ? (line.length > 120 ? `${line.slice(0, 119)}…` : line) : ctx.current.t('radio.title'),
      artist: post.author.displayName,
      albumTitle: e.station ? stationTitle(e.station, ctx.current.t) : undefined,
      artworkUrl: post.author.avatarUrl ? mediaUrl(post.author.avatarUrl) : undefined,
    };
    // Play, pause and seek on the lock screen and in the control centre. expo-audio has no
    // next-track remote command, so "next Yap" isn't offered there; seek forward stands in.
    try {
      if (e.lockScreen) player.updateLockScreenMetadata(meta);
      else {
        player.setActiveForLockScreen(true, meta, { showSeekForward: true, showSeekBackward: true });
        e.lockScreen = true;
      }
    } catch {
      // Not offered on this phone.
    }
  };

  /** Plays queue[i] (from `atMs`), or says the station has nothing more. */
  const go = async (i: number, skipped: boolean, atMs = 0) => {
    clearAdvance();
    finishTrack(skipped);
    const gen = e.gen;
    if (i >= e.queue.length && e.cursor) {
      e.busy = true;
      bump();
      await fetchMore();
      if (gen !== e.gen) return;
    }
    if (i >= e.queue.length || i < 0) {
      // The end of the station for now: the last Yap stays on screen, paused.
      e.busy = false;
      e.want = false;
      e.empty = true;
      pausePlayer();
      saveResume();
      bump();
      return;
    }
    const seq = ++e.seq;
    const post = e.queue[i]!;
    const clip = post.voice!;
    e.index = i;
    e.empty = false;
    e.want = true;
    e.spoken = null;
    record(post.id, 'impression');
    record(post.id, 'listen_start');
    e.bytes += clipBytes(post);
    let uri = mediaUrl(clip.url);
    const target = spokenFor(post);
    if (target) {
      // The translation read out instead (the screen shows the translated words). In the
      // background this costs a moment of quiet, which iOS allows while the session is active.
      e.busy = true;
      bump();
      try {
        const r = await (await client()).voice.speech(clip.id, target);
        if (gen !== e.gen || seq !== e.seq) return;
        uri = mediaUrl(r.url);
        e.spoken = target;
        e.bytes += Math.round((clip.durationMs / 60_000) * RADIO_BYTES_PER_MINUTE);
      } catch {
        if (gen !== e.gen || seq !== e.seq) return;
        // Not available now: the speaker's own voice.
      }
    }
    e.busy = false;
    e.track = {
      postId: post.id,
      pendingMs: 0,
      totalMs: 0,
      furthestMs: e.spoken ? 0 : atMs,
      lastAt: null,
      durationMs: e.spoken ? 0 : clip.durationMs,
      completed: false,
      wasPlaying: false,
      ended: false,
    };
    e.pendingSeek = !e.spoken && atMs > 0 ? atMs : null;
    try {
      player.replace({ uri });
      player.play();
      player.setPlaybackRate(e.rate);
    } catch {
      // Released.
    }
    lockScreenFor(post);
    refill();
    saveResume();
    bump();
  };

  const go_ = useRef(go);
  go_.current = go;

  /** Stopped by the sleep timer: paused, ready to carry on. */
  const sleepNow = () => {
    if (e.sleep) clearTimeout(e.sleep);
    e.sleep = null;
    e.sleepUntil = null;
    clearAdvance();
    e.want = false;
    e.busy = false;
    pausePlayer();
    saveResume();
    bump();
  };

  // Follows the player directly (not through renders), so it keeps going in the background.
  const onStatus = useRef((_s: AudioStatus) => {});
  onStatus.current = (s: AudioStatus) => {
    const tr = e.track;
    if (!tr) return;
    if (s.isLoaded && e.pendingSeek !== null) {
      const ms = e.pendingSeek;
      e.pendingSeek = null;
      void player.seekTo(ms / 1000).catch(() => {});
    }
    if (!tr.durationMs && s.duration > 0) tr.durationMs = Math.round(s.duration * 1000);
    if (s.playing) {
      const at = s.currentTime * 1000;
      const step = tr.lastAt === null ? 0 : at - tr.lastAt;
      tr.lastAt = at;
      // Played on (not a jump): heard, in real time at the speed chosen.
      if (step > 0 && step < 3000) {
        const real = step / (s.playbackRate || 1);
        tr.pendingMs += real;
        tr.totalMs += real;
        tr.furthestMs = Math.max(tr.furthestMs, at);
      }
      if (!tr.completed && listenFinished(tr.furthestMs, tr.durationMs)) {
        tr.completed = true;
        record(tr.postId, 'listen_complete');
      }
    } else {
      tr.lastAt = null;
      if (tr.wasPlaying) flushHeard(tr);
    }
    tr.wasPlaying = s.playing;
    if (e.sleepUntil && Date.now() >= e.sleepUntil && s.playing) return sleepNow();
    if (!s.didJustFinish || tr.ended) return;
    tr.ended = true;
    if (!tr.completed && tr.durationMs > 0) {
      tr.completed = true;
      record(tr.postId, 'listen_complete');
    }
    flushHeard(tr);
    if (!e.want) return;
    clearAdvance();
    // A short quiet between Yaps in the app; in the background the next one starts at once, so
    // iOS doesn't end the audio session (and the radio with it).
    if (AppState.currentState === 'active') {
      e.busy = true;
      e.advance = setTimeout(() => void go_.current(e.index + 1, false), RADIO_GAP_MS);
      bump();
    } else void go_.current(e.index + 1, false);
  };
  useEffect(() => {
    // A shared object, which emits events at run time (its types here don't say so).
    const emitter = player as unknown as { addListener: (event: 'playbackStatusUpdate', l: (s: AudioStatus) => void) => { remove: () => void } };
    const sub = emitter.addListener('playbackStatusUpdate', (s) => onStatus.current(s));
    return () => sub.remove();
  }, [player]);

  /** A tap on the radio: it has the sound again (a Yap played elsewhere may have changed it). */
  const takeOver = () => {
    void radioMode();
    pauseVoice();
  };

  const resume = () => {
    const tr = e.track;
    if (!tr) return;
    takeOver();
    e.want = true;
    if (tr.ended) return void go(e.index + 1, false);
    try {
      player.play();
      player.setPlaybackRate(e.rate);
    } catch {
      // Released.
    }
    bump();
  };

  const pause = () => {
    clearAdvance();
    e.want = false;
    e.busy = false;
    pausePlayer();
    saveResume();
    bump();
  };

  const play: Radio['play'] = async (station, opts) => {
    let target = station ?? null;
    let start: string | null = null;
    let atMs = 0;
    if (!target) {
      const kept = readResume(
        await SecureStore.getItemAsync(RESUME_KEY)
          .then((v) => (v ? JSON.parse(v) : null))
          .catch(() => null),
      );
      target = kept ? parseStationId(kept.station) : null;
      if (kept && target) {
        start = kept.postId;
        atMs = kept.positionMs;
      }
    }
    target ??= { kind: 'for_you' };
    const gen = ++e.gen;
    clearAdvance();
    finishTrack(true);
    pausePlayer();
    takeOver();
    Object.assign(e, {
      station: { kind: target.kind, key: target.key ?? null, title: null },
      queue: [],
      index: -1,
      cursor: null,
      seen: new Set<string>(),
      fetching: null,
      loading: true,
      empty: false,
      needsPlace: false,
      error: null,
      spoken: null,
      want: true,
      busy: false,
      pendingSeek: null,
    });
    bump();
    // Near you goes by where you are when the app may know it (asking only after a tap on it), else your city.
    e.here = target.kind === 'near' ? await readHere(!!opts?.ask).catch(() => null) : null;
    try {
      const page = await (await client()).radio.next(target, { limit: RADIO_PAGE, start, ...nearOpts() });
      if (gen !== e.gen) return;
      e.station = page.station;
      e.needsPlace = !!page.needsPlace;
      add(page);
    } catch (err) {
      if (gen !== e.gen) return;
      e.error = errorMessage(err);
      e.loading = false;
      e.want = false;
      bump();
      return;
    }
    e.loading = false;
    if (!e.queue.length) {
      e.empty = true;
      e.want = false;
      bump();
      return;
    }
    // The Yap it was left on comes first: carry on from where it was.
    await go(0, false, start && e.queue[0]!.id === start ? atMs : 0);
  };

  const stop = () => {
    e.gen++;
    clearAdvance();
    finishTrack(true);
    saveResume();
    pausePlayer();
    try {
      if (e.lockScreen) player.clearLockScreenControls();
    } catch {
      // Not offered on this phone.
    }
    e.lockScreen = false;
    if (e.sleep) clearTimeout(e.sleep);
    Object.assign(e, {
      station: null,
      queue: [],
      index: -1,
      cursor: null,
      following: new Map(),
      fetching: null,
      loading: false,
      empty: false,
      needsPlace: false,
      error: null,
      spoken: null,
      want: false,
      busy: false,
      sleep: null,
      sleepUntil: null,
      pendingSeek: null,
    });
    void normalMode();
    bump();
  };

  // A Yap or a recording started elsewhere: the radio pauses.
  useEffect(
    () =>
      onVoicePlay(() => {
        if (e.want) pause();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Another account, or signed out: the radio stops.
  const who = me?.id ?? null;
  const was = useRef(who);
  useEffect(() => {
    if (was.current === who) return;
    was.current = who;
    if (e.station) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who]);
  // Where you are, kept every few seconds while it plays.
  useEffect(() => {
    if (!status.playing) return;
    const timer = setInterval(saveResume, SAVE_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.playing]);
  useEffect(
    () => () => {
      clearAdvance();
      if (e.sleep) clearTimeout(e.sleep);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const current = e.index >= 0 ? (e.queue[e.index] ?? null) : null;
  const playing = status.playing || (e.want && (e.busy || e.loading || !status.isLoaded || status.isBuffering));
  const durationMs = e.track?.durationMs || (status.duration > 0 ? Math.round(status.duration * 1000) : (current?.voice?.durationMs ?? 0));
  const positionMs = e.pendingSeek ?? (status.isLoaded ? Math.min(durationMs || Infinity, Math.round(status.currentTime * 1000)) : 0);

  const value: Radio = {
    station: e.station,
    queue: e.queue,
    index: e.index,
    current,
    playing,
    positionMs,
    durationMs,
    rate: e.rate,
    sleepUntil: e.sleepUntil,
    myLanguage: e.myLanguage,
    spoken: e.spoken,
    bytes: e.bytes,
    loading: e.loading,
    empty: e.empty,
    needsPlace: e.needsPlace,
    error: e.error,
    follow: (current && e.following.get(current.author.id)) || 'none',
    play,
    toggle: () => {
      if (!e.station || (!current && !e.loading)) return void play(e.station ?? undefined);
      if (playing) return pause();
      // At the end of the station: ask again (new Yaps may have come).
      if (e.empty) return void play(e.station);
      resume();
    },
    next: () => {
      takeOver();
      void go(e.index + 1, true);
    },
    previous: () => {
      takeOver();
      if (radioBack(positionMs, e.index) === 'previous') return void go(e.index - 1, false);
      // This one again, from the start.
      clearAdvance();
      e.pendingSeek = null;
      if (e.track) e.track.ended = false;
      void player.seekTo(0).catch(() => {});
      if (!playing) resume();
    },
    playAt: (index) => {
      takeOver();
      void go(index, true);
    },
    seek: (ms) => {
      if (!e.track || e.track.ended) return;
      void player.seekTo(Math.max(0, ms) / 1000).catch(() => {});
      if (!playing) resume();
    },
    stop,
    cycleRate: () => {
      e.rate = nextVoiceRate(e.rate);
      try {
        player.setPlaybackRate(e.rate);
      } catch {
        // Released.
      }
      bump();
    },
    setSleep: (minutes) => {
      if (e.sleep) clearTimeout(e.sleep);
      e.sleep = null;
      e.sleepUntil = minutes ? Date.now() + minutes * 60_000 : null;
      if (minutes) e.sleep = setTimeout(sleepNow, minutes * 60_000);
      bump();
    },
    setMyLanguage: (on) => {
      // From the next Yap on: the one playing keeps its voice.
      e.myLanguage = on;
      SecureStore.setItemAsync(LANGUAGE_KEY, on ? '1' : '0').catch(() => {});
      bump();
    },
    like: async () => {
      const post = current;
      if (!post) return;
      const set = (liked: boolean) => {
        e.queue = e.queue.map((p) => (p.id === post.id ? { ...p, viewer: { ...p.viewer, liked } } : p));
        bump();
      };
      const next = !post.viewer.liked;
      set(next);
      try {
        const api = await client();
        set((await (next ? api.posts.like(post.id) : api.posts.unlike(post.id))).liked);
      } catch {
        set(!next);
      }
    },
    toggleFollow: async () => {
      const author = current?.author;
      if (!author) return;
      const api = await client();
      const r = await (e.following.has(author.id) ? api.users.unfollow(author.id) : api.users.follow(author.id));
      if (r.following) e.following.set(author.id, 'following');
      else if (r.requested) e.following.set(author.id, 'requested');
      else e.following.delete(author.id);
      bump();
    },
  };

  return (
    <Ctx.Provider value={value}>
      <TabBarExtraSpace.Provider value={current ? BAR_HEIGHT + BAR_GAP : 0}>{children}</TabBarExtraSpace.Provider>
    </Ctx.Provider>
  );
}

/**
 * The slim bar just above the dock, on every tab while the radio has a Yap: the speaker, the line
 * (or the station), play or pause and next. Tapping it opens the full Radio screen.
 */
export function RadioMiniBar({ bottom }: { bottom: number }) {
  const c = useColors();
  const { t } = useT();
  const on = useRadioOn();
  const r = useRadio();
  const post = r.current;
  if (!on || !post || !r.station) return null;
  const station = stationTitle(r.station, t);
  const line = post.body.trim() || station;
  const round = { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' } as const;
  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom }]}>
      <View style={[s.bar, { backgroundColor: c.surface, borderColor: c.line }, elevation(c, 'lg')]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t('radio.nowPlaying', { station })}: ${post.author.displayName}. ${line}`}
          accessibilityHint={t('radio.open')}
          onPress={() => router.push('/radio')}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
        >
          <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[{ color: c.ink, fontWeight: '700', fontSize: 14 }, userText]}>
              {post.author.displayName}
            </Text>
            <Text numberOfLines={1} style={[{ color: c.inkMuted, fontSize: 12 }, userText]}>
              {line}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={r.playing ? t('voice.pause') : t('voice.play')}
          onPress={r.toggle}
          style={[round, { backgroundColor: c.yapi }]}
        >
          <Icon name={r.playing ? 'pause' : 'play'} size={20} color={c.onYapi} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('radio.next')} onPress={r.next} style={round}>
          <Icon name="play-skip-forward" size={20} color={c.ink} directional />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * "Play as radio": starts `station` (or carries on, when it's already the one playing) and opens
 * the Radio screen. Hidden while Yaps or Yap Radio are off. `compact`: a round icon button (a header).
 */
export function RadioButton({ station, compact }: { station: RadioStation; compact?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const on = useRadioOn();
  const r = useRadio();
  if (!on) return null;
  const press = () => {
    const same = r.station && stationId(r.station) === stationId(station) && r.current;
    if (!same) void r.play(station, { ask: station.kind === 'near' });
    else if (!r.playing) r.toggle();
    router.push('/radio');
  };
  if (compact)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('radio.playAs')}
        onPress={press}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="radio-outline" size={22} color={c.yapi} />
      </Pressable>
    );
  return <Button label={t('radio.playAs')} icon="radio-outline" variant="secondary" size="sm" onPress={press} />;
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', start: DOCK.side, end: DOCK.side, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    height: BAR_HEIGHT,
    width: '100%',
    maxWidth: DOCK.maxWidth,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingStart: space[2],
    paddingEnd: space[1],
  },
});
