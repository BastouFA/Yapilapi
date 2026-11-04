'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, useModalFocus } from '@yapilapi/design-system';
import { isVideoFile, MEDIA_ACCEPT } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

// A chat takes files up to 50 MB: a minute at this rate stays well under it.
const VIDEO_MAX_SECONDS = 60;
const VIDEO_BITS_PER_SECOND = 4_000_000;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * The camera in a chat: take a photo or a video, look at it, send it or take another. It stays open
 * until it has gone, so a failed send doesn't lose it. The microphone is asked for only on Video, so
 * a photo never stops your music. Where the browser can't reach the camera, the gallery button still
 * gets a photo or video in (an iPhone offers its own camera there too).
 */
export function ChatCamera({ onClose, onSend }: { onClose: () => void; onSend: (file: File) => Promise<boolean> }) {
  const { t, toast } = useSession();
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [status, setStatus] = useState<'starting' | 'ready' | 'denied' | 'none'>('starting');
  const [canFlip, setCanFlip] = useState(false);
  const [flash, setFlash] = useState(false);
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  // Goes up when the phone took the camera away while the app was in the background.
  const [restart, setRestart] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const gallery = useRef<HTMLInputElement>(null);
  const send = useRef<HTMLButtonElement>(null);
  const open = useRef(true);
  const reviewing = !!shot;
  const sendingLabel = t(shot && isVideoFile(shot.file) ? 'chat.sendingVideo' : 'chat.sendingPhoto');

  // Escape while recording stops it, and what was recorded is there to look at.
  useModalFocus(root, true, () => (recording ? stopRecording() : onClose()));

  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  // The camera runs only while there's nothing to look at, and lets go of the old side before asking for the new one.
  useEffect(() => {
    if (reviewing) return;
    let cancelled = false;
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setStatus('none');
      setStatus('starting');
      const picture = { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } };
      try {
        // No microphone still makes a video, a silent one.
        const s =
          (mode === 'video' ? await navigator.mediaDevices.getUserMedia({ video: picture, audio: true }).catch(() => null) : null) ??
          (await navigator.mediaDevices.getUserMedia({ video: picture, audio: false }));
        if (cancelled) return s.getTracks().forEach((tr) => tr.stop());
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        if (cancelled) return;
        setStatus('ready');
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!cancelled) setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
      } catch (e) {
        if (cancelled) return;
        const name = (e as DOMException).name;
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'none');
      }
    };
    void start();
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((tr) => tr.stop());
      stream.current = null;
    };
  }, [facing, mode, reviewing, restart]);

  // Closed in the middle of a recording: it goes nowhere.
  useEffect(
    () => () => {
      const r = recorder.current;
      if (r?.state !== 'recording') return;
      r.onstop = null;
      r.stop();
    },
    [],
  );

  // Recording timer, stopping at the limit.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setElapsed(s);
      if (s >= VIDEO_MAX_SECONDS) stopRecording();
    }, 200);
    return () => clearInterval(timer);
  }, [recording]);

  // Back from another app: an iPhone may have stopped the camera, which would leave a frozen picture.
  useEffect(() => {
    if (reviewing || recording) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const track = stream.current?.getVideoTracks()[0];
      if (track && (track.readyState !== 'live' || track.muted)) setRestart((n) => n + 1);
      else void video.current?.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reviewing, recording]);

  useEffect(() => {
    if (!shot) return;
    send.current?.focus({ preventScroll: true });
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  const look = (file: File) => setShot({ file, url: URL.createObjectURL(file) });

  const takePhoto = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    // The front camera preview is shown mirrored; the photo is as others will see you.
    c.getContext('2d')!.drawImage(v, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 150);
    c.toBlob((b) => b && look(new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.92);
  };

  const startRecording = () => {
    const s = stream.current;
    if (!s || recording) return;
    if (typeof MediaRecorder === 'undefined') return toast(t('camera.noRecorder'));
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((x) => MediaRecorder.isTypeSupported(x));
    const r = new MediaRecorder(s, { videoBitsPerSecond: VIDEO_BITS_PER_SECOND, ...(type ? { mimeType: type } : {}) });
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      const mime = (r.mimeType || 'video/webm').split(';')[0]!;
      const blob = new Blob(chunks.current, { type: mime });
      setRecording(false);
      if (blob.size >= 1000) look(new File([blob], `video-${Date.now()}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`, { type: mime }));
    };
    recorder.current = r;
    r.start(250);
    setElapsed(0);
    setRecording(true);
  };

  function stopRecording() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
  }

  const sendShot = async () => {
    if (!shot || sending) return;
    setSending(true);
    const sent = await onSend(shot.file);
    if (!open.current) return;
    if (sent) onClose();
    else setSending(false);
  };

  return createPortal(
    <div ref={root} tabIndex={-1} className="cam" role="dialog" aria-modal="true" aria-label={t('m.camera.title')}>
      {shot ? (
        isVideoFile(shot.file) ? (
          // Its own element: the live one still holds the camera's stream, which would win over this file.
          <video key="recorded" src={shot.url} className="cam__view cam__view--whole" controls playsInline />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a photo on this device, not yet uploaded
          <img src={shot.url} alt="" className="cam__view cam__view--whole" />
        )
      ) : (
        <video
          key="live"
          ref={video}
          className={`cam__view cam__view--whole${facing === 'user' ? ' cam__view--mirror' : ''}`}
          muted
          playsInline
          autoPlay
          aria-hidden
        />
      )}
      {flash ? <span className="cam__flash" aria-hidden /> : null}

      {!shot && status !== 'ready' ? (
        <div className="cam__message">
          <p>{t(status === 'starting' ? 'camera.starting' : status === 'denied' ? 'camera.denied' : 'camera.none')}</p>
          {status !== 'starting' ? (
            <button type="button" className="cam__pill" onClick={() => gallery.current?.click()}>
              {t('camera.gallery')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="cam__top">
        <button type="button" className="cam__icon" aria-label={t('m.camera.close')} onClick={onClose}>
          <Icon name="x" />
        </button>
        {recording ? (
          <span className="cam__timer" role="timer" aria-live="off">
            <span className="cam__dot" aria-hidden /> {clock(elapsed)} / {clock(VIDEO_MAX_SECONDS)}
          </span>
        ) : null}
        {!shot && canFlip && !recording ? (
          <button type="button" className="cam__icon" aria-label={t('m.camera.flip')} onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>
            <Icon name="repost" />
          </button>
        ) : (
          <span className="cam__icon" aria-hidden style={{ visibility: 'hidden' }} />
        )}
      </div>

      <div className="cam__bottom">
        {shot ? (
          <div className="cam__review">
            <button type="button" className="cam__pill cam__pill--ghost" disabled={sending} onClick={() => setShot(null)}>
              {t('m.camera.dualRetake')}
            </button>
            <button ref={send} type="button" className="cam__pill" disabled={sending} onClick={() => void sendShot()}>
              <Icon name="send" size={18} />
              {sending ? sendingLabel : t('inbox.send')}
            </button>
          </div>
        ) : (
          <>
            <div className="cam__controls">
              <button type="button" className="cam__gallery" aria-label={t('camera.gallery')} disabled={recording} onClick={() => gallery.current?.click()}>
                <Icon name="image" />
              </button>
              <button
                type="button"
                className={`cam__shutter${mode === 'video' ? ' cam__shutter--reel' : ''}${recording ? ' cam__shutter--rec' : ''}`}
                aria-label={t(mode === 'photo' ? 'm.camera.takePhoto' : recording ? 'm.camera.stopRecording' : 'm.camera.startRecording')}
                disabled={status !== 'ready'}
                onClick={() => (mode === 'photo' ? takePhoto() : recording ? stopRecording() : startRecording())}
                style={recording ? ({ '--cam-progress': `${Math.min(1, elapsed / VIDEO_MAX_SECONDS) * 360}deg` } as React.CSSProperties) : undefined}
              >
                <span aria-hidden />
              </button>
            </div>
            {recording ? null : (
              <div className="cam__modes" role="group" aria-label={t('viewOnce.capture.kind')}>
                {(['photo', 'video'] as const).map((m) => (
                  <button key={m} type="button" className="cam__mode" aria-pressed={mode === m} onClick={() => setMode(m)}>
                    {t(m === 'photo' ? 'viewOnce.capture.photo' : 'viewOnce.capture.video')}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <span role="status" className="yp-visually-hidden">
        {sending ? sendingLabel : ''}
      </span>
      <input
        ref={gallery}
        type="file"
        accept={MEDIA_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) look(f);
        }}
      />
    </div>,
    document.body,
  );
}
