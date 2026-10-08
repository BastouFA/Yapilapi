import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  activeSegment,
  languageName,
  listenFinished,
  nextVoiceRate,
  resamplePeaks,
  seekMs,
  t,
  voiceClock,
  VOICE_PEAKS,
  type MessageKey,
  type VoiceClip,
  type VoiceRate,
} from '@yapilapi/shared';
import { Icon } from './icons.tsx';
import { cx } from './primitives.tsx';
import { useDataSaver } from './data-saver.tsx';
import { TranslationBar, useTranslatable } from './translation.tsx';

/**
 * The Yap player (docs/product/yaps.md): a play button, the clip's waveform to scrub along (a
 * slider for the keyboard and screen readers), the time, the speed and the transcript under it.
 * One clip plays at a time on the page, nothing plays by itself, and with Data saver nothing
 * loads until play is pressed.
 */

/** What the player tells the feed: a listen started, how much was heard (at each pause), and a listen to (nearly) the end. */
export interface VoiceListenEvent {
  kind: 'listen_start' | 'listen' | 'listen_complete';
  valueMs?: number;
}

export interface VoicePlayerProps {
  clip: VoiceClip;
  /** The play button's name, e.g. "Play Yap by Ada, 0:42" (voice.playA11y). */
  label: string;
  locale?: string;
  /** 'sm' for voice replies and intros, 'lg' on a Yap's own page. */
  size?: 'sm' | 'md' | 'lg';
  /** Show the transcript from the start (a Yap's own page). */
  transcriptOpen?: boolean;
  /** Offer the transcript at all (off for a recording that hasn't been sent yet). */
  transcript?: boolean;
  /** The reader made it: its transcript isn't offered for translation. */
  own?: boolean;
  onListen?: (e: VoiceListenEvent) => void;
  /** Ask again for the clip while its transcript is being made (every few seconds, while it's open and on screen). */
  refresh?: (id: string) => Promise<VoiceClip>;
  /** "Listen in English": the address of the transcript's translation read out (offered only when given). */
  speak?: (id: string, target: string) => Promise<string>;
  className?: string;
  /** A test hook on the player's root. */
  testId?: string;
}

const KEY_STEP_MS = 5000;
const POLL_MS = 4000;
const POLL_TRIES = 15;
/** A jump in the time bigger than this between two frames is a seek, not listening. */
const SEEK_GAP_S = 1.5;

// ── One at a time, and the next one ready ─────────────────────────────────
// Every mounted player, so the one after a playing one (in the page's order) can load ahead.
interface Entry {
  root: HTMLElement;
  promote: () => void;
}
const players = new Set<Entry>();
let current: HTMLAudioElement | null = null;
let listening = false;

/** Any other sound starting on the page (another player, a video, a song) pauses the playing clip. */
function listenForOthers() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener(
    'play',
    (e) => {
      if (current && e.target !== current && !current.paused) current.pause();
    },
    true,
  );
}

