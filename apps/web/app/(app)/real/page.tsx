'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, PostCard, Select, TextField } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { Capture } from '@/components/Capture';
import { useSession } from '../../providers';

/** Real: capture what's in front of you now, both cameras if you like. No filters, no library. */
export default function RealPage() {
  const { flags, toast, locale } = useSession();
  const [items, setItems] = useState<Post[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState('friends');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api.real.feed().then(
        (r) => setItems(r.items),
        () => {},
      ),
    [],
  );
  useEffect(() => {
    if (flags.REAL) void load();
  }, [flags.REAL, load]);

  if (!flags.REAL) return <EmptyState title="Real isn't available yet" body="It's being rolled out gradually." />;

  async function share(files: File[]) {
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const f of files) ids.push((await api.media.upload(f)).media.id);
      await api.real.create({ mediaIds: ids, caption, visibility });
      setCapturing(false);
      setCaption('');
      toast('Real shared');
      await load();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Real</h1>
        {!capturing ? <Button onClick={() => setCapturing(true)}>Capture a Real</Button> : null}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Photos taken here and now, marked with the time they were captured. Up to three a day.
      </p>
      {capturing ? (
        <div className="stack-sm yp-card" style={{ padding: 16 }}>
          <TextField label="Caption (optional)" value={caption} onChange={(e) => setCaption(e.currentTarget.value)} maxLength={300} />
          <Select label="Who can see it" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value)}>
            <option value="friends">Friends</option>
            <option value="followers">Followers</option>
            <option value="public">Everyone</option>
          </Select>
          {busy ? <p>Sharing…</p> : <Capture dual onCaptured={share} />}
          <Button variant="ghost" onClick={() => setCapturing(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {items.length ? (
        items.map((p) => <PostCard key={p.id} post={p} locale={locale} linkAs={NextLink} />)
      ) : (
        <EmptyState title="No Reals in the last day" body="When friends share a Real, it shows up here for 24 hours." />
      )}
    </div>
  );
}
