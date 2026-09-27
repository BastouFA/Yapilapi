'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Icon, useModalFocus } from '@yapilapi/design-system';
import { isVideoFile, MEDIA_ACCEPT, VIDEO_ACCEPT, type DualCorner, type MessageKey } from '@yapilapi/shared';
import { DualReview, type DualShots } from '@/components/DualReview';
import { canvasBlob, composeDual, grabFrame } from '@/lib/dual-photo';
import { deliverPendingMedia, type CreateMode } from '@/lib/pending-media';
import { useSession } from '../../providers';

const MODES: { id: CreateMode; label: MessageKey }[] = [
  { id: 'post', label: 'm.create.mode.post' },
  { id: 'reel', label: 'm.create.mode.reel' },
  { id: 'story', label: 'm.create.mode.story' },
];
/** Press longer than this on the shutter (post, story) records a video instead of taking a photo. */
const HOLD_MS = 350;
const CLIP_MAX_SECONDS = 60;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The camera that Spark (the navigation's centre button) opens. Choose Post, Reel or Story at the bottom, then:
 * - Post and Story: tap the shutter for a photo, hold it to record a video.
 * - Reel: tap to start recording, tap again to stop (up to the reel limit).
 * - Both sides (Post and Story, on devices with two cameras): a back camera photo, then the
 *   front camera right after, put together with the small one in a corner you can drag.
 * Or open the gallery. What you take goes to Create, where the editor opens with it.
 */
function Camera() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, toast, t } = useSession();
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
  // Both sides: the two photos being checked, the corner for the small one, and who waits for the camera to restart.
  const [dual, setDual] = useState(false);
  const [dualShots, setDualShots] = useState<DualShots | null>(null);
  const [dualCorner, setDualCorner] = useState<DualCorner>('top-left');
  const [dualBusy, setDualBusy] = useState(false);
  const readyWaiters = useRef<(() => void)[]>([]);
  // Full screen over the app: focus moves in and stays in, Escape closes it (unless the both-sides review is open).
  const root = useRef<HTMLDivElement>(null);
  const modeTabs = useRef<Record<string, HTMLButtonElement | null>>({});

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
      readyWaiters.current.splice(0).forEach((w) => w());
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

  /** Resolves once the camera has restarted (after switching sides), or after `ms`. */
  const cameraReady = (ms = 5000) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        readyWaiters.current = readyWaiters.current.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      readyWaiters.current.push(done);
    });

  /** Both sides: the back camera photo, then switch to the front camera and take another right away. */
  const takeDual = async () => {
    if (dualBusy) return;
    setDualBusy(true);
    try {
      if (facing !== 'environment') {
        const ready = cameraReady();
        setFacing('environment');
        await ready;
        await sleep(300);
      }
      const back = video.current && grabFrame(video.current);
      if (!back) throw new Error('no back photo');
      setFlash(true);
      setTimeout(() => setFlash(false), 150);
      const ready = cameraReady();
      setFacing('user');
      await ready;
      // Give the front camera a moment to set its exposure.
      await sleep(450);
      const front = video.current && grabFrame(video.current);
      setFacing('environment');
      if (!front) throw new Error('no front photo');
      const [b, f] = await Promise.all([canvasBlob(back, 0.85), canvasBlob(front, 0.85)]);
      setDualShots({ back, front, backUrl: URL.createObjectURL(b), frontUrl: URL.createObjectURL(f) });
    } catch {
      toast(t('m.camera.dualFailed'));
    } finally {
      setDualBusy(false);
    }
  };

  const closeDual = () => {
    if (dualShots) {
      URL.revokeObjectURL(dualShots.backUrl);
      URL.revokeObjectURL(dualShots.frontUrl);
    }
    setDualShots(null);
  };

  const acceptDual = async () => {
    if (!dualShots) return;
    setDualBusy(true);
    try {
      const blob = await composeDual(dualShots.back, dualShots.front, dualCorner);
      closeDual();
      finish([new File([blob], `both-sides-${Date.now()}.jpg`, { type: 'image/jpeg' })], mode);
    } catch {
      toast(t('m.camera.dualComposeFailed'));
    } finally {
      setDualBusy(false);
    }
  };

  const startRecording = () => {
    const s = stream.current;
    if (!s || recording) return;
    if (typeof MediaRecorder === 'undefined') return toast(t('camera.noRecorder'));
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
    if (status !== 'ready' || mode === 'reel' || dual) return;
    pressAt.current = Date.now();
    holdTimer.current = setTimeout(startRecording, HOLD_MS);
  };
  const onShutterUp = () => {
    if (status !== 'ready') return;
    if (mode === 'reel') return recording ? stopRecording() : startRecording();
    if (dual) return void takeDual();
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (recording) stopRecording();
    else if (Date.now() - pressAt.current < HOLD_MS + 50) takePhoto();
  };

  useModalFocus(root, !dualShots, () => {
    if (recording) stopRecording();
    else router.back();
  });

  /** Choose a mode with the keyboard; `focus` moves focus to its tab (when the tabs have it). */
  const pickMode = (to: number, focus: boolean) => {
    if (recording || dualBusy) return;
    const next = MODES[(to + MODES.length) % MODES.length]!;
    setMode(next.id);
    if (focus) modeTabs.current[next.id]?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    // Keyboard: Enter or Space acts like a tap (photo, or start/stop a reel); R starts and stops a video.
    if (dualShots) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if ((e.key === 'r' || e.key === 'R') && !dual && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      return recording ? stopRecording() : startRecording();
    }
    // Left and right switch the mode from anywhere on the camera, like swiping.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
      // The modes read right to left in right-to-left languages, so the arrows follow what is on screen.
      const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
      const i = MODES.findIndex((m) => m.id === mode) + ((e.key === 'ArrowRight') !== rtl ? 1 : -1);
      // On the tabs, arrows wrap around; elsewhere they stop at the ends.
      const onTabs = !!(e.target as HTMLElement).closest?.('[role="tablist"]');
      if (MODES[i] || onTabs) {
        e.preventDefault();
        pickMode(i, onTabs);
      }
    }
  };

  // Tabs pattern: one tab stop; arrows (above), Home and End move and select.
  const onTabsKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      pickMode(e.key === 'Home' ? 0 : MODES.length - 1, true);
    }
  };

  const bothSides = dual && mode !== 'reel';
  const shutterLabel = t(
    recording ? 'm.camera.stopRecording' : mode === 'reel' ? 'm.camera.startRecording' : bothSides ? 'm.camera.dualShutter' : 'camera.shutterPhoto',
  );

  return (
    <div ref={root} tabIndex={-1} className="cam" role="dialog" aria-modal="true" aria-label={t('m.camera.title')} onKeyDown={onKey}>
      <video ref={video} className={`cam__view${facing === 'user' ? ' cam__view--mirror' : ''}`} muted playsInline autoPlay aria-hidden />
      {flash ? <span className="cam__flash" aria-hidden /> : null}

      {status !== 'ready' ? (
        <div className="cam__message">
          {status === 'starting' ? (
            <p>{t('camera.starting')}</p>
          ) : status === 'denied' ? (
            <>
              <p>{t('camera.denied')}</p>
            </>
          ) : (
            <p>{t('camera.none')}</p>
          )}
          {status !== 'starting' ? (
            <button type="button" className="cam__pill" onClick={() => gallery.current?.click()}>
              {t('camera.gallery')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="cam__top">
        <button type="button" className="cam__icon" aria-label={t('m.camera.close')} onClick={() => router.back()}>
          <Icon name="x" />
        </button>
        {recording ? (
          <span className="cam__timer" role="timer" aria-live="off">
            <span className="cam__dot" aria-hidden /> {clock(elapsed)} / {clock(maxSeconds)}
          </span>
        ) : (
          <Link href={mode === 'post' ? '/create' : `/create?mode=${mode}`} className="cam__pill cam__pill--ghost" replace>
            {t(mode === 'story' ? 'm.camera.storyStickers' : 'camera.writeInstead')}
          </Link>
        )}
        {canFlip && !recording && !bothSides ? (
          <button type="button" className="cam__icon" aria-label={t('m.camera.flip')} onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>
            <Icon name="repost" />
          </button>
        ) : (
          <span className="cam__icon" aria-hidden />
        )}
      </div>

      <div className="cam__bottom">
        {/* Both sides needs a second camera, and makes photos only. */}
        {canFlip && mode !== 'reel' && !recording && status === 'ready' ? (
          <button
            type="button"
            className="cam__pill cam__pill--ghost"
            aria-pressed={dual}
            disabled={dualBusy}
            onClick={() => {
              setDual((d) => !d);
              if (!dual && facing !== 'environment') setFacing('environment');
            }}
          >
            {t('m.camera.dual')}
          </button>
        ) : null}
        <div className="cam__controls">
          <button type="button" className="cam__gallery" aria-label={t('camera.gallery')} disabled={recording} onClick={() => gallery.current?.click()}>
            <Icon name="image" />
          </button>
          <button
            type="button"
            className={`cam__shutter${recording ? ' cam__shutter--rec' : ''}${mode === 'reel' ? ' cam__shutter--reel' : ''}`}
            aria-label={shutterLabel}
            disabled={status !== 'ready' || dualBusy}
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
                if (bothSides) return void takeDual();
                if (!recording) takePhoto();
              }
            }}
            style={recording ? ({ '--cam-progress': `${Math.min(1, elapsed / maxSeconds) * 360}deg` } as React.CSSProperties) : undefined}
          >
            <span aria-hidden />
          </button>
          <span className="cam__hint" aria-hidden>
            {t(
              mode === 'reel'
                ? recording
                  ? 'camera.tapToStop'
                  : 'camera.tapToRecord'
                : bothSides
                  ? dualBusy
                    ? 'm.camera.dualTaking'
                    : 'm.camera.dualHint'
                  : hasAudio
                    ? 'camera.tapOrHold'
                    : 'camera.tapPhoto',
            )}
          </span>
        </div>
        <div className="cam__modes" role="tablist" aria-label={t('m.create.mode')} onKeyDown={onTabsKey}>
          {MODES.map((m) => (
            <button
              key={m.id}
              ref={(el) => {
                modeTabs.current[m.id] = el;
              }}
              type="button"
              role="tab"
              aria-selected={m.id === mode}
              tabIndex={m.id === mode ? 0 : -1}
              disabled={recording || dualBusy}
              className="cam__mode"
              onClick={() => setMode(m.id)}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
      </div>

      {dualShots ? (
        <DualReview shots={dualShots} corner={dualCorner} onCorner={setDualCorner} onRetake={closeDual} onUse={() => void acceptDual()} busy={dualBusy} />
      ) : null}

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
          if (mode === 'reel' && !files.every(isVideoFile)) return toast(t('compose.reelIsVideo'));
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
