'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Icon, SensitiveCover } from '@yapilapi/design-system';
import type { Message } from '@yapilapi/shared';

type Attachment = Message['attachments'][number];

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Photos, videos and voice messages inside a chat bubble. */
export function MessageAttachments({ items }: { items: Attachment[] }) {
  const [revealed, setRevealed] = useState<number[]>([]);
  if (!items.length) return null;
  return (
    <div className="chat-att">
      {items.map((a, i) =>
        a.removed ? (
          <p key={i} className="chat-att__removed">
            This photo or video isn’t available.
          </p>
        ) : a.sensitive && !revealed.includes(i) && (a.kind === 'image' || a.kind === 'video') ? (
          <div key={i} className="chat-att__media chat-att__sensitive">
            {a.kind === 'image' || a.posterUrl ? <img src={a.kind === 'image' ? a.url : a.posterUrl!} alt="" aria-hidden className="yp-blurred" /> : null}
            <SensitiveCover compact onReveal={() => setRevealed((r) => [...r, i])} />
          </div>
        ) : a.kind === 'image' ? (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="chat-att__media">
            <img src={a.url} alt={a.name || 'Photo'} loading="lazy" />
          </a>
        ) : a.kind === 'video' ? (
          <video
            key={i}
            className="chat-att__media"
            src={a.url}
            poster={a.posterUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            aria-label={a.name || 'Video'}
          />
        ) : a.kind === 'audio' ? (
          <VoiceNote key={i} url={a.url} durationMs={a.durationMs ?? null} />
        ) : (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
            {a.name || 'File'}
          </a>
        ),
      )}
    </div>
  );
}

function VoiceNote({ url, durationMs }: { url: string; durationMs: number | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(durationMs ?? 0);
  return (
    <div className="voice">
      <button
        type="button"
        className="voice__play"
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={() => {
          const a = audio.current;
          if (!a) return;
          if (a.paused) void a.play();
          else a.pause();
        }}
      >
        <Icon name={playing ? 'stop' : 'play'} size={16} filled />
      </button>
      <span className="voice__bar" aria-hidden>
        <span style={{ width: `${len ? Math.min(100, (pos / len) * 100) : 0}%` }} />
      </span>
      <span className="voice__time">{clock(playing || pos ? pos : len)}</span>
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setPos(0))}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          if (Number.isFinite(a.duration)) setLen(a.duration * 1000);
          // Recorded WebM has no duration in its header: seeking to the end makes the browser work it out.
          else if (!durationMs) a.currentTime = 1e7;
        }}
        onDurationChange={(e) => {
          const a = e.currentTarget;
          if (!Number.isFinite(a.duration)) return;
          setLen(a.duration * 1000);
          if (a.paused && a.currentTime > 0 && a.currentTime >= a.duration - 0.05) a.currentTime = 0;
        }}
        onTimeUpdate={(e) => !e.currentTarget.paused && setPos(e.currentTarget.currentTime * 1000)}
      />
    </div>
  );
}

/**
 * Hold-free voice recording: tap the mic to start, then send or cancel. Uses the
 * browser's recorder (webm/opus in Chromium and Firefox, mp4/aac in Safari).
 */
export function VoiceRecorder({
  onRecorded,
  onError,
  disabled,
}: {
  onRecorded: (file: File, durationMs: number) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'recording'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const keep = useRef(false);

  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => {
      const ms = Date.now() - started.current;
      setElapsed(ms);
      if (ms >= 5 * 60_000) stop(true); // five minutes at most
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => () => rec.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const start = async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onError("This browser can't record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const ms = Date.now() - started.current;
        if (!keep.current || ms < 700) return;
        const mime = (r.mimeType || 'audio/webm').split(';')[0]!;
        const file = new File(chunks.current, `voice.${mime === 'audio/mp4' ? 'm4a' : 'weba'}`, { type: mime });
        onRecorded(file, ms);
      };
      rec.current = r;
      started.current = Date.now();
      setElapsed(0);
      r.start(250);
      setState('recording');
    } catch {
      onError('Microphone access is off. Allow it in your browser to send voice messages.');
    }
  };

  const stop = (send: boolean) => {
    keep.current = send;
    rec.current?.stop();
    rec.current = null;
    setState('idle');
  };

  if (state === 'recording')
    return (
      <div className="voice-rec" role="group" aria-label="Recording a voice message">
        <span className="voice-rec__dot" aria-hidden />
        <span className="voice-rec__time" aria-live="off">
          {clock(elapsed)}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => stop(false)}>
          Cancel
        </Button>
        <Button type="button" size="sm" icon="send" onClick={() => stop(true)}>
          Send
        </Button>
      </div>
    );
  return (
    <button type="button" className="yp-action" aria-label="Record a voice message" disabled={disabled} onClick={() => void start()}>
      <Icon name="mic" />
    </button>
  );
}
