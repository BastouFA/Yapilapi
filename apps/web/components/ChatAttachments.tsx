'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Icon, SensitiveCover } from '@yapilapi/design-system';
import type { Message, MessageKey } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type Attachment = Message['attachments'][number];

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Photos, videos and voice messages inside a chat bubble. */
export function MessageAttachments({ items }: { items: Attachment[] }) {
  const { t, locale } = useSession();
  const [revealed, setRevealed] = useState<number[]>([]);
  if (!items.length) return null;
  return (
    <div className="chat-att">
      {items.map((a, i) =>
        a.removed ? (
          <p key={i} className="chat-att__removed">
            {t('m.media.unavailable')}
          </p>
        ) : a.sensitive && !revealed.includes(i) && (a.kind === 'image' || a.kind === 'video') ? (
          <div key={i} className="chat-att__media chat-att__sensitive">
            {a.kind === 'image' || a.posterUrl ? (
              <img src={a.kind === 'image' ? a.url : a.posterUrl!} alt="" aria-hidden className="yp-blurred" loading="lazy" decoding="async" />
            ) : null}
            <SensitiveCover compact locale={locale} onReveal={() => setRevealed((r) => [...r, i])} />
          </div>
        ) : a.kind === 'image' ? (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="chat-att__media">
            <img src={a.url} alt={a.name || t('m.post.photo')} loading="lazy" decoding="async" />
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
            aria-label={a.name || t('m.chat.video')}
          />
        ) : a.kind === 'audio' ? (
          <VoiceNote key={i} url={a.url} durationMs={a.durationMs ?? null} />
        ) : (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
            {a.name || t('chat.file')}
          </a>
        ),
      )}
    </div>
  );
}

