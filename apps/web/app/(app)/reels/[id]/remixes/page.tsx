'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Segments, Skeleton } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { ReelGrid } from '@/components/ReelGrid';
import { useSession } from '../../../../providers';

/** Duets and remixes of one reel, newest first, with the original at the top. */
export default function RemixesPage() {
  const { id } = useParams<{ id: string }>();
  const { me, t, tp } = useSession();
  const [original, setOriginal] = useState<Post | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'all' | 'duet' | 'remix'>('all');

  const loadOriginal = useCallback(() => {
    setMissing(null);
    setLoadError(null);
    api.posts.get(id).then(
      (r) => setOriginal(r.post),
      (e) => (isGone(e) ? setMissing(errorMessage(e)) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    setOriginal(null);
    loadOriginal();
  }, [loadOriginal]);

  const load = useCallback((cursor?: string) => api.posts.remixes(id, mode === 'all' ? undefined : mode, cursor), [id, mode]);

  if (missing) return <EmptyState level={1} title={t('remixes.unavailable')} body={missing} />;
  if (!original && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={loadOriginal}>{t('m.common.retry')}</Button>} />;
  if (!original) return <Skeleton height={200} />;
  const canRemix = !!me && original.allowRemix && original.visibility === 'public';
  const [introBefore = '', introAfter = ''] = (original.counts.remixes ? tp('remixes.introCount', original.counts.remixes) : t('remixes.intro')).split(
    '{link}',
  );

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>{t('remixes.title')}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {introBefore}
        <Link href={`/reels?start=${original.id}`}>{t('remixes.reelBy', { name: original.author.displayName })}</Link>
        {introAfter}
      </p>
      {canRemix ? (
        <div className="row">
          <Link href={`/create?mode=reel&remixOf=${original.id}&remixMode=duet`} className="yp-btn yp-btn--primary yp-btn--sm">
            {t('remixes.duet')}
          </Link>
          <Link href={`/create?mode=reel&remixOf=${original.id}&remixMode=remix`} className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('reel.share.remix')}
          </Link>
        </div>
      ) : original.format === 'reel' && !original.allowRemix ? (
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('remixes.off')}
        </p>
      ) : null}
      <Segments
        label={t('m.wander.show')}
        value={mode}
        onChange={setMode}
        options={[
          { id: 'all', label: t('m.wander.all') },
          { id: 'duet', label: t('remixes.duets') },
          { id: 'remix', label: t('remixes.title') },
        ]}
      />
      <ReelGrid load={load} reloadKey={`${id}:${mode}`} empty={t('remixes.empty')} />
    </div>
  );
}
