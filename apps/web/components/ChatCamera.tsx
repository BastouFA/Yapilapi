'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, useModalFocus } from '@yapilapi/design-system';
import { isVideoFile, MEDIA_ACCEPT } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/**
 * The camera in a chat: take a photo, look at it, send it or take another. It stays open until the
 * photo has gone, so a failed send doesn't lose it. Where the browser can't reach the camera, the
 * gallery button still gets a photo or video in (an iPhone offers its own camera there too).
 */
export function ChatCamera({ onClose, onSend }: { onClose: () => void; onSend: (file: File) => Promise<boolean> }) {
  const { t } = useSession();
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
  const gallery = useRef<HTMLInputElement>(null);
  const send = useRef<HTMLButtonElement>(null);
  const open = useRef(true);
  const reviewing = !!shot;
  const sendingLabel = t(shot && isVideoFile(shot.file) ? 'chat.sendingVideo' : 'chat.sendingPhoto');

  useModalFocus(root, true, onClose);

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
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
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
  }, [facing, reviewing, restart]);

  // Back from another app: an iPhone may have stopped the camera, which would leave a frozen picture.
  useEffect(() => {
    if (reviewing) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const track = stream.current?.getVideoTracks()[0];
      if (track && (track.readyState !== 'live' || track.muted)) setRestart((n) => n + 1);
      else void video.current?.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reviewing]);

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
          <video src={shot.url} className="cam__view cam__view--whole" controls playsInline />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a photo on this device, not yet uploaded
          <img src={shot.url} alt="" className="cam__view cam__view--whole" />
        )
      ) : (
        <video ref={video} className={`cam__view cam__view--whole${facing === 'user' ? ' cam__view--mirror' : ''}`} muted playsInline autoPlay aria-hidden />
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
        {!shot && canFlip ? (
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
          <div className="cam__controls">
            <button type="button" className="cam__gallery" aria-label={t('camera.gallery')} onClick={() => gallery.current?.click()}>
              <Icon name="image" />
            </button>
            <button type="button" className="cam__shutter" aria-label={t('m.camera.takePhoto')} disabled={status !== 'ready'} onClick={takePhoto}>
              <span aria-hidden />
            </button>
          </div>
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
