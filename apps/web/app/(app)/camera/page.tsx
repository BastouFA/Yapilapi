'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@yapilapi/design-system';
import { isVideoFile, MEDIA_ACCEPT, VIDEO_ACCEPT } from '@yapilapi/shared';
import { deliverPendingMedia, type CreateMode } from '@/lib/pending-media';
import { useSession } from '../../providers';

const MODES: { id: CreateMode; label: string }[] = [
  { id: 'post', label: 'Post' },
  { id: 'reel', label: 'Reel' },
  { id: 'story', label: 'Story' },
];
/** Press longer than this on the shutter (post, story) records a video instead of taking a photo. */
const HOLD_MS = 350;
const CLIP_MAX_SECONDS = 60;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * The camera that "+" opens. Choose Post, Reel or Story at the bottom, then:
 * - Post and Story: tap the shutter for a photo, hold it to record a video.
 * - Reel: tap to start recording, tap again to stop (up to the reel limit).
 * Or open the gallery. What you take goes to Create, where the editor opens with it.
 */
function Camera() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, toast } = useSession();
  const initial = (['post', 'reel', 'story'] as const).find((m) => m === params.get('mode')) ?? 'post';
  const [mode, setMode] = useState<CreateMode>(initial);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [status, setStatus] = useState<'starting' | 'ready' | 'denied' | 'none'>('starting');
  const [hasAudio, setHasAudio] = useState(false);
  const [canFlip, setCanFlip] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [flash, setFlash] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const pressAt = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gallery = useRef<HTMLInputElement>(null);

  const reelMax = me?.plus ? 600 : 180;
  const maxSeconds = mode === 'reel' ? reelMax : CLIP_MAX_SECONDS;

  // Start (or restart, when flipping) the camera. Audio is asked for too, for videos; photos work without it.
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setStatus('none');
      setStatus('starting');
      let s: MediaStream | null = null;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true });
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return !cancelled && setStatus('none');
        // The microphone may be the refused part: try the camera alone.
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }).catch(() => null);
        if (!s) return !cancelled && setStatus(name === 'NotAllowedError' ? 'denied' : 'none');
      }
      if (cancelled) return s.getTracks().forEach((t) => t.stop());
      stream.current = s;
      setHasAudio(s.getAudioTracks().length > 0);
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => {});
      }
      setStatus('ready');
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!cancelled) setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
    };
    void start();
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [facing]);

  const finish = useCallback(
    (files: File[], as: CreateMode) => {
      deliverPendingMedia(files, as);
      router.replace(as === 'post' ? '/create' : `/create?mode=${as}`);
    },
    [router],
  );

  const takePhoto = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d')!;
    // The front camera preview is shown mirrored; the photo is saved as others will see you.
    g.drawImage(v, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 150);
    c.toBlob((b) => b && finish([new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })], mode), 'image/jpeg', 0.92);
  };

  const startRecording = () => {
    const s = stream.current;
    if (!s || recording) return;
    if (typeof MediaRecorder === 'undefined') return toast("This browser can't record video. Choose one from your gallery.");
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(s, type ? { mimeType: type, videoBitsPerSecond: 5_000_000 } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      const mime = (r.mimeType || 'video/webm').split(';')[0]!;
      const blob = new Blob(chunks.current, { type: mime });
      setRecording(false);
      if (blob.size < 1000) return;
      finish([new File([blob], `video-${Date.now()}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`, { type: mime })], mode);
    };
    recorder.current = r;
    r.start(250);
    setElapsed(0);
    setRecording(true);
  };

  const stopRecording = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
  };

  // Recording timer, stopping at the limit.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const t = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setElapsed(s);
      if (s >= maxSeconds) stopRecording();
    }, 100);
    return () => clearInterval(t);
  }, [recording, maxSeconds]);

  // Shutter: reel = tap to start and stop; post and story = tap for a photo, hold for a video.
  const onShutterDown = () => {
    if (status !== 'ready' || mode === 'reel') return;
    pressAt.current = Date.now();
    holdTimer.current = setTimeout(startRecording, HOLD_MS);
  };
  const onShutterUp = () => {
    if (status !== 'ready') return;
    if (mode === 'reel') return recording ? stopRecording() : startRecording();
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (recording) stopRecording();
    else if (Date.now() - pressAt.current < HOLD_MS + 50) takePhoto();
  };

  const onKey = (e: React.KeyboardEvent) => {
    // Keyboard: Enter or Space acts like a tap (photo, or start/stop a reel); R starts and stops a video.
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      return recording ? stopRecording() : startRecording();
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const i = MODES.findIndex((m) => m.id === mode) + (e.key === 'ArrowRight' ? 1 : -1);
      if (MODES[i] && !recording) setMode(MODES[i]!.id);
    }
  };

  const shutterLabel = recording ? 'Stop recording' : mode === 'reel' ? 'Start recording' : 'Take photo, or hold to record a video';

  return (
    <div className="cam" role="dialog" aria-modal="true" aria-label="Camera" onKeyDown={onKey}>
      <video ref={video} className={`cam__view${facing === 'user' ? ' cam__view--mirror' : ''}`} muted playsInline autoPlay aria-hidden />
      {flash ? <span className="cam__flash" aria-hidden /> : null}

      {status !== 'ready' ? (
        <div className="cam__message">
          {status === 'starting' ? (
            <p>Starting the camera…</p>
          ) : status === 'denied' ? (
            <>
              <p>Camera access is off. Allow it in your browser settings, or choose from your gallery.</p>
            </>
          ) : (
            <p>No camera found on this device. Choose a photo or video from your files.</p>
          )}
          {status !== 'starting' ? (
            <button type="button" className="cam__pill" onClick={() => gallery.current?.click()}>
              Choose from gallery
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="cam__top">
        <button type="button" className="cam__icon" aria-label="Close camera" onClick={() => router.back()}>
          <Icon name="x" />
        </button>
        {recording ? (
          <span className="cam__timer" role="timer" aria-live="off">
            <span className="cam__dot" aria-hidden /> {clock(elapsed)} / {clock(maxSeconds)}
          </span>
        ) : (
          <Link href={mode === 'post' ? '/create' : `/create?mode=${mode}`} className="cam__pill cam__pill--ghost" replace>
            Write instead
          </Link>
        )}
        {canFlip && !recording ? (
          <button type="button" className="cam__icon" aria-label="Switch camera" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>
            <Icon name="repost" />
          </button>
        ) : (
          <span className="cam__icon" aria-hidden />
        )}
      </div>

      <div className="cam__bottom">
        <div className="cam__controls">
          <button type="button" className="cam__gallery" aria-label="Choose from gallery" disabled={recording} onClick={() => gallery.current?.click()}>
            <Icon name="image" />
          </button>
          <button
            type="button"
            className={`cam__shutter${recording ? ' cam__shutter--rec' : ''}${mode === 'reel' ? ' cam__shutter--reel' : ''}`}
            aria-label={shutterLabel}
            disabled={status !== 'ready'}
            onPointerDown={onShutterDown}
            onPointerUp={onShutterUp}
            onPointerLeave={() => {
              if (holdTimer.current) clearTimeout(holdTimer.current);
              if (recording && mode !== 'reel') stopRecording();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (mode === 'reel') return recording ? stopRecording() : startRecording();
                if (!recording) takePhoto();
              }
            }}
            style={recording ? ({ '--cam-progress': `${Math.min(1, elapsed / maxSeconds) * 360}deg` } as React.CSSProperties) : undefined}
          >
            <span aria-hidden />
          </button>
          <span className="cam__hint" aria-hidden>
            {mode === 'reel' ? (recording ? 'Tap to stop' : 'Tap to record') : hasAudio ? 'Tap for photo, hold for video' : 'Tap for photo'}
          </span>
        </div>
        <div className="cam__modes" role="tablist" aria-label="What to create">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={m.id === mode} disabled={recording} className="cam__mode" onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <input
        ref={gallery}
        type="file"
        hidden
        accept={mode === 'reel' ? VIDEO_ACCEPT : MEDIA_ACCEPT}
        multiple={mode === 'post'}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = '';
          if (!files.length) return;
          if (mode === 'reel' && !files.every(isVideoFile)) return toast('A reel is a video.');
          finish(files, mode);
        }}
      />
    </div>
  );
}

export default function CameraPage() {
  return (
    <Suspense>
      <Camera />
    </Suspense>
  );
}
