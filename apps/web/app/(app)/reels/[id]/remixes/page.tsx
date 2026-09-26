'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Segments, Skeleton } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { ReelGrid } from '@/components/ReelGrid';
import { useSession } from '../../../../providers';

/** Duets and remixes of one reel, newest first, with the original at the top. */
export default function RemixesPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useSession();
  const [original, setOriginal] = useState<Post | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [mode, setMode] = useState<'all' | 'duet' | 'remix'>('all');

  useEffect(() => {
    setOriginal(null);
    setMissing(null);
    api.posts.get(id).then(
      (r) => setOriginal(r.post),
      (e) => setMissing(errorMessage(e)),
    );
  }, [id]);

  const load = useCallback((cursor?: string) => api.posts.remixes(id, mode === 'all' ? undefined : mode, cursor), [id, mode]);

  if (missing) return <EmptyState title="This reel isn't available" body={missing} />;
  if (!original) return <Skeleton height={200} />;
  const canRemix = !!me && original.allowRemix && original.visibility === 'public';

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>Remixes</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Duets and remixes of <Link href={`/reels?start=${original.id}`}>a reel by {original.author.displayName}</Link>
        {original.counts.remixes ? ` · ${original.counts.remixes} in all` : ''}.
      </p>
      {canRemix ? (
        <div className="row">
          <Link href={`/create?mode=reel&remixOf=${original.id}&remixMode=duet`} className="yp-btn yp-btn--primary yp-btn--sm">
            Duet
          </Link>
          <Link href={`/create?mode=reel&remixOf=${original.id}&remixMode=remix`} className="yp-btn yp-btn--secondary yp-btn--sm">
            Remix with this sound
          </Link>
        </div>
      ) : original.format === 'reel' && !original.allowRemix ? (
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          The creator turned off new duets and remixes for this reel.
        </p>
      ) : null}
      <Segments
        label="Show"
        value={mode}
        onChange={setMode}
        options={[
          { id: 'all', label: 'All' },
          { id: 'duet', label: 'Duets' },
          { id: 'remix', label: 'Remixes' },
        ]}
      />
      <ReelGrid load={load} reloadKey={`${id}:${mode}`} empty="No duets or remixes you can see yet." />
    </div>
  );
}
