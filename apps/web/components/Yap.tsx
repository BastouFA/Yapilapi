'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Icon } from '@yapilapi/design-system';
import type { Message, YapEvent } from '@yapilapi/shared';
import { useRealtime, useSession } from '@/app/providers';

/** A yap is up to 60 seconds; recording stops there and sends. */
export const YAP_MAX_MS = 60_000;
/** Shorter than this is a slip of the finger: not sent. */
const YAP_MIN_MS = 400;

// ── Audio: one AudioContext for the tab, unlocked by a click or key press ──
// Browsers only let a page play sound by itself after the person has interacted
// with it. "Turn on Yaps" is that interaction the first time; after that, any
// click or key press on the page unlocks sound again for the session.

const ON_KEY = 'ypl.yaps.on';
let audio: AudioContext | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function readOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === '1';
  } catch {
    return false;
  }
}

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audio) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
    audio.onstatechange = changed;
  }
  return audio;
}

/** Call from a click or key press. Remembers the choice and unlocks sound for this tab. */
export async function turnOnYaps(): Promise<void> {
  try {
    localStorage.setItem(ON_KEY, '1');
  } catch {
    // Private windows: it still works until the tab closes.
  }
  await context()
    ?.resume()
    .catch(() => {});
  changed();
}

/** 'off': never turned on here. 'locked': turned on, waiting for a click this session. 'ready': yaps can play. */
export function useYapAudio(): 'off' | 'locked' | 'ready' {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => (!readOn() ? 'off' : audio?.state === 'running' ? 'ready' : 'locked'),
    () => 'off',
  );
}

/** Media addresses on the API host are fetched through the web app's /media proxy, so Web Audio can read them. */
function sameOrigin(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.pathname.startsWith('/media/') ? u.pathname : u.href;
  } catch {
    return url;
  }
}

// ── Recording ─────────────────────────────────────────────────────────────

/**
 * The big Yap button: hold it (or hold the Space bar when you aren't typing) to talk,
 * let go to send. Uses the browser's recorder; the server turns it into M4A.
 */
export function YapButton({
  onRecorded,
  onError,
  disabled,
}: {
  onRecorded: (file: File, durationMs: number) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const [talking, setTalking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const started = useRef(0);
  const holding = useRef(false);

  const stop = useCallback(() => {
    holding.current = false;
    const r = rec.current;
    rec.current = null;
    setTalking(false);
    if (r && r.state !== 'inactive') r.stop();
  }, []);

  const start = useCallback(async () => {
    if (disabled || holding.current) return;
    holding.current = true;
    // Holding the button is a user gesture: a good moment to unlock sound for incoming yaps too.
    if (readOn()) void context()?.resume();
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      holding.current = false;
      onError("This browser can't record audio.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      holding.current = false;
      onError('Microphone access is off. Allow it in your browser to send Yaps.');
      return;
    }
    // Let go while the browser was still asking for the microphone.
    if (!holding.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const ms = Math.min(YAP_MAX_MS, Date.now() - started.current);
      if (ms < YAP_MIN_MS) return;
      const mime = (r.mimeType || 'audio/webm').split(';')[0]!;
      onRecorded(new File(chunks, `yap.${mime === 'audio/mp4' ? 'm4a' : 'weba'}`, { type: mime }), ms);
    };
    rec.current = r;
    started.current = Date.now();
    setElapsed(0);
    r.start(250);
    setTalking(true);
  }, [disabled, onError, onRecorded]);

  // The clock, and the 60-second limit.
  useEffect(() => {
    if (!talking) return;
    const t = setInterval(() => {
      const ms = Date.now() - started.current;
      setElapsed(ms);
      if (ms >= YAP_MAX_MS) stop();
    }, 200);
    return () => clearInterval(t);
  }, [talking, stop]);

  // Hold Space to talk, unless you're typing somewhere.
  useEffect(() => {
    const typing = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      void start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !holding.current) return;
      e.preventDefault();
      stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
    };
  }, [start, stop]);

  useEffect(() => () => stop(), [stop]);

  const secs = Math.floor(elapsed / 1000);
  return (
    <button
      type="button"
      className={`yap-btn${talking ? ' yap-btn--live' : ''}`}
      disabled={disabled}
      aria-label="Yap: hold to talk, release to send. You can also hold the Space bar."
      aria-pressed={talking}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        void start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          void start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          stop();
        }
      }}
    >
      <Icon name="mic" size={20} filled={talking} />
      <span>{talking ? `Release to send · 0:${String(secs).padStart(2, '0')}` : 'Hold to Yap'}</span>
    </button>
  );
}

/** Shown in a chat the first time: sound can only start by itself after one click. */
export function TurnOnYapsPrompt() {
  const state = useYapAudio();
  if (state !== 'off') return null;
  return (
    <div className="yap-prompt" role="note">
      <Icon name="volume" size={18} />
      <span>Yaps are voice clips that play as soon as they arrive, like a walkie-talkie. Your browser needs one click to allow sound.</span>
      <Button size="sm" onClick={() => void turnOnYaps()}>
        Turn on Yaps
      </Button>
    </div>
  );
}

