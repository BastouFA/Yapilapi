'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Segments } from '@yapilapi/design-system';
import type { MarketListing } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { ListingGrid, SellNote, useMarketMe } from '@/components/Market';
import { useSession } from '../../../providers';

type Tab = 'active' | 'sold' | 'expired' | 'saved';
const TABS: Tab[] = ['active', 'sold', 'expired', 'saved'];

/** Your listings (for sale, sold, ended) and the listings you saved. */
export default function MyListingsPage() {
  const { t, toast } = useSession();
  const market = useMarketMe();
  const [tab, setTab] = useState<Tab>('active');
  const [items, setItems] = useState<MarketListing[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // From "Saved" on the Market page: ?tab=saved.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    if (q && (TABS as string[]).includes(q)) setTab(q as Tab);
  }, []);

  useEffect(() => {
    let live = true;
    setItems(null);
    setCursor(null);
    setLoadError(null);
    const load = tab === 'saved' ? api.market.saved() : api.market.mine(tab).then((r) => ({ items: r.items, nextCursor: null as string | null }));
    load.then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      },
      (e) => {
        if (!live) return;
        setItems([]);
        setLoadError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [tab, attempt]);

  const empty =
    tab === 'active'
      ? {
          title: t('market.mine.emptyActive'),
          body: market?.canSell ? t('market.mine.emptyActiveBody') : undefined,
          action: market?.canSell ? (
            <Link href="/market/new" className="yp-btn yp-btn--secondary">
              {t('market.sell')}
            </Link>
          ) : undefined,
        }
      : tab === 'sold'
        ? { title: t('market.mine.emptySold') }
        : tab === 'expired'
          ? { title: t('market.mine.emptyExpired'), body: t('market.mine.emptyExpiredBody') }
          : {
              title: t('market.mine.emptySaved'),
              body: t('market.mine.emptySavedBody'),
              action: (
                <Link href="/market" className="yp-btn yp-btn--secondary">
                  {t('market.mine.browse')}
                </Link>
              ),
            };

  return (
    <div className="yp-shell__inner market">
      <div className="yp-topbar">
        <h1>{tab === 'saved' ? t('market.saved') : t('market.yours')}</h1>
        <div className="row">
          <Link href="/market" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('market.title')}
          </Link>
          {market?.canSell ? (
            <Link href="/market/new" className="yp-btn yp-btn--primary yp-btn--sm">
              {t('market.sell')}
            </Link>
          ) : null}
        </div>
      </div>
      {market && !market.canSell ? <SellNote market={market} /> : null}
      <Segments
        label={t('market.yours')}
        value={tab}
        onChange={setTab}
        options={[
          { id: 'active', label: t('market.mine.active') },
          { id: 'sold', label: t('market.mine.sold') },
          { id: 'expired', label: t('market.mine.expired') },
          { id: 'saved', label: t('market.saved') },
        ]}
      />
      {tab === 'expired' ? <p className="muted market__intro">{t('market.mine.expiredNote')}</p> : null}
      <ListingGrid
        items={items}
        empty={empty}
        showMine={tab !== 'saved'}
        error={loadError ? { message: loadError, retry: () => setAttempt((n) => n + 1) } : null}
      />
      {cursor && items ? (
        <Button
          variant="secondary"
          loading={more}
          onClick={async () => {
            setMore(true);
            try {
              const r = await api.market.saved(cursor);
              setItems((cur) => [...(cur ?? []), ...r.items]);
              setCursor(r.nextCursor);
            } catch (e) {
              toast(errorMessage(e));
            } finally {
              setMore(false);
            }
          }}
        >
          {t('market.browse.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