/** The player that comes next after `root` in the page gets to load its clip now. */
function readyNext(root: HTMLElement) {
  let next: Entry | null = null;
  for (const p of players) {
    if (p.root === root || !(root.compareDocumentPosition(p.root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (!next || p.root.compareDocumentPosition(next.root) & Node.DOCUMENT_POSITION_FOLLOWING) next = p;
  }
  next?.promote();
}

export function VoicePlayer({
  clip: given,
  label,
  locale = 'en',
  size = 'md',
  transcriptOpen = false,
  transcript: withTranscript = true,
  own,
  onListen,
  refresh,
  speak,
  className,
  testId,
}: VoicePlayerProps) {
  const tt = (k: MessageKey, vars?: Record<string, string | number>) => t(k, locale, vars);
  const saver = useDataSaver();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);

  // A newer copy of the clip, asked for while its transcript was being made.
  const [fresh, setFresh] = useState<VoiceClip | null>(null);
  const clip = fresh && fresh.id === given.id && given.transcript.status === 'pending' ? fresh : given;
  const durationMs = Math.max(1, clip.durationMs);

  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState<VoiceRate>(1);
  const [open, setOpen] = useState(transcriptOpen);
  const [promoted, setPromoted] = useState(false);
  const [visible, setVisible] = useState(false);
  // Nothing loads before play (the length and waveform come with the clip), except the clip after a playing one, off Data saver.
  const preload = !saver && promoted ? 'auto' : 'none';

  // Listening, for the feed: heard since the last report, the furthest point reached by listening, and whether it was finished.
  const listen = useRef(onListen);
  listen.current = onListen;
  const started = useRef(false);
  const heard = useRef(0);
  const furthest = useRef(0);
  const finished = useRef(false);
  const lastTime = useRef(0);
  const report = useCallback(() => {
    if (heard.current > 0) listen.current?.({ kind: 'listen', valueMs: Math.round(heard.current) });
    heard.current = 0;
  }, []);

  useEffect(() => {
    listenForOthers();
    const el = root.current;
    const sound = audio.current;
    if (!el) return;
    const entry: Entry = { root: el, promote: () => setPromoted(true) };
    players.add(entry);
    return () => {
      players.delete(entry);
      if (current === sound) current = null;
      // Gone while playing: what was heard still counts.
      report();
    };
  }, [report]);

  // On screen (for asking about the transcript only while it's seen).
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setVisible(true);
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The transcript is being made: ask again every few seconds while it's open and on screen.
  const pending = clip.transcript.status === 'pending';
  const tries = useRef(0);
  useEffect(() => {
    if (!refresh || !pending || !open || !visible || tries.current >= POLL_TRIES) return;
    let live = true;
    const timer = setInterval(() => {
      if (tries.current >= POLL_TRIES) return clearInterval(timer);
      tries.current++;
      refresh(clip.id).then(
        (c) => live && c.transcript.status !== 'pending' && setFresh(c),
        () => {},
      );
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refresh, pending, open, visible, clip.id]);

  // While playing: the time, smoothly, and what was heard.
  useEffect(() => {
    const el = audio.current;
    if (!playing || !el) return;
    let raf = 0;
    const tick = () => {
      const now = el.currentTime;
      const gap = now - lastTime.current;
      if (gap > 0 && gap < SEEK_GAP_S) {
        heard.current += gap * 1000;
        furthest.current = Math.max(furthest.current, now * 1000);
      }
      lastTime.current = now;
      setPos(Math.min(durationMs, now * 1000));
      if (!finished.current && listenFinished(furthest.current, durationMs)) {
        finished.current = true;
        listen.current?.({ kind: 'listen_complete' });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);

  const changeRate = () => {
    const next = nextVoiceRate(rate);
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    el.playbackRate = rate;
    void el.play().catch(() => setPlaying(false));
  };

  const seek = (ms: number) => {
    const to = Math.max(0, Math.min(durationMs, ms));
    setPos(to);
    lastTime.current = to / 1000;
    const el = audio.current;
    if (!el) return;
    try {
      el.currentTime = to / 1000;
    } catch {
      // Not loaded yet: it starts from here once it is.
    }
  };

  // Scrubbing along the waveform with a finger or the mouse.
  const dragging = useRef(false);
  const seekAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) seek(seekMs((e.clientX - box.left) / box.width, durationMs));
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const to =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown'
        ? pos - KEY_STEP_MS
        : e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? pos + KEY_STEP_MS
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? durationMs
              : null;
    if (to === null) return;
    e.preventDefault();
    seek(to);
  };

  const bars = resamplePeaks(clip.peaks, size === 'sm' ? 32 : VOICE_PEAKS);
  const played = pos / durationMs;
  const rateText = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rate);
  const st = clip.transcript;
  const showClock = playing || pos > 0;
  const transcriptId = `${id}-transcript`;

  return (
    <div ref={root} className={cx('yp-voice', `yp-voice--${size}`, playing && 'yp-voice--playing', className)} data-testid={testId}>
      <audio
        ref={audio}
        src={clip.url}
        preload={preload}
        onPlay={(e) => {
          current = e.currentTarget;
          e.currentTarget.playbackRate = rate;
          lastTime.current = e.currentTarget.currentTime;
          setPlaying(true);
          if (!started.current) {
            started.current = true;
            listen.current?.({ kind: 'listen_start' });
          }
          if (!saver && root.current) readyNext(root.current);
        }}
        onPause={() => {
          setPlaying(false);
          report();
        }}
        onEnded={() => {
          setPlaying(false);
          setPos(durationMs);
          report();
        }}
      />
      <div className="yp-voice__row">
        <button type="button" className="yp-voice__play" aria-label={playing ? tt('voice.pause') : label} onClick={toggle} data-testid="yap-play">
          <Icon name={playing ? 'pause' : 'play'} size={size === 'sm' ? 18 : 22} filled />
        </button>
        <div
          className="yp-voice__wave"
          role="slider"
          tabIndex={0}
          aria-label={tt('voice.seek')}
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(pos / 1000)}
          aria-valuetext={`${voiceClock(pos)} / ${voiceClock(durationMs)}`}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekAt(e);
          }}
          onPointerMove={(e) => dragging.current && seekAt(e)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
        >
          <svg viewBox={`0 0 ${bars.length * 4} 40`} preserveAspectRatio="none" aria-hidden focusable="false">
            {bars.map((p, i) => {
              const h = Math.max(3, (p / 100) * 40);
              return (
                <rect
                  key={i}
                  x={i * 4 + 0.6}
                  y={(40 - h) / 2}
                  width={2.8}
                  height={h}
                  rx={1.4}
                  className={(i + 0.5) / bars.length <= played ? 'is-played' : undefined}
                />
              );
            })}
          </svg>
        </div>
        <span className="yp-voice__clock" aria-hidden>
          {showClock ? `${voiceClock(pos)} / ${voiceClock(durationMs)}` : voiceClock(durationMs)}
        </span>
        <button type="button" className="yp-voice__rate" aria-label={tt('voice.speed', { rate: rateText })} onClick={changeRate}>
          {`${rateText}×`}
        </button>
      </div>
      {withTranscript ? (
        <div className="yp-voice__transcript">
          <button
            type="button"
            className="yp-voice__toggle"
            aria-expanded={open}
            aria-controls={transcriptId}
            onClick={() => setOpen((o) => !o)}
            data-testid="yap-transcript-toggle"
          >
            <Icon name="chevron-down" size={16} />
            {tt(open ? 'voice.transcript.hide' : 'voice.transcript.show')}
          </button>
          <div id={transcriptId} className="yp-voice__words" role="region" aria-label={tt('voice.transcript')} hidden={!open}>
            {open ? (
              st.status === 'ready' && st.text ? (
                <VoiceTranscript
                  clip={clip}
                  own={own}
                  locale={locale}
                  at={pos / 1000}
                  playing={playing || pos > 0}
                  onSeek={(s) => seek(s * 1000)}
                  speak={speak}
                />
              ) : (
                <p className="yp-voice__note" role="status">
                  {tt(st.status === 'pending' ? 'voice.transcript.pending' : 'voice.transcript.unavailable')}
                </p>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The words: in the reader's language when it's someone else's and in another language
 * ("Translated from French · See original"). In the original, each timed line can be pressed to
 * go to it, and the line being spoken is marked while it plays.
 */
export function VoiceTranscript({
  clip,
  own,
  locale,
  at,
  playing,
  onSeek,
  speak,
}: {
  clip: VoiceClip;
  own?: boolean;
  locale: string;
  at: number;
  playing: boolean;
  onSeek: (seconds: number) => void;
  speak?: (id: string, target: string) => Promise<string>;
}) {
  const st = clip.transcript;
  const state = useTranslatable({ kind: 'voice', id: clip.id, text: st.text ?? '', lang: st.lang, own });
  const translated = state.status === 'shown' && !!state.translation;
  const segments = st.segments;
  const active = playing ? activeSegment(segments, at) : -1;
  return (
    <>
      {translated || !segments.length ? (
        <p ref={state.ref} className="yp-voice__text" dir="auto" lang={state.lang ?? st.lang ?? undefined}>
          {state.text}
        </p>
      ) : (
        <p ref={state.ref} className="yp-voice__text" dir="auto" lang={st.lang ?? undefined}>
          {segments.map((s, i) => (
            <span key={i}>
              {i ? ' ' : null}
              <button type="button" className="yp-voice__seg" aria-current={i === active ? 'true' : undefined} onClick={() => onSeek(s.start)}>
                {s.text.trim()}
              </button>
            </span>
          ))}
        </p>
      )}
      <TranslationBar state={state} locale={locale} />
      {translated && speak && state.translation ? <ListenButton id={clip.id} target={state.translation.targetLanguage} locale={locale} speak={speak} /> : null}
    </>
  );
}

/** "Listen in English": the translation read out by a plain synthetic voice, made the first time anyone asks. It plays like any clip: one at a time. */
function ListenButton({ id, target, locale, speak }: { id: string; target: string; locale: string; speak: (id: string, target: string) => Promise<string> }) {
  const sound = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'failed'>('idle');
  useEffect(() => () => sound.current?.pause(), []);
  const toggle = async () => {
    if (state === 'playing') return sound.current?.pause();
    if (!sound.current) {
      setState('loading');
      try {
        const a = new Audio(await speak(id, target));
        a.onplay = () => setState('playing');
        a.onpause = a.onended = () => setState('idle');
        sound.current = a;
      } catch {
        return setState('failed');
      }
    }
    await sound.current.play().catch(() => setState('idle'));
  };
  return (
    <>
      <button
        type="button"
        className="yp-translate__link yp-voice__listen"
        aria-pressed={state === 'playing'}
        aria-busy={state === 'loading'}
        disabled={state === 'loading'}
        onClick={() => void toggle()}
      >
        <Icon name={state === 'playing' ? 'stop' : 'play'} size={14} filled />
        {t('chat.transcript.listen', locale, { language: languageName(target, locale) })}
      </button>
      {state === 'failed' ? (
        <span className="yp-voice__note" role="status">
          {t('voice.failed', locale)}
        </span>
      ) : null}
    </>
  );
}
