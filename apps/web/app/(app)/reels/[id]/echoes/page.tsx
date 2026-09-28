'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Skeleton } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { ReelGrid } from '@/components/ReelGrid';
import { useSession } from '../../../../providers';

/** Echoes of one reel that you can see, newest first, with the original at the top. */
export default function EchoesPage() {
  const { id } = useParams<{ id: string }>();
  const { t, tp, locale } = useSession();
  const [original, setOriginal] = useState<Post | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const load = useCallback((cursor?: string) => api.posts.echoes(id, cursor), [id]);

  if (missing) return <EmptyState title={t('echo.block.unavailable')} body={missing} />;
  if (!original && loadError) return <EmptyState title={loadError} action={<Button onClick={loadOriginal}>{t('m.common.retry')}</Button>} />;
  if (!original) return <Skeleton height={200} />;
  const count = original.counts.echoes ?? 0;

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>{t('echo.list.title')}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        <Link href={`/reels?start=${original.id}`}>{t('echo.list.intro', { name: original.author.displayName })}</Link>
        {count ? ` · ${tp('echo.count', count, { count: new Intl.NumberFormat(locale).format(count) })}` : ''}
      </p>
      {original.viewer.canEcho ? (
        <div className="row">
          <Link href={`/reels/${original.id}/echo`} className="yp-btn yp-btn--primary yp-btn--sm">
            {t('echo.action')}
          </Link>
        </div>
      ) : null}
      <ReelGrid load={load} reloadKey={id} empty={t('echo.list.empty')} />
    </div>
  );
}
