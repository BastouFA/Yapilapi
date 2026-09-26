'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, BottomSheet, Button, EmptyState, Skeleton, TextField } from '@yapilapi/design-system';
import type { ShopItem } from '@yapilapi/api-client';
import { formatMoney } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useSignIn } from './SignedOut';
import { useCheckout } from './Checkout';

const KIND_LABEL: Record<ShopItem['kind'], string> = { product: 'Product', digital: 'Download', service: 'Service', booking: 'Booking' };

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Start a download with a fresh short-lived link. */
export async function startDownload(productId: string) {
  const { url } = await api.shop.download(productId);
  window.location.assign(url);
}

/**
 * The Shop tab on a profile: what this person sells. Downloads are bought
 * through checkout and then downloaded from here (or your purchases);
 * services are booked for a time and confirmed by the seller.
 */
export function Shop({ userId, name, isSelf }: { userId: string; name: string; isSelf: boolean }) {
  const { me, toast, locale, flags } = useSession();
  const signIn = useSignIn();
  const checkout = useCheckout();
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [booking, setBooking] = useState<ShopItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.shop.list(userId).then(
        (r) => setItems(r.items),
        () => setItems([]),
      ),
    [userId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (flags.COMMERCE === false) return <EmptyState title="Shop" body="Buying and selling isn't available right now." />;
  if (items === null) return <Skeleton height={160} />;
  if (!items.length)
    return (
      <EmptyState
        title="Nothing for sale yet"
        body={isSelf ? 'Add products, downloads and services in Studio. They show up here.' : `${name} isn't selling anything right now.`}
        action={
          isSelf ? (
            <Link href="/studio#shop" className="yp-btn yp-btn--secondary yp-btn--sm">
              Open Studio
            </Link>
          ) : undefined
        }
      />
    );

  const buy = async (p: ShopItem) => {
    if (!me) return signIn();
    setBusy(p.id);
    try {
      const r = await api.orders.create([{ productId: p.id, quantity: 1 }], crypto.randomUUID());
      if (!r.payment) {
        toast('Order confirmed');
        await load();
        return;
      }
      checkout({
        orderId: r.payment.orderId,
        clientSecret: r.payment.clientSecret,
        provider: r.payment.provider,
        label: `${p.title}, ${formatMoney(p.priceCents, p.currency, locale)}`,
        onPaid: async () => {
          await load();
          if (p.kind === 'digital') toast('Paid. Your download is ready in the Shop tab and in your purchases.');
        },
      });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack-sm shop">
      {items.map((p) => (
        <article key={p.id} className="yp-card shop__item">
          <div className="shop__main">
            <div className="row" style={{ gap: 8 }}>
              <strong>{p.title}</strong>
              <Badge tone="neutral">{KIND_LABEL[p.kind]}</Badge>
            </div>
            {p.description ? <p className="muted shop__desc">{p.description}</p> : null}
            <span className="shop__price">
              {formatMoney(p.priceCents, p.currency, locale)}
              {p.file ? <span className="muted"> · {fileSize(p.file.sizeBytes)}</span> : null}
            </span>
          </div>
          <div className="shop__actions">
            {isSelf ? (
              p.kind === 'digital' && !p.file ? (
                <Link href="/studio#shop" className="yp-btn yp-btn--secondary yp-btn--sm">
                  Add the file
                </Link>
              ) : null
            ) : p.kind === 'digital' && p.owned ? (
              <Button
                size="sm"
                icon="check"
                loading={busy === p.id}
                onClick={async () => {
                  setBusy(p.id);
                  await startDownload(p.id).catch((e) => toast(errorMessage(e)));
                  setBusy(null);
                }}
              >
                Download
              </Button>
            ) : p.kind === 'service' ? (
              <Button size="sm" onClick={() => (me ? setBooking(p) : signIn())}>
                Book
              </Button>
            ) : p.inventory === 0 ? (
              <span className="muted">Sold out</span>
            ) : (
              <Button size="sm" loading={busy === p.id} onClick={() => buy(p)}>
                Buy
              </Button>
            )}
          </div>
        </article>
      ))}
      <BookSheet item={booking} onClose={() => setBooking(null)} seller={name} />
    </div>
  );
}

/** Ask for a time for a service. Paid services go through checkout; the seller then confirms or declines (declining refunds you). */
function BookSheet({ item, onClose, seller }: { item: ShopItem | null; onClose: () => void; seller: string }) {
  const { toast, locale } = useSession();
  const checkout = useCheckout();
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet open={!!item} onClose={onClose} title={item ? `Book ${item.title}` : 'Book'}>
      {item ? (
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!when) return;
            setBusy(true);
            try {
              const r = await api.shop.book(item.id, { startsAt: new Date(when).toISOString(), note, idempotencyKey: crypto.randomUUID() });
              onClose();
              setNote('');
              if (r.payment)
                checkout({
                  orderId: r.payment.orderId,
                  clientSecret: r.payment.clientSecret,
                  provider: r.payment.provider,
                  label: `${item.title}, ${formatMoney(item.priceCents, item.currency, locale)}`,
                  onPaid: () => toast(`Paid. ${seller} will confirm your booking.`),
                });
              else toast(`Request sent. ${seller} will confirm your booking.`);
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label="When" type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} required />
          <TextField label="Note for the seller (optional)" multiline value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {item.priceCents
              ? `You pay ${formatMoney(item.priceCents, item.currency, locale)} now. If ${seller} can't make that time, you get your money back.`
              : `${seller} will confirm the time with you.`}
          </p>
          <Button type="submit" loading={busy} disabled={!when}>
            {item.priceCents ? 'Continue to payment' : 'Send request'}
          </Button>
        </form>
      ) : null}
    </BottomSheet>
  );
}

/** Downloads you bought, each with a fresh download link on demand. */
export function PurchasesCard() {
  const { toast, locale } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.shop.purchases>>['items'] | null>(null);
  useEffect(() => {
    api.shop.purchases().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, []);
  if (!items?.length) return null;
  return (
    <section className="yp-card stack-sm" style={{ padding: 16 }}>
      <h2 className="section-title" style={{ margin: 0 }}>
        Your downloads
      </h2>
      {items.map((p) => (
        <div key={p.productId} className="row" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>{p.title}</strong>
            <span className="muted">
              {' '}
              · {p.seller.displayName} · {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(p.boughtAt))}
            </span>
          </span>
          <Button size="sm" variant="secondary" disabled={!p.file} onClick={() => startDownload(p.productId).catch((e) => toast(errorMessage(e)))}>
            Download
          </Button>
        </div>
      ))}
    </section>
  );
}