function VoiceNote({ url, durationMs }: { url: string; durationMs: number | null }) {
  const { t } = useSession();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(durationMs ?? 0);
  return (
    <div className="voice">
      <button
        type="button"
        className="voice__play"
        aria-label={playing ? t('m.chat.pauseVoice') : t('m.chat.playVoice')}
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
 * A view-once photo or video in a chat. Recipients tap to open it full screen; when they
 * close it, it's gone for them. The sender sees who opened it. The file is fetched with a
 * short-lived link and shown from memory, never from a public address.
 */
export function ViewOnceMessage({ message, mine, onChange }: { message: Message; mine: boolean; onChange: (m: Message) => void }) {
  const { t, locale } = useSession();
  const list = (names: string[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
  const info = message.viewOnce!;
  const video = info.kind === 'video';
  const voice = info.kind === 'audio';
  /** The right words for a photo, a video or a voice note. */
  const pick = (photo: MessageKey, vid: MessageKey, audio: MessageKey) => (voice ? audio : video ? vid : photo);
  const [open, setOpen] = useState<{ src: string; kind: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function view() {
    setError(null);
    setLoading(true);
    try {
      const link = await api.viewOnce.open(message.id);
      const blob = await api.viewOnce.file(link.url);
      setOpen({ src: URL.createObjectURL(blob), kind: link.kind });
    } catch (e) {
      setError(errorMessage(e));
      // Already opened elsewhere or expired: show the final state.
      if (e instanceof ApiError && e.status === 410)
        onChange({ ...message, viewOnce: { ...info, state: e.code === 'view_once_viewed' ? 'viewed' : 'expired' } });
    } finally {
      setLoading(false);
    }
  }

  async function close() {
    if (open) URL.revokeObjectURL(open.src);
    setOpen(null);
    try {
      const r = await api.viewOnce.viewed(message.id);
      onChange({ ...message, viewOnce: r.viewOnce });
    } catch {
      onChange({ ...message, viewOnce: { ...info, state: 'viewed' } });
    }
  }

  // Leaving the page while it's open counts as closing it.
  useEffect(() => {
    if (!open) return;
    const leave = () => navigator.sendBeacon?.(`/api/v1/messages/${message.id}/view-once/viewed`);
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [open, message.id]);

  const opened = info.openedBy ?? [];
  const who = opened.map((o) => o.user.displayName);
  const shots = opened.filter((o) => o.screenshot).map((o) => o.user.displayName);
  return (
    <div className="view-once">
      {mine || info.state !== 'ready' ? (
        <div className="view-once__row">
          <Icon name={info.state === 'ready' ? 'eye' : 'check'} size={18} />
          <span>
            {info.state === 'ready'
              ? t(pick('m.viewOnce.photoSent', 'm.viewOnce.videoSent', 'm.viewOnce.voiceSent'))
              : info.state === 'viewed'
                ? t(pick('m.viewOnce.photoViewed', 'm.viewOnce.videoViewed', 'm.viewOnce.voiceViewed'))
                : t(pick('m.viewOnce.photoExpired', 'm.viewOnce.videoExpired', 'm.viewOnce.voiceExpired'))}
          </span>
        </div>
      ) : (
        <button type="button" className="view-once__row view-once__open" onClick={() => void view()} disabled={loading}>
          <Icon name="eye" size={18} />
          <span>{loading ? t('m.viewOnce.opening') : t(pick('m.viewOnce.tapPhoto', 'm.viewOnce.tapVideo', 'm.viewOnce.tapVoice'))}</span>
        </button>
      )}
      {mine ? (
        <span className="view-once__meta">
          {[
            who.length ? t('m.viewOnce.openedBy', { names: list(who) }) : info.state === 'ready' ? t('m.viewOnce.notOpened') : '',
            shots.length ? t('m.viewOnce.screenshotBy', { names: list(shots) }) : '',
          ]
            .filter(Boolean)
            .join('. ')}
        </span>
      ) : null}
      {error ? (
        <span className="view-once__meta" role="alert">
          {error}
        </span>
      ) : null}
      {open ? (
        <div
          className="view-once__viewer"
          role="dialog"
          aria-modal
          aria-label={t(pick('chat.viewOnce.photoFrom', 'chat.viewOnce.videoFrom', 'chat.viewOnce.voiceFrom'), { name: message.sender.displayName })}
        >
          <div className="view-once__bar">
            <span>{t(pick('chat.viewOnce.photoBar', 'chat.viewOnce.videoBar', 'chat.viewOnce.voiceBar'), { name: message.sender.displayName })}</span>
            <Button size="sm" variant="ghost" onClick={() => void close()} autoFocus>
              {t('m.common.close')}
            </Button>
          </div>
          {open.kind === 'audio' ? (
            <div className="view-once__voice">
              <Icon name="mic" size={40} />
              {/* Plays once: when it ends, closing is the only way on, and the file is deleted. */}
              <audio
                src={open.src}
                autoPlay
                controls
                controlsList="nodownload noplaybackrate"
                onEnded={() => void close()}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>
          ) : open.kind === 'video' ? (
            <video
              src={open.src}
              autoPlay
              playsInline
              controls
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
            />
          ) : (
            <img
              src={open.src}
              alt={t('chat.viewOnce.photoAlt', { name: message.sender.displayName })}
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          <p className="view-once__note">{t('chat.viewOnce.webNote')}</p>
          <EscapeToClose onClose={() => void close()} />
        </div>
      ) : null}
    </div>
  );
}

function EscapeToClose({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return null;
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
  const { t } = useSession();
  const [state, setState] = useState<'idle' | 'recording'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const keep = useRef(false);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => {
      const ms = Date.now() - started.current;
      setElapsed(ms);
      if (ms >= 5 * 60_000) stop(true); // five minutes at most
    }, 250);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => () => rec.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const start = async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onError(t('chat.noRecording'));
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
      onError(t('chat.micOffVoice'));
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
      <div className="voice-rec" role="group" aria-label={t('chat.recordingVoice')}>
        <span className="voice-rec__dot" aria-hidden />
        <span className="voice-rec__time" aria-live="off">
          {clock(elapsed)}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => stop(false)}>
          {t('common.cancel')}
        </Button>
        <Button type="button" size="sm" icon="send" onClick={() => stop(true)}>
          {t('inbox.send')}
        </Button>
      </div>
    );
  return (
    <button type="button" className="yp-action" aria-label={t('m.chat.record')} disabled={disabled} onClick={() => void start()}>
      <Icon name="mic" />
    </button>
  );
}