// ── Playing ───────────────────────────────────────────────────────────────

type Playing = { from: string; message: Message; stop: () => void; analyser: AnalyserNode | null; startedAt: number; durationMs: number };

/**
 * Plays incoming yaps out loud, one after another, while this tab is focused and the
 * server said this person allows it (`autoplay`). Shows "Yap from Name" with a live
 * waveform. Yaps that don't autoplay arrive silently in the chat like voice messages.
 */
export function YapPlayer() {
  const { me } = useSession();
  const state = useYapAudio();
  const queue = useRef<YapEvent[]>([]);
  const [now, setNow] = useState<Playing | null>(null);
  const [waiting, setWaiting] = useState<YapEvent | null>(null);
  const busy = useRef(false);

  // After "Turn on Yaps" once, any click or key press unlocks sound again in a new session.
  useEffect(() => {
    if (state !== 'locked') return;
    const unlock = () => void context()?.resume();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [state]);

  const next = useCallback(async () => {
    if (busy.current) return;
    const e = queue.current.shift();
    if (!e) return;
    const c = context();
    const url = e.message.attachments[0]?.url;
    if (!c || c.state !== 'running' || !url) {
      setWaiting(e);
      return;
    }
    busy.current = true;
    const done = () => {
      busy.current = false;
      setNow(null);
      void next();
    };
    try {
      const res = await fetch(sameOrigin(url), { credentials: 'include' });
      const decoded = await c.decodeAudioData(await res.arrayBuffer());
      const src = c.createBufferSource();
      src.buffer = decoded;
      const analyser = c.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser).connect(c.destination);
      src.onended = done;
      src.start();
      setNow({
        from: e.message.sender.displayName,
        message: e.message,
        analyser,
        startedAt: Date.now(),
        durationMs: decoded.duration * 1000,
        stop: () => src.stop(),
      });
    } catch {
      // Couldn't read it through Web Audio (another host without CORS): a plain audio element still plays it.
      const el = new Audio(url);
      el.onended = done;
      el.onerror = done;
      try {
        await el.play();
        setNow({
          from: e.message.sender.displayName,
          message: e.message,
          analyser: null,
          startedAt: Date.now(),
          durationMs: e.message.attachments[0]?.durationMs ?? 0,
          stop: () => (el.pause(), done()),
        });
      } catch {
        done();
      }
    }
  }, []);

  useRealtime((e) => {
    if (e.type !== 'yap' || !me) return;
    const y = e.data as YapEvent;
    if (!y.autoplay || y.message.sender.id === me.id) return;
    // Only in the tab you're looking at: never out of a background tab.
    if (typeof document !== 'undefined' && !document.hasFocus()) return;
    queue.current.push(y);
    void next();
  });

  // Sound unlocked while a yap was waiting: play it.
  useEffect(() => {
    if (state === 'ready' && waiting) {
      queue.current.unshift(waiting);
      setWaiting(null);
      void next();
    }
  }, [state, waiting, next]);

  if (now)
    return (
      <div className="yap-banner" role="status" aria-live="polite">
        <Icon name="volume" size={18} />
        <span className="yap-banner__from">Yap from {now.from}</span>
        <Waveform analyser={now.analyser} />
        <button type="button" className="yap-banner__stop" onClick={now.stop} aria-label="Stop this Yap">
          <Icon name="stop" size={16} filled />
        </button>
      </div>
    );
  if (waiting)
    return (
      <div className="yap-banner" role="status" aria-live="polite">
        <Icon name="volume-off" size={18} />
        <span className="yap-banner__from">Yap from {waiting.message.sender.displayName}</span>
        <Button size="sm" onClick={() => void turnOnYaps()}>
          {state === 'off' ? 'Turn on Yaps' : 'Play'}
        </Button>
        <button type="button" className="yap-banner__stop" onClick={() => setWaiting(null)} aria-label="Dismiss">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  return null;
}

/** Bars that move with the sound (or gently, when the sound can't be read). */
function Waveform({ analyser }: { analyser: AnalyserNode | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    const data = new Uint8Array(analyser?.frequencyBinCount ?? 32);
    const color = getComputedStyle(el).color;
    let raf = 0;
    const draw = (t: number) => {
      if (analyser) analyser.getByteFrequencyData(data);
      else for (let i = 0; i < data.length; i++) data[i] = 90 + 70 * Math.sin(t / 180 + i * 0.7);
      g.clearRect(0, 0, el.width, el.height);
      g.fillStyle = color;
      const bars = 16;
      const w = el.width / bars;
      for (let i = 0; i < bars; i++) {
        const v = (data[Math.floor((i / bars) * data.length)] ?? 0) / 255;
        const h = Math.max(3, v * el.height);
        g.fillRect(i * w + 1, (el.height - h) / 2, w - 2, h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser]);
  return <canvas ref={canvas} className="yap-wave" width={96} height={24} aria-hidden />;
}
