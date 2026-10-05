'use client';

import { useEffect, useRef, useState } from 'react';
import { CaptionTracks, videoCrossOrigin } from '@yapilapi/design-system';
import type { CaptionTrackRef } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/**
 * Plays an HLS stream: natively on Safari/iOS, through hls.js elsewhere. Retries while a live stream starts.
 * Caption tracks (WebVTT) render as subtitles in the player's captions menu.
 */
export function HlsVideo({
  src,
  poster,
  live,
  label,
  captions,
}: {
  src: string;
  poster?: string;
  live?: boolean;
  label: string;
  captions?: CaptionTrackRef[];
}) {
  const { t } = useSession();
  const ref = useRef<HTMLVideoElement>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let hls: import('hls.js').default | null = null;
    let cancelled = false;
    // hls.js wherever the browser can feed it (Media Source); the browser's own player only where it
    // can't (iPhone). Recent Chrome says it plays HLS itself but can't parse low-latency live streams.
    const native = () => {
      if (!cancelled && video.canPlayType('application/vnd.apple.mpegurl')) video.src = src;
    };
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) return native();
      hls = new Hls({ lowLatencyMode: !!live, manifestLoadingMaxRetry: live ? 30 : 3, manifestLoadingRetryDelay: 2000 });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) setWaiting(true);
        if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls?.startLoad(), 2000);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => setWaiting(false));
      hls.loadSource(src);
      hls.attachMedia(video);
    }, native);
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [src, live]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <video
        ref={ref}
        poster={poster}
        crossOrigin={videoCrossOrigin(captions)}
        controls
        autoPlay
        playsInline
        muted={live}
        style={{ width: '100%', height: '100%' }}
        aria-label={label}
      >
        <CaptionTracks captions={captions} />
      </video>
      {waiting ? (
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#c7d2cd', pointerEvents: 'none' }}>
          {t('video.waitingForStream')}
        </span>
      ) : null}
    </div>
  );
}
