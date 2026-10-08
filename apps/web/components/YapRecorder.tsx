'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, VoicePlayer } from '@yapilapi/design-system';
import { peaksFromSamples, VOICE_MIN_MS, type MessageKey, type VoiceClip, type VoicePurpose } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Recording a Yap, a voice reply or a voice intro (docs/product/yaps.md). The big round button:
 * hold it to talk and let go to stop, or press it once to start and again to stop (a quick tap,
 * Enter or Space). A countdown shows what's left, recording stops by itself at the limit, and
 * afterwards the recording can be played back, recorded again or discarded before it's sent.
 */

/** A press shorter than this is a tap: recording keeps going until the next one. */
const TAP_MS = 300;
/** How often the live waveform takes a reading. */
const LEVEL_MS = 80;
/** Bars in the live waveform while recording. */
const LIVE_BARS = 36;

export interface Recording {
  blob: Blob;
  durationMs: number;
  filename: string;
}

type State = 'idle' | 'asking' | 'recording' | 'done';

export function YapRecorder({
  maxMs,
  onDone,
  onReset,
  label,
  actions,
  compact,
  disabled,
}: {
  maxMs: number;
  /** A recording was made (it shows as a preview; sending it is up to the page). */
  onDone: (blob: Blob, durationMs: number, filename: string) => void;
  /** The recording was discarded or is being made again. */
  onReset?: () => void;
  /** The record button's name for screen readers (voice.recordA11y by default). */
  label?: string;
  /** Buttons shown next to "Record again" under the preview (Send, Save). */
  actions?: ReactNode;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { t, locale } = useSession();
  const [state, setState] = useState<State>('idle');
  const [tapMode, setTapMode] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [preview, setPreview] = useState<VoiceClip | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const startedAt = useRef(0);
  const pressedAt = useRef(0);
  const keep = useRef(true);
  const all = useRef<number[]>([]);
  // Wanted: still true while the browser asks for the microphone; a cancel in that time stops it from starting.
  const wanted = useRef(false);

  const cleanup = useCallback(() => {
    rec.current?.stream.getTracks().forEach((tr) => tr.stop());
    rec.current = null;
    void ctx.current?.close().catch(() => {});
    ctx.current = null;
  }, []);

  const stop = useCallback(
    (save = true) => {
      wanted.current = false;
      keep.current = save;
      const r = rec.current;
      if (r && r.state !== 'inactive') r.stop();
      else {
        cleanup();
        setState((s) => (s === 'asking' ? 'idle' : s));
      }
    },
    [cleanup],
  );

  const start = useCallback(async () => {
    if (disabled || state === 'recording' || state === 'asking') return;
    setProblem(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setProblem('chat.noRecording');
      return;
    }
    wanted.current = true;
    setState('asking');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      wanted.current = false;
      setState('idle');
      setProblem('voice.micOff');
      return;
    }
    if (!wanted.current) {
      stream.getTracks().forEach((tr) => tr.stop());
      setState('idle');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const ms = Math.min(maxMs, Date.now() - startedAt.current);
      cleanup();
      if (!keep.current) return setState('idle');
      if (ms < VOICE_MIN_MS) {
        setProblem('voice.tooShort');
        return setState('idle');
      }
      const mime = (r.mimeType || 'audio/webm').split(';')[0]!;
      const blob = new Blob(chunks, { type: mime });
      const filename = `yap.${mime === 'audio/mp4' ? 'm4a' : 'webm'}`;
      setPreview({
        id: `local-${startedAt.current}`,
        url: URL.createObjectURL(blob),
        durationMs: ms,
        peaks: peaksFromSamples(all.current),
        transcript: { status: 'unavailable', text: null, lang: null, segments: [] },
      });
      setState('done');
      onDone(blob, ms, filename);
    };
    all.current = [];
    setLevels([]);
    // The live waveform: how loud it is, a few times a second.
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const c = new AC();
        const analyser = c.createAnalyser();
        analyser.fftSize = 1024;
        c.createMediaStreamSource(stream).connect(analyser);
        ctx.current = c;
        const buf = new Float32Array(analyser.fftSize);
        const read = () => {
          if (ctx.current !== c) return;
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
          const level = Math.sqrt(sum / buf.length);
          all.current.push(level);
          setLevels((l) => [...l.slice(-(LIVE_BARS - 1)), level]);
          setTimeout(read, LEVEL_MS);
        };
        read();
      }
    } catch {
      // No waveform: recording still works.
    }
    keep.current = true;
    rec.current = r;
    startedAt.current = Date.now();
    setElapsed(0);
    r.start(250);
    setState('recording');
  }, [disabled, state, maxMs, cleanup, onDone]);

  // The countdown, and stopping at the limit.
  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= maxMs) stop(true);
    }, 100);
    return () => clearInterval(timer);
  }, [state, maxMs, stop]);

  // Leaving the page stops the microphone; the preview's address is let go.
  useEffect(
    () => () => {
      keep.current = false;
      wanted.current = false;
      if (rec.current?.state === 'recording') rec.current.stop();
      cleanup();
    },
    [cleanup],
  );
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview.url)), [preview]);

  const reset = () => {
    setPreview(null);
    setState('idle');
    setTapMode(false);
    setProblem(null);
    onReset?.();
  };

  const live = state === 'recording' || state === 'asking';
  const secondsLeft = Math.max(0, Math.ceil((maxMs - elapsed) / 1000));
  // Live bars by how loud it is now (speech is mostly between 0.02 and 0.3), not scaled to the loudest so far.
  const peaks = levels.map((l) => Math.min(100, Math.round(l * 350)));

  if (state === 'done' && preview)
    return (
      <div className={compact ? 'yap-rec yap-rec--compact' : 'yap-rec'}>
        <VoicePlayer clip={preview} label={t('voice.play')} locale={locale} size={compact ? 'sm' : 'md'} transcript={false} testId="yap-preview" />
        <div className="yap-rec__actions">
          <Button size="sm" variant="ghost" icon="mic" onClick={reset}>
            {t('voice.rerecord')}
          </Button>
          {actions}
        </div>
      </div>
    );

  return (
    <div className={compact ? 'yap-rec yap-rec--compact' : 'yap-rec'}>
      <div className="yap-rec__stage">
        <button
          type="button"
          className={live ? 'yap-rec__btn yap-rec__btn--live' : 'yap-rec__btn'}
          aria-label={label ?? t('voice.recordA11y')}
          aria-pressed={live}
          disabled={disabled}
          data-testid="yap-record"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (live && tapMode) return stop(true);
            e.currentTarget.setPointerCapture(e.pointerId);
            pressedAt.current = Date.now();
            setTapMode(false);
            void start();
          }}
          onPointerUp={() => {
            if (!live || tapMode) return;
            // A quick tap, or let go while the browser was still asking: keep recording until the next press.
            if (Date.now() - pressedAt.current < TAP_MS || state === 'asking') setTapMode(true);
            else stop(true);
          }}
          onPointerCancel={() => !tapMode && stop(true)}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && live) {
              e.preventDefault();
              // Keeps a sheet around it open: its Escape listener sits on the document, next to React's.
              e.nativeEvent.stopImmediatePropagation();
              return stop(false);
            }
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
              e.preventDefault();
              if (live) stop(true);
              else {
                setTapMode(true);
                void start();
              }
            }
          }}
        >
          <Icon name={live ? 'stop' : 'mic'} size={compact ? 22 : 32} filled={live} />
          {compact ? null : <span>{t('m.create.mode.yap')}</span>}
        </button>
        {live ? (
          <div className="yap-rec__live">
            <svg className="yap-rec__wave" viewBox={`0 0 ${LIVE_BARS * 4} 40`} preserveAspectRatio="none" aria-hidden focusable="false">
              {peaks.map((p, i) => {
                const h = Math.max(3, (p / 100) * 40);
                return <rect key={i} x={(LIVE_BARS - peaks.length + i) * 4 + 0.6} y={(40 - h) / 2} width={2.8} height={h} rx={1.4} />;
              })}
            </svg>
            <span className="yap-rec__left">{t('voice.left', { seconds: secondsLeft })}</span>
          </div>
        ) : null}
      </div>
      <p className="yap-rec__hint muted">{live ? (tapMode ? t('voice.tapStop') : t('voice.hold')) : `${t('voice.hold')} · ${t('voice.tapStart')}`}</p>
      {live ? (
        <div className="yap-rec__actions">
          <Button size="sm" variant="ghost" icon="x" onClick={() => stop(false)}>
            {t('voice.discard')}
          </Button>
        </div>
      ) : null}
      <p className="yap-rec__problem" role="status">
        {problem ? t(problem) : null}
      </p>
    </div>
  );
}

/** Send a recording (the server measures it and draws its waveform); the clip, or the reason it couldn't be. */
export async function uploadVoice(r: Recording, purpose: VoicePurpose): Promise<VoiceClip> {
  return (await api.voice.upload(r.blob, purpose, r.filename)).voice;
}

/** Why a recording couldn't be sent: what the server said (too long, too many), or "try again". */
export function voiceError(e: unknown, t: (k: MessageKey) => string): string {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 ? errorMessage(e) : t('voice.failed');
}
