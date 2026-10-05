'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Segments, Skeleton } from '@yapilapi/design-system';
import { dropPhase, type Drop, type DropActivity, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { DropCard, useNow } from '@/components/Drops';
import { useSession } from '../../providers';

type Tab = 'waiting' | 'bought' | 'mine';

const PURCHASE: Record<DropActivity['purchases'][number]['status'], MessageKey> = {
  held: 'm.drops.purchase.held',
  paid: 'm.drops.purchase.paid',
  released: 'm.drops.purchase.released',
};

/**
 * "Your drops": drops you asked to hear about, what you bought in drops, and (for sellers) your
 * own launches with their drafts. Creating a drop starts here.
 */
export default function DropsPage() {
  const { t, flags } = useSession();
  const now = useNow();
  const [tab, setTab] = useState<Tab>('waiting');
  const [activity, setActivity] = useState<DropActivity[] | null>(null);
  const [mine, setMine] = useState<Drop[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setActivity(null);
    setMine(null);
    // Both lists or neither: an empty list that only failed to load would say "nothing here".
    Promise.all([api.drops.activity(), api.drops.mine()]).then(
      ([a, m]) => {
        setActivity(a.items);
        setMine(m.items);
      },
      (e) => setLoadError(errorMessage(e)),
    );
  }, []);
  useEffect(load, [load]);

  const waiting = (activity ?? []).filter((a) => a.drop.reminded && ['upcoming', 'opening', 'open'].includes(dropPhase(a.drop, now)));
  const bought = (activity ?? []).filter((a) => a.purchases.length);

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.drops.title')}</h1>
        {flags.COMMERCE !== false ? (
          <Link href="/drops/new" className="yp-btn yp-btn--primary yp-btn--sm">
            {t('m.drops.new')}
          </Link>
        ) : null}
      </div>
      <Segments
        label={t('m.drops.title')}
        value={tab}
        onChange={setTab}
        options={[
          { id: 'waiting', label: t('m.drops.section.waiting') },
          { id: 'bought', label: t('m.drops.section.bought') },
          { id: 'mine', label: t('m.drops.section.mine') },
        ]}
      />
      {loadError ? (
        <EmptyState
          title={loadError}
          action={
            <Button variant="secondary" onClick={load}>
              {t('m.common.retry')}
            </Button>
          }
        />
      ) : activity === null || mine === null ? (
        <Skeleton height={160} />
      ) : tab === 'waiting' ? (
        waiting.length ? (
          <ul className="drops-list">
            {waiting.map((a) => (
              <li key={a.drop.id}>
                <DropCard drop={a.drop} now={now} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t('m.drops.empty.waitingTitle')} body={t('m.drops.empty.waiting')} />
        )
      ) : tab === 'bought' ? (
        bought.length ? (
          <ul className="drops-list">
            {bought.map((a) => (
              <li key={a.drop.id} className="stack-sm">
                <DropCard drop={a.drop} now={now} />
                <ul className="drops-list__purchases">
                  {a.purchases.map((p) => (
                    <li key={`${p.orderId}:${p.productId}`}>
                      <span dir="auto">{p.title}</span> × {p.quantity} · <span className="muted">{t(PURCHASE[p.status])}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t('m.drops.empty.boughtTitle')} body={t('m.drops.empty.bought')} />
        )
      ) : mine.length ? (
        <ul className="drops-list">
          {mine.map((d) => (
            <li key={d.id} className="stack-sm">
              <DropCard drop={d} now={now} showSeller={false} />
              {d.stats && d.status !== 'draft' ? (
                <p className="muted" style={{ margin: 0 }}>
                  {t('m.drops.mineSummary', { waiting: d.stats.waiting, sold: d.stats.unitsSold })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title={t('m.drops.empty.mineTitle')}
          body={t('m.drops.empty.mine')}
          action={
            flags.COMMERCE !== false ? (
              <Link href="/drops/new" className="yp-btn yp-btn--secondary">
                {t('m.drops.new')}
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
