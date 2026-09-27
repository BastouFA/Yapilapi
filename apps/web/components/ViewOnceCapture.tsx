'use client';

import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, Icon, Segments } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

type Mode = 'photo' | 'video' | 'voice';
const VIDEO_MAX_SECONDS = 60;
const VOICE_MAX_SECONDS = 120;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Take something to send to view once, straight from the camera or the microphone: a photo, a
 * video (up to a minute) or a voice note (up to two minutes). What you take goes to `onCaptured`;
 * nothing is kept on the device. Choosing an existing file stays on the chat's eye menu.
 */
export function ViewOnceCapture({
  open,
  onClose,
  onCaptured,
  initialMode = 'photo',
}: {
  open: boolean;
  onClose: () => void;
  onCaptured: (file: File) => void;
  initialMode?: Mode;
}) {
  const { t, toast } = useSession();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [status, setStatus] = useState<'starting' | 'ready' | 'denied' | 'none'>('starting');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  // Camera for photos and videos (with the microphone for videos), the microphone alone for voice.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setStatus('none');
      setStatus('starting');
      try {
        const s = await navigator.mediaDevices.getUserMedia(
          mode === 'voice' ? { audio: true } : { video: { facingMode: facing, width: { ideal: 1280 } }, audio: mode === 'video' },
        );
        if (cancelled) return s.getTracks().forEach((tr) => tr.stop());
        stream.current = s;
        if (video.current && mode !== 'voice') {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        const name = (e as DOMException).name;
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'none');
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((tr) => tr.stop());
      stream.current = null;
      setRecording(false);
    };
  }, [open, mode, facing]);

  // Recording timer, stopping at the limit.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const max = mode === 'voice' ? VOICE_MAX_SECONDS : VIDEO_MAX_SECONDS;
    const timer = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setElapsed(s);
      if (s >= max) stop();
    }, 200);
    return () => clearInterval(timer);
  }, [recording, mode]);

  const finish = (file: File) => {
    onCaptured(file);
    onClose();
  };

  const takePhoto = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => b && finish(new File([b], `view-once-${Date.now()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9);
  };

  const startRecording = () => {
    const s = stream.current;
    if (!s || recording) return;
    if (typeof MediaRecorder === 'undefined') return toast(t('viewOnce.capture.noRecorder'));
    const types =
      mode === 'voice'
        ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
        : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const type = types.find((x) => MediaRecorder.isTypeSupported(x));
    const r = new MediaRecorder(s, type ? { mimeType: type } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      const mime = (r.mimeType || (mode === 'voice' ? 'audio/webm' : 'video/webm')).split(';')[0]!;
      const blob = new Blob(chunks.current, { type: mime });
      setRecording(false);
      if (blob.size < 1000) return;
      const ext = mime.includes('mp4') ? (mode === 'voice' ? 'm4a' : 'mp4') : mime.includes('ogg') ? 'ogg' : mode === 'voice' ? 'weba' : 'webm';
      finish(new File([blob], `view-once-${Date.now()}.${ext}`, { type: mime }));
    };
    recorder.current = r;
    r.start(250);
    setElapsed(0);
    setRecording(true);
  };

  function stop() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
  }

  const shutterLabel =
    mode === 'photo'
      ? t('viewOnce.capture.takePhoto')
      : recording
        ? t('viewOnce.capture.stop')
        : mode === 'video'
          ? t('viewOnce.capture.record')
          : t('viewOnce.capture.recordVoice');

  return (
    <BottomSheet open={open} onClose={onClose} title={t('viewOnce.capture.title')}>
      <div className="stack vo-capture">
        <p className="muted" style={{ margin: 0 }}>
          {t('viewOnce.capture.hint')}
        </p>
        <Segments
          label={t('viewOnce.capture.kind')}
          value={mode}
          onChange={(m) => !recording && setMode(m)}
          options={[
            { id: 'photo', label: t('viewOnce.capture.photo') },
            { id: 'video', label: t('viewOnce.capture.video') },
            { id: 'voice', label: t('viewOnce.capture.voice') },
          ]}
        />
        {mode === 'voice' ? (
          <div className="vo-capture__voice" aria-live="polite">
            <Icon name="mic" size={40} />
            <span>{recording ? clock(elapsed) : status === 'ready' ? t('viewOnce.capture.voiceReady') : ''}</span>
          </div>
        ) : (
          <div className="vo-capture__view">
            <video ref={video} muted playsInline autoPlay aria-hidden className={facing === 'user' ? 'vo-capture__mirror' : undefined} />
            {recording ? (
              <span className="vo-capture__timer" role="timer">
                {clock(elapsed)} / {clock(VIDEO_MAX_SECONDS)}
              </span>
            ) : null}
          </div>
        )}
        {status === 'denied' ? (
          <p role="alert" className="muted">
            {mode === 'voice' ? t('viewOnce.capture.micDenied') : t('viewOnce.capture.cameraDenied')}
          </p>
        ) : status === 'none' ? (
          <p role="alert" className="muted">
            {mode === 'voice' ? t('viewOnce.capture.noMic') : t('viewOnce.capture.noCamera')}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {mode !== 'voice' ? (
            <Button
              variant="ghost"
              icon="repost"
              disabled={recording || status !== 'ready'}
              onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
            >
              {t('viewOnce.capture.flip')}
            </Button>
          ) : (
            <span />
          )}
          <Button
            icon={mode === 'photo' ? 'eye' : recording ? 'check' : 'mic'}
            disabled={status !== 'ready'}
            onClick={() => (mode === 'photo' ? takePhoto() : recording ? stop() : startRecording())}
          >
            {shutterLabel}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
