'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

/**
 * In-app camera capture. Returns JPEG files taken right now, never picked from
 * the library, which is what lets Real and Real Together vouch for a moment.
 * Where the device has two cameras, it can take front and back in one go.
 */
export function Capture({ dual, onCaptured }: { dual?: boolean; onCaptured: (files: File[]) => void }) {
  const { t } = useSession();
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shots, setShots] = useState<File[]>([]);

  useEffect(() => {
    let s: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: facing, width: { ideal: 1440 } }, audio: false })
      .then((m) => {
        s = m;
        setStream(m);
        if (video.current) video.current.srcObject = m;
      })
      .catch(() => setError(t('camera.captureAllow')));
    return () => s?.getTracks().forEach((t) => t.stop());
  }, [facing]);

  async function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) return;
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const next = [...shots, file];
    if (dual && next.length === 1) {
      setShots(next);
      setFacing((f) => (f === 'user' ? 'environment' : 'user'));
      return;
    }
    setShots([]);
    onCaptured(next);
  }

  if (error) return <Alert tone="warning">{error}</Alert>;
  return (
    <div className="stack-sm">
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        style={{ width: '100%', borderRadius: 8, background: '#0b100e', transform: facing === 'user' ? 'scaleX(-1)' : undefined }}
        aria-label={t('camera.preview')}
      />
      <div className="row">
        <Button icon="image" onClick={snap} disabled={!stream}>
          {t(dual && shots.length === 0 ? 'camera.captureDual' : 'camera.capture')}
        </Button>
        <Button variant="ghost" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>
          {t('m.camera.flip')}
        </Button>
        {dual && shots.length === 1 ? (
          <Button variant="ghost" onClick={() => (onCaptured(shots), setShots([]))}>
            {t('camera.useOne')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
