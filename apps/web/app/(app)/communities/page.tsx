'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, CommunityCard, EmptyState, Segments, Skeleton } from '@yapilapi/design-system';
import type { Community } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

type Scope = 'mine' | 'discover';

/** Communities: the ones you're in, and ones to discover. */
export default function CommunitiesPage() {
  const { t, locale } = useSession();
  const [scope, setScope] = useState<Scope>('mine');
  const [items, setItems] = useState<Community[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    api.communities.list(scope).then(
      (r) => live && setItems(r.items),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [scope, attempt]);
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('communities.title')}</h1>
        <Link href="/communities/new" className="yp-btn yp-btn--primary yp-btn--sm">
          {t('communities.create')}
        </Link>
      </div>
      <Segments
        label={t('communities.title')}
        value={scope}
        onChange={setScope}
        options={[
          { id: 'mine', label: t('m.communities.mine') },
          { id: 'discover', label: t('m.communities.discover') },
        ]}
      />
      {error ? (
        <EmptyState title={error} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('m.common.retry')}</Button>} />
      ) : items === null ? (
        <Skeleton height={160} />
      ) : items.length ? (
        <>
          {/* The cards' names are level-3 headings under this one. */}
          <h2 className="yp-visually-hidden">{scope === 'mine' ? t('m.communities.mine') : t('m.communities.discover')}</h2>
          <div className="yp-grid">
            {items.map((c) => (
              <CommunityCard key={c.id} community={c} href={`/c/${c.slug}`} linkAs={NextLink} locale={locale} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState title={scope === 'mine' ? t('m.communities.emptyMine') : t('m.communities.emptyDiscover')} />
      )}
    </div>
  );
}
