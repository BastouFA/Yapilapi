// Yaps: voice posts of up to a minute, voice replies and voice intros (docs/product/yaps.md).
// The player (a waveform you can scrub, speed, transcript), the hold-to-talk recorder and the upload.
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, I18nManager, Linking, PanResponder, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import {
  activeSegment,
  listenFinished,
  nextVoiceRate,
  peaksFromSamples,
  resamplePeaks,
  seekMs,
  VOICE_MIN_MS,
  VOICE_PEAKS,
  voiceClock,
  type VoiceClip,
  type VoicePurpose,
  type VoiceRate,
  type VoiceSegment,
} from '../../../packages/shared/src/voice';
import { baseUrl, client, errorMessage, getToken, mediaUrl } from './api';
import { useDataSaver } from './data-saver';
import { useT } from './i18n';
import { tr } from './locale';
import { VOICE_MIME } from './media';
import { radius, space } from './theme';
import { TranslationBar, useTranslatable, useTranslationSettings } from './translation';
import { Listen } from './voice-transcript';
import { Button, Icon, Notice, useColors, userText } from './ui';
import { useMicInUse } from './yaps';

/**
 * Upload a recording made in the app to POST /v1/voice (multipart, field "file"). The server
 * measures it, stores it small and draws its waveform; a clip over the limit for `purpose` (a
 * minute, 15 seconds for an intro) or under a second is refused. XMLHttpRequest, so progress shows.
 */
