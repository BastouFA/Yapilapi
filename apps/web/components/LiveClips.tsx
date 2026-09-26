'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card } from '@yapilapi/design-system';
import { api } from '@/lib/api';

type Data = Awaited<ReturnType<typeof api.live.clips>>;
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/** For the host after a live: the saved recording and highlight clips cut from the busiest moments of chat. */
export function LiveClips({ liveId }: { liveId: string }) {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api.live.clips(liveId).then(
        (d) => {
          if (stop) return;
          setData(d);
          const busy = d.recording.status === 'pending' || d.clips.some((c) => c.status !== 'ready' && c.status !== 'failed');
          if (busy) setTimeout(load, 5000);
        },
        () => {},
      );
    void load();
    return () => {
      stop = true;
    };
  }, [liveId]);
  if (!data?.enabled) return null;
  const { recording, clips } = data;
  return (
    <Card title="Recording and highlights" subtitle="Highlights are the moments your chat was busiest. Only you can see these until you post them.">
      {recording.status === 'pending' ? (
        <p className="muted">Saving the recording. This takes a minute or two.</p>
      ) : recording.status === 'none' || recording.status === null ? (
        <p className="muted">No recording was made for this live.</p>
      ) : recording.status === 'failed' ? (
        <p className="yp-field__error">The recording couldn&apos;t be saved.</p>
      ) : (
        <div className="stack-sm">
          {clips.length ? (
            <div className="live-shop">
              {clips.map((c) => (
                <figure key={c.id} className="live-clip">
                  {c.media && c.status === 'ready' ? (
                    <video src={c.media.url} poster={c.media.posterUrl ?? undefined} controls preload="none" />
                  ) : (
                    <div className="live-clip__wait">{c.status === 'failed' ? "Couldn't make this clip" : 'Making clip…'}</div>
                  )}
                  <figcaption>
                    {mmss(c.startMs)} to {mmss(c.endMs)}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Chat was too quiet for highlights this time.
            </p>
          )}
          <Link href="/studio" className="yp-btn yp-btn--secondary yp-btn--sm" style={{ width: 'fit-content' }}>
            Edit or add captions in Studio
          </Link>
        </div>
      )}
    </Card>
  );
}
