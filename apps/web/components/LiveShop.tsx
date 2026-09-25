'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, ProductCard, Select } from '@yapilapi/design-system';
import type { LiveProduct } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';
import { BuyButton } from './BuyButton';

/** Products the host shows during a live. Viewers buy them without leaving; the host pins and unpins. */
export function LiveShop({ liveId, isHost, hostId }: { liveId: string; isHost: boolean; hostId: string }) {
  const { toast, locale, flags } = useSession();
  const [items, setItems] = useState<LiveProduct[]>([]);
  const [mine, setMine] = useState<LiveProduct[]>([]);
  const [pick, setPick] = useState('');
  const load = useCallback(
    () =>
      api.live.products(liveId).then(
        (r) => setItems(r.items),
        () => {},
      ),
    [liveId],
  );
  useEffect(() => {
    void load();
    if (isHost)
      api.raw.get<{ items: LiveProduct[] }>(`/v1/products?sellerId=${hostId}&limit=50`).then(
        (r) => setMine(r.items.filter((p) => p.kind !== 'ticket')),
        () => {},
      );
  }, [load, isHost, hostId]);
  useRealtime((e) => {
    if (e.type === 'live.products' && e.data.liveId === liveId) void load();
  });

  if (flags.COMMERCE === false || (!items.length && !isHost)) return null;
  const unpinned = mine.filter((p) => !items.some((i) => i.id === p.id));
  return (
    <section className="stack-sm" aria-label="Shop this live">
      <h2 className="section-title">Shop this live</h2>
      {items.length ? (
        <div className="live-shop">
          {items.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              locale={locale}
              action={
                isHost ? (
                  <Button size="sm" variant="secondary" onClick={() => api.live.unpin(liveId, p.id).catch((e) => toast(errorMessage(e)))}>
                    Stop showing
                  </Button>
                ) : (
                  <BuyButton productId={p.id} />
                )
              }
            />
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Show products you sell to everyone watching.
        </p>
      )}
      {isHost && unpinned.length ? (
        <form
          className="row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.live.pin(liveId, pick);
              setPick('');
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <Select label="Show a product" value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
              <option value="">Choose one of your products</option>
              {unpinned.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={!pick}>
            Show
          </Button>
        </form>
      ) : null}
    </section>
  );
}
