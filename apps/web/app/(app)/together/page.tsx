'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import type { TogetherSummary } from '@yapilapi/shared';
import { FeatureOff } from '@/components/FeatureOff';
import { AlbumCard } from '@/components/Together';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '../../providers';

/** Together: the shared albums you're in, open ones first. Behind the REAL_TOGETHER flag. */
export default function TogetherList() {
  const { flags, me, t, toast } = useSession();
  const [items, setItems] = useState<TogetherSummary[] | null>(null);

  const load = () =>
    api.together.list().then(
      (r) => setItems(r.items),
      (e) => {
        setItems((cur) => cur ?? []);
        toast(errorMessage(e));
      },
    );
  useEffect(() => {
    if (flags.REAL_TOGETHER && me) void load();
  }, [flags.REAL_TOGETHER, me]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime((e) => {
    if (e.type === 'together.items' || e.type === 'together.updated' || e.type === 'together.requests') void load();
  });

  if (!flags.REAL_TOGETHER) return <FeatureOff name="Together" />;
  const open = items?.filter((a) => a.status === 'open') ?? [];
  const closed = items?.filter((a) => a.status === 'closed') ?? [];

  return (
    <div className="yp-shell__inner tg-page">
      <div className="yp-topbar">
        <h1>{t('together.title')}</h1>
        <Link href="/together/new" className="yp-btn yp-btn--primary yp-btn--sm">
          <Icon name="plus" /> {t('together.new')}
        </Link>
      </div>
      <p className="tg-intro">{t('together.intro')}</p>
      {items === null ? (
        <div className="stack-sm">
          <Skeleton height={88} />
          <Skeleton height={88} />
        </div>
      ) : items.length ? (
        <>
          {open.length ? (
            <section className="tg-list" aria-labelledby="tg-open">
              <h2 id="tg-open" className="tg-list__title">
                {t('together.list.open')}
              </h2>
              {open.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </section>
          ) : null}
          {closed.length ? (
            <section className="tg-list" aria-labelledby="tg-closed">
              <h2 id="tg-closed" className="tg-list__title">
                {t('together.list.closed')}
              </h2>
              {closed.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </section>
          ) : null}
        </>
      ) : (
        <EmptyState
          title={t('together.empty')}
          body={t('together.emptyBody')}
          action={
            <Link href="/together/new" className="yp-btn yp-btn--primary">
              {t('together.new')}
            </Link>
          }
        />
      )}
    </div>
  );
}