export async function uploadVoice(uri: string, purpose: VoicePurpose, onProgress?: (fraction: number) => void): Promise<VoiceClip> {
  const form = new FormData();
  form.append('file', { uri, name: `voice-${Date.now()}.m4a`, type: VOICE_MIME } as unknown as Blob);
  const token = await getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/v1/voice?purpose=${purpose}`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error(tr('voice.failed')));
    xhr.onload = () => {
      let json: { voice?: VoiceClip; error?: { code?: string; message?: string; fields?: Record<string, string> } } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (a proxy error page): the generic message below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.voice) resolve(json.voice);
      // The API's own errors keep their code (a verification step, a limit) and its words, already in the reader's language.
      else if (json?.error?.message) reject(new ApiError(xhr.status, json.error.code ?? 'upload_failed', json.error.message, json.error.fields));
      else reject(new Error(tr('voice.failed')));
    };
    xhr.send(form);
  });
}

// ── Playing ──

export type ListenEvent = { kind: 'listen_start' | 'listen' | 'listen_complete'; valueMs?: number };

type Entry = { pause: () => void; preload: () => void };

/** The voice clip playing now, so starting another pauses it: one voice at a time, app-wide. */
let current: Entry | null = null;
/**
 * Players on screen, in the order they mounted. When one starts (and Data saver is off), the
 * next one in this list loads its clip, so going down a list of Yaps doesn't wait each time. A
 * simplification: lists mount their rows top to bottom, so mount order stands in for list order.
 */
const players: Entry[] = [];

/** Pause whatever voice clip is playing (a recording is about to start, for example). */
export function pauseVoice() {
  const p = current;
  current = null;
  try {
    p?.pause();
  } catch {
    // That player was already released.
  }
}

/** Files recorded on this phone play as they are; the API's addresses may be relative to it. */
const sourceOf = (url: string) => (/^(file|content|ph|assets-library):/i.test(url) ? url : mediaUrl(url));

const BAR = 3;
const BAR_GAP = 2;
/** The arrow keys of a screen reader's "adjustable" move this far. */
const STEP_MS = 5000;

/**
 * A voice clip: play and pause, a waveform drawn from its peaks that fills in as it plays (tap or
 * drag along it to move; a screen reader swipes up or down to move 5 seconds), the time, the
 * speed (1×, 1.5×, 2×) and, below, its transcript. Nothing loads until play is pressed (or the
 * player above it starts, without Data saver). Never plays by itself.
 *
 * `onListen`: listen_start on the first play, listen with how long it was heard (real time, at the
 * speed chosen) whenever it pauses, ends or leaves the screen, and listen_complete once it has
 * played to VOICE_COMPLETE_AT.
 */
export function VoicePlayer({
  clip: given,
  label,
  compact,
  own,
  onListen,
  transcript: withTranscript = true,
  transcriptOpen = false,
}: {
  clip: VoiceClip;
  /** What the play button says to a screen reader ("Play Yap by Ada, 0:42"). */
  label: string;
  /** Smaller: a voice reply under a post, a profile's intro. */
  compact?: boolean;
  /** Your own clip: its transcript isn't offered in translation. */
  own?: boolean;
  onListen?: (e: ListenEvent) => void;
  /** Show the transcript toggle (off for a recording not posted yet). */
  transcript?: boolean;
  /** Start with the transcript shown (a Yap's own page). */
  transcriptOpen?: boolean;
}) {
  const c = useColors();
  const { t, number } = useT();
  const saver = useDataSaver().active;
  const player = useAudioPlayer(null, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);
  // The clip as shown: the one given, or a newer copy with its transcript (polled below).
  const [clip, setClip] = useState(given);
  useEffect(() => setClip(given), [given]);
  const src = sourceOf(clip.url);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [rate, setRate] = useState<VoiceRate>(1);
  // Where the waveform was tapped or is being dragged to, until the player is there.
  const [heldMs, setHeldMs] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const durationMs = clip.durationMs > 0 ? clip.durationMs : Math.round(status.duration * 1000);
  const atMs = heldMs ?? (loaded ? Math.min(durationMs, status.currentTime * 1000) : 0);
  const [width, setWidth] = useState(0);
  const listen = useRef(onListen);
  listen.current = onListen;

  const load = () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      player.replace({ uri: src });
      setLoaded(true);
    } catch {
      loadedRef.current = false;
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  // Another address (a different clip in a recycled row): start again.
  useEffect(() => {
    if (!loadedRef.current) return;
    loadedRef.current = false;
    setLoaded(false);
    setHeldMs(null);
    pendingSeek.current = null;
    try {
      player.pause();
    } catch {
      // Released.
    }
  }, [src, player]);

  const entry = useRef<Entry>({ pause: () => {}, preload: () => loadRef.current() }).current;
  entry.pause = () => player.pause();
  useEffect(() => {
    players.push(entry);
    return () => {
      const i = players.indexOf(entry);
      if (i >= 0) players.splice(i, 1);
      if (current === entry) current = null;
    };
  }, [entry]);

  // Listening, for the recommender: started, how long, finished.
  const started = useRef(false);
  const completed = useRef(false);
  const heard = useRef(0);
  const lastAt = useRef<number | null>(null);
  const furthest = useRef(0);
  const flush = () => {
    const ms = Math.round(heard.current);
    heard.current = 0;
    if (ms >= 250) listen.current?.({ kind: 'listen', valueMs: ms });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (!status.playing) {
      lastAt.current = null;
      return;
    }
    const at = status.currentTime * 1000;
    const step = lastAt.current === null ? 0 : at - lastAt.current;
    lastAt.current = at;
    // Played on (not a jump): counts as heard, in real time at the speed chosen.
    if (step > 0 && step < 3000) {
      heard.current += step / (status.playbackRate || 1);
      furthest.current = Math.max(furthest.current, at);
    }
    if (!completed.current && listenFinished(furthest.current, durationMs)) {
      completed.current = true;
      listen.current?.({ kind: 'listen_complete' });
    }
  }, [status.currentTime, status.playing, status.playbackRate, durationMs]);
  // Paused or ended: what was heard so far goes.
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && !status.playing) flushRef.current();
    wasPlaying.current = status.playing;
  }, [status.playing]);
  useEffect(() => () => flushRef.current(), []);

  // Back to the start when it ends, ready to play again.
  useEffect(() => {
    if (!status.didJustFinish) return;
    if (!completed.current && durationMs > 0) {
      completed.current = true;
      listen.current?.({ kind: 'listen_complete' });
    }
    if (current === entry) current = null;
    try {
      player.pause();
      void player.seekTo(0);
    } catch {
      // Released.
    }
  }, [status.didJustFinish, player, entry, durationMs]);

  // A spot chosen before it loaded: go there once it can.
  useEffect(() => {
    if (!status.isLoaded || pendingSeek.current === null) return;
    const ms = pendingSeek.current;
    pendingSeek.current = null;
    void player
      .seekTo(ms / 1000)
      .catch(() => {})
      .finally(() => setHeldMs(null));
  }, [status.isLoaded, player]);

  const play = () => {
    if (current && current !== entry) pauseVoice();
    current = entry;
    load();
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    if (!started.current) {
      started.current = true;
      listen.current?.({ kind: 'listen_start' });
    }
    try {
      if (status.isLoaded && durationMs > 0 && status.currentTime * 1000 >= durationMs - 150) void player.seekTo(0);
      player.play();
      player.setPlaybackRate(rate);
    } catch {
      // Released.
    }
    // The next one down gets ready, unless data is being saved.
    if (!saver) {
      const i = players.indexOf(entry);
      if (i >= 0) players[i + 1]?.preload();
    }
  };
  const toggle = () => {
    if (status.playing) return player.pause();
    play();
  };
  const changeRate = () => {
    const next = nextVoiceRate(rate);
    setRate(next);
    try {
      if (status.playing) player.setPlaybackRate(next);
    } catch {
      // Released.
    }
  };

  const seekTo = (ms: number) => {
    const to = Math.max(0, Math.min(durationMs, ms));
    setHeldMs(to);
    if (loadedRef.current && status.isLoaded) {
      void player
        .seekTo(to / 1000)
        .catch(() => {})
        .finally(() => setHeldMs(null));
    } else pendingSeek.current = to;
  };
  // The waveform reads from the start edge: from the right in right-to-left languages.
  const fractionAt = (e: GestureResponderEvent) => {
    const x = width > 0 ? e.nativeEvent.locationX / width : 0;
    return I18nManager.isRTL ? 1 - x : x;
  };

  const height = compact ? 28 : 40;
  const bars = useMemo(() => resamplePeaks(clip.peaks, Math.max(8, Math.floor((width + BAR_GAP) / (BAR + BAR_GAP)))), [clip.peaks, width]);
  const playedBars = durationMs > 0 ? Math.round((atMs / durationMs) * bars.length) : 0;
  const clockText = status.playing || atMs > 0 ? `${voiceClock(atMs)} / ${voiceClock(durationMs)}` : voiceClock(durationMs);
  const rateText = `${number(rate)}×`;

  // ── Transcript: shown on request (or from the start on a Yap's page); a pending one is asked for again. ──
  const [open, setOpen] = useState(transcriptOpen);
  const focused = useIsFocused();
  const polls = useRef(0);
  const pending = clip.transcript.status === 'pending';
  useEffect(() => {
    if (!withTranscript || !open || !focused || !pending || sourceOf(clip.url) !== mediaUrl(clip.url)) return;
    let live = true;
    const timer = setInterval(() => {
      if (++polls.current > 15) return clearInterval(timer);
      void client()
        .then((api) => api.voice.get(clip.id))
        .then(
          ({ voice }) => {
            if (live && voice.transcript.status !== 'pending') setClip(voice);
          },
          () => {},
        );
    }, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [withTranscript, open, focused, pending, clip.id, clip.url]);

  return (
    <View style={{ gap: space[2], backgroundColor: c.surfaceSunken, borderRadius: radius.md, padding: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? t('voice.pause') : label}
          onPress={toggle}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.yapi, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={status.playing ? 'pause' : 'play'} size={20} color={c.onYapi} />
        </Pressable>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t('voice.seek')}
          accessibilityValue={{
            min: 0,
            max: Math.round(durationMs / 1000),
            now: Math.round(atMs / 1000),
            text: `${voiceClock(atMs)} / ${voiceClock(durationMs)}`,
          }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment') seekTo(atMs + STEP_MS);
            else if (e.nativeEvent.actionName === 'decrement') seekTo(atMs - STEP_MS);
          }}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => durationMs > 0}
          onResponderGrant={(e) => setHeldMs(seekMs(fractionAt(e), durationMs))}
          onResponderMove={(e) => setHeldMs(seekMs(fractionAt(e), durationMs))}
          onResponderRelease={(e) => seekTo(seekMs(fractionAt(e), durationMs))}
          onResponderTerminate={() => setHeldMs(pendingSeek.current)}
          // The bars are short: the touch area is 44 tall.
          style={{ flex: 1, height: 44, justifyContent: 'center' }}
        >
          {/* The bars take no touches, so a drag's position is always measured on the waveform itself. */}
          <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', gap: BAR_GAP, height }}>
            {bars.map((p, i) => (
              <View
                key={i}
                style={{
                  width: BAR,
                  height: Math.max(3, (p / 100) * height),
                  borderRadius: BAR,
                  backgroundColor: i < playedBars ? c.yapi : c.inkMuted,
                }}
              />
            ))}
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voice.speed', { rate: number(rate) })}
          onPress={changeRate}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          style={{
            minWidth: 40,
            height: 32,
            paddingHorizontal: 6,
            borderRadius: radius.full,
            backgroundColor: c.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: c.ink, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{rateText}</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2], paddingStart: 4 }}>
        <Text style={{ color: c.inkMuted, fontSize: 12, fontVariant: ['tabular-nums'] }} accessibilityElementsHidden importantForAccessibility="no">
          {clockText}
        </Text>
        {withTranscript ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((v) => !v)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 }}
          >
            <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 13 }}>{open ? t('voice.transcript.hide') : t('voice.transcript.show')}</Text>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={c.yapi} />
          </Pressable>
        ) : null}
      </View>
      {withTranscript && open ? (
        clip.transcript.status === 'ready' && clip.transcript.text ? (
          <TranscriptText
            id={clip.id}
            text={clip.transcript.text}
            lang={clip.transcript.lang}
            segments={clip.transcript.segments}
            own={own}
            atMs={status.playing || atMs > 0 ? atMs : -1}
            onSeek={(ms) => {
              seekTo(ms);
              if (!status.playing) play();
            }}
          />
        ) : (
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20, paddingHorizontal: 4 }}>
            {pending ? t('voice.transcript.pending') : t('voice.transcript.unavailable')}
          </Text>
        )
      ) : null}
    </View>
  );
}

/**
 * The words of a clip, offered in translation like any post. With timed lines, the one being
 * spoken is marked as it plays, and tapping a line plays from there (the original only: a
 * translation has no timings).
 */
function TranscriptText({
  id,
  text,
  lang,
  segments,
  own,
  atMs,
  onSeek,
}: {
  id: string;
  text: string;
  lang: string | null;
  segments: VoiceSegment[];
  own?: boolean;
  /** Where it's playing, or -1 when it isn't. */
  atMs: number;
  onSeek: (ms: number) => void;
}) {
  const c = useColors();
  const { voice } = useTranslationSettings();
  const state = useTranslatable({ kind: 'voice', id, text, lang, own });
  const translated = state.status === 'shown' && !!state.translation;
  const active = atMs >= 0 ? activeSegment(segments, atMs / 1000) : -1;
  const style = { color: c.ink, fontSize: 15, lineHeight: 22 };
  return (
    <View ref={state.ref} collapsable={false} style={{ paddingHorizontal: 4 }}>
      {segments.length && !translated ? (
        <Text style={[style, userText]} accessibilityLanguage={lang ?? undefined}>
          {segments.map((s, i) => (
            <Text
              key={i}
              onPress={() => onSeek(Math.round(s.start * 1000))}
              style={i === active ? { backgroundColor: c.yapiSoft, fontWeight: '600' } : undefined}
            >
              {i ? ' ' : ''}
              {s.text.trim()}
            </Text>
          ))}
        </Text>
      ) : (
        <Text selectable style={[style, userText]} accessibilityLanguage={state.lang ?? lang ?? undefined}>
          {state.text}
        </Text>
      )}
      <TranslationBar state={state} />
      {translated && voice.listen ? <Listen kind="voice" id={id} target={state.translation!.targetLanguage} tint={c.yapi} /> : null}
    </View>
  );
}

// ── Recording ──

/** As voice messages are recorded, with the loudness reported for the live waveform. */
const RECORDING: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
/** Let go sooner than this (without sliding): a tap, which records hands-free until Stop. */
const TAP_MS = 300;
/** Slid this far toward the start edge: cancelled. */
const CANCEL_DX = 80;
/** Slid this far up: hands-free. */
const LOCK_DY = 70;
/** Bars in the live waveform while recording. */
const LIVE_BARS = 32;

type Phase = 'idle' | 'starting' | 'holding' | 'locked' | 'done';
type Recorded = { uri: string; ms: number; peaks: number[] };

/** Loudness in decibels (as the recorder meters it) to a level from 0 to 1. */
const level = (db: number) => Math.pow(10, Math.max(-60, Math.min(0, db)) / 20);

const resetAudio = () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});

/**
 * Hold the big button to talk and let go to stop; slide toward the start edge to cancel, or up to
 * keep recording hands-free (then Stop). A quick tap also records hands-free, and a screen reader's
 * double tap does the same. The time left counts down, and recording stops by itself at `maxMs`.
 * Under a second is too short. Leaving the screen (or this view going) discards it.
 *
 * Once stopped, the recording can be heard here, recorded again or discarded; `onDone` gets it
 * (and `onCancel` when it's dropped again). Give it a new `key` to start over (after posting).
 */
export function VoiceRecorder({
  maxMs,
  purpose,
  onDone,
  onCancel,
  busy,
}: {
  maxMs: number;
  purpose: VoicePurpose;
  onDone: (uri: string, durationMs: number, peaks: number[]) => void;
  onCancel?: () => void;
  /** Being uploaded: the recording can't be changed meanwhile. */
  busy?: boolean;
}) {
  const c = useColors();
  const { t } = useT();
  const recorder = useAudioRecorder(RECORDING);
  const rs = useAudioRecorderState(recorder, 100);
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  // How far the finger has slid while holding (toward the start edge is negative).
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const levels = useRef<number[]>([]);
  // Still wanted: let go (or cancelled) while the microphone was getting ready means no recording.
  const want = useRef(false);
  const locked = useRef(false);
  const downAt = useRef(0);
  const usedMic = useRef(false);
  const recording = phase === 'holding' || phase === 'locked';
  useMicInUse(recording);

  async function start(handsFree: boolean) {
    if (phaseRef.current !== 'idle') return;
    setError(null);
    want.current = true;
    locked.current = handsFree;
    setPhase('starting');
    // No Yap plays over a recording.
    pauseVoice();
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        want.current = false;
        setDenied(true);
        setPhase('idle');
        return;
      }
      setDenied(false);
      if (!want.current) return setPhase('idle');
      usedMic.current = true;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!want.current) {
        void resetAudio();
        return setPhase('idle');
      }
      levels.current = [];
      recorder.record();
      setPhase(locked.current ? 'locked' : 'holding');
    } catch (e) {
      want.current = false;
      setError(errorMessage(e));
      setPhase('idle');
      void resetAudio();
    }
  }

  async function stop(keep: boolean) {
    const was = phaseRef.current;
    want.current = false;
    setDrag(null);
    if (was === 'starting') return; // start() sees `want` and goes back to idle.
    if (was !== 'holding' && was !== 'locked') return;
    let ms = 0;
    try {
      ms = recorder.getStatus().durationMillis;
    } catch {
      // Released: nothing was kept.
    }
    setPhase('idle');
    try {
      await recorder.stop();
    } catch {
      // Already stopped.
    }
    // Back to normal playback (the loudspeaker on iOS).
    await resetAudio();
    if (!keep) return;
    const uri = recorder.uri;
    if (!uri) return;
    if (ms < VOICE_MIN_MS) return setError(t('voice.tooShort'));
    const made = { uri, ms: Math.min(ms, maxMs), peaks: peaksFromSamples(levels.current, VOICE_PEAKS) };
    setRecorded(made);
    setPhase('done');
    onDone(made.uri, made.ms, made.peaks);
  }

  function lock() {
    locked.current = true;
    if (phaseRef.current === 'holding') setPhase('locked');
    setDrag(null);
    AccessibilityInfo.announceForAccessibility(t('voice.locked'));
  }

  function discard() {
    setRecorded(null);
    setError(null);
    setPhase('idle');
    onCancel?.();
  }

  // The latest handlers, for the gesture made once below.
  const h = useRef({ start, stop, lock });
  h.current = { start, stop, lock };
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => phaseRef.current === 'idle',
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          downAt.current = Date.now();
          void h.current.start(false);
        },
        onPanResponderMove: (_, g) => {
          if (locked.current) return;
          const p = phaseRef.current;
          if (p !== 'holding' && p !== 'starting') return;
          // Toward the start edge: left, or right in right-to-left languages.
          const dx = I18nManager.isRTL ? -g.dx : g.dx;
          if (dx < -CANCEL_DX) return void h.current.stop(false);
          if (g.dy < -LOCK_DY) return h.current.lock();
          setDrag({ dx: Math.min(0, dx), dy: Math.min(0, g.dy) });
        },
        onPanResponderRelease: (_, g) => {
          if (locked.current) return;
          const tap = Date.now() - downAt.current < TAP_MS && Math.abs(g.dx) < 12 && Math.abs(g.dy) < 12;
          // A quick tap records hands-free, until Stop.
          if (tap) return h.current.lock();
          void h.current.stop(true);
        },
        // Taken away (a system sheet, the permission prompt): nothing is kept unless it's hands-free.
        onPanResponderTerminate: () => {
          if (!locked.current) void h.current.stop(false);
        },
      }),
    [],
  );

  // The loudness as it's recorded, for the live waveform and the recording's own waveform after.
  useEffect(() => {
    if (!recording) return;
    if (typeof rs.metering === 'number') levels.current.push(level(rs.metering));
  }, [rs.durationMillis, rs.metering, recording]);

  // At the limit: stop and keep what was recorded.
  useEffect(() => {
    if (recording && rs.durationMillis >= maxMs) void stop(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, rs.durationMillis, maxMs]);

  // Gone (or the screen left with the microphone on): nothing is kept, and playback goes back to normal.
  useEffect(
    () => () => {
      want.current = false;
      try {
        if (recorder.isRecording) void recorder.stop().catch(() => {});
      } catch {
        // Already released.
      }
      if (usedMic.current) void resetAudio();
    },
    [recorder],
  );
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) return;
    if (phaseRef.current === 'holding' || phaseRef.current === 'locked' || phaseRef.current === 'starting') void stop(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const preview = useMemo<VoiceClip | null>(
    () =>
      recorded
        ? {
            id: `local:${recorded.uri}`,
            url: recorded.uri,
            durationMs: recorded.ms,
            peaks: recorded.peaks,
            transcript: { status: 'unavailable', text: null, lang: null, segments: [] },
          }
        : null,
    [recorded],
  );

  if (phase === 'done' && preview)
    return (
      <View style={{ gap: space[2] }}>
        <VoicePlayer clip={preview} label={t('voice.play')} transcript={false} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          <Button label={t('voice.rerecord')} icon="mic-outline" variant="secondary" size="sm" disabled={busy} onPress={discard} />
          <Button label={t('voice.discard')} icon="trash-outline" variant="ghost" size="sm" disabled={busy} onPress={discard} />
        </View>
      </View>
    );

  const left = Math.max(0, Math.ceil((maxMs - rs.durationMillis) / 1000));
  const live = levels.current.slice(-LIVE_BARS);
  const bars = [...Array.from({ length: LIVE_BARS - live.length }, () => 0), ...live];
  const cancelling = !!drag && drag.dx < -CANCEL_DX / 2;
  const big = 88;

  return (
    <View style={{ alignItems: 'center', gap: space[3], paddingVertical: space[2] }}>
      {recording ? (
        <View style={{ alignItems: 'center', gap: space[2], alignSelf: 'stretch' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger }} />
            <Text style={{ color: c.ink, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{voiceClock(rs.durationMillis)}</Text>
            <Text style={{ color: c.inkMuted, fontVariant: ['tabular-nums'] }}>{t('voice.left', { seconds: left })}</Text>
          </View>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: BAR_GAP, height: 40 }}
          >
            {bars.map((v, i) => (
              <View key={i} style={{ width: BAR, height: Math.max(3, v * 40), borderRadius: BAR, backgroundColor: cancelling ? c.inkMuted : c.yapi }} />
            ))}
          </View>
        </View>
      ) : null}

      {phase === 'locked' ? (
        <>
          <Text accessibilityLiveRegion="polite" style={{ color: c.ink, fontWeight: '600' }}>
            {t('voice.locked')}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('voice.tapStop')}
            onPress={() => void stop(true)}
            style={{ width: big, height: big, borderRadius: big / 2, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="stop" size={32} color={c.onDanger} />
          </Pressable>
          <Button label={t('voice.discard')} icon="trash-outline" variant="ghost" size="sm" onPress={() => void stop(false)} />
        </>
      ) : (
        <>
          {phase === 'holding' ? (
            <View style={{ alignItems: 'center', gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="lock-closed-outline" size={14} color={c.inkMuted} />
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('voice.lockHint')}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="chevron-back" size={14} color={cancelling ? c.danger : c.inkMuted} directional />
                <Text style={{ color: cancelling ? c.danger : c.inkMuted, fontSize: 13, fontWeight: cancelling ? '700' : '400' }}>
                  {t('voice.slideCancel')}
                </Text>
              </View>
            </View>
          ) : null}
          <View
            {...pan.panHandlers}
            accessible
            accessibilityRole="button"
            accessibilityLabel={purpose === 'intro' ? t('voice.intro.record') : t('voice.recordA11y')}
            accessibilityState={{ disabled: !!busy, busy: phase === 'starting' }}
            accessibilityActions={[{ name: 'activate', label: t('voice.tapStart') }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'activate' && !busy) void start(true);
            }}
            pointerEvents={busy ? 'none' : 'auto'}
            style={{
              width: big,
              height: big,
              borderRadius: big / 2,
              backgroundColor: phase === 'holding' ? c.danger : c.yapi,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy ? 0.5 : 1,
              transform: [
                { translateX: (I18nManager.isRTL ? -1 : 1) * (drag?.dx ?? 0) * 0.4 },
                { translateY: (drag?.dy ?? 0) * 0.4 },
                { scale: phase === 'holding' ? 1.08 : 1 },
              ],
            }}
          >
            <Icon name="mic" size={36} color={phase === 'holding' ? c.onDanger : c.onYapi} />
          </View>
          {phase === 'idle' || phase === 'starting' ? (
            <View style={{ alignItems: 'center', gap: 2 }}>
              <Text style={{ color: c.ink, fontWeight: '700' }}>{t('voice.hold')}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('voice.tapStart')}</Text>
            </View>
          ) : null}
        </>
      )}

      {error ? (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: c.danger, fontSize: 14, textAlign: 'center' }}>
          {error}
        </Text>
      ) : null}
      {denied ? (
        <Notice tone="warn">
          <Text style={{ color: c.ink, lineHeight: 20 }}>{t('voice.micOff')}</Text>
          <Button label={t('m.common.openSettings')} size="sm" variant="secondary" onPress={() => Linking.openSettings()} style={{ alignSelf: 'flex-start' }} />
        </Notice>
      ) : null}
    </View>
  );
}
