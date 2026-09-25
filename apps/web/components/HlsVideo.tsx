'use client';

import { useEffect, useRef, useState } from 'react';

/** Plays an HLS stream: natively on Safari/iOS, through hls.js elsewhere. Retries while a live stream starts. */
export function HlsVideo({ src, poster, live, label }: { src: string; poster?: string; live?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }
    let hls: import('hls.js').default | null = null;
    let cancelled = false;
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled || !Hls.isSupported()) return;
      hls = new Hls({ lowLatencyMode: !!live, manifestLoadingMaxRetry: live ? 30 : 3, manifestLoadingRetryDelay: 2000 });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) setWaiting(true);
        if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls?.startLoad(), 2000);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => setWaiting(false));
      hls.loadSource(src);
      hls.attachMedia(video);
    });
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [src, live]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <video ref={ref} poster={poster} controls autoPlay playsInline muted={live} style={{ width: '100%', height: '100%' }} aria-label={label} />
      {waiting ? (
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#c7d2cd', pointerEvents: 'none' }}>
          Waiting for the stream to start…
        </span>
      ) : null}
    </div>
  );
}
