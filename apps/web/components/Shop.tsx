'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, BottomSheet, Button, EmptyState, Skeleton, TextField } from '@yapilapi/design-system';
import type { ShopItem } from '@yapilapi/api-client';
import { formatMoney, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useSignIn } from './SignedOut';
import { useCheckout } from './Checkout';

const KIND_LABEL: Record<ShopItem['kind'], MessageKey> = {
  product: 'shop.kind.product',
  digital: 'shop.kind.digital',
  service: 'm.shop.service',
  booking: 'shop.kind.booking',
};

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
export function Shop({
  userId,
  name,
  isSelf,
  focusId,
}: {
  userId: string;
  name: string;
  isSelf: boolean;
  /** Scroll to this item (a link from the phone app). */ focusId?: string;
}) {
  const { me, toast, locale, flags, t } = useSession();
  const signIn = useSignIn();
  const checkout = useCheckout();
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [booking, setBooking] = useState<ShopItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    return api.shop.list(userId).then(
      (r) => setItems(r.items),
      // A shop that failed to load isn't an empty shop.
      (e) => setLoadError(errorMessage(e)),
    );
  }, [userId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (focusId && items?.some((p) => p.id === focusId)) document.getElementById(`product-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusId, items]);

  if (flags.COMMERCE === false) return <EmptyState title={t('m.shop.tab')} body={t('shop.unavailable')} />;
  if (items === null && loadError)
    return (
      <EmptyState
        title={loadError}
        action={
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {t('m.common.retry')}
          </Button>
        }
      />
    );
  if (items === null) return <Skeleton height={160} />;
  if (!items.length)
    return (
      <EmptyState
        title={t('shop.empty')}
        body={isSelf ? t('shop.emptySelf') : t('shop.emptyOther', { name })}
        action={
          isSelf ? (
            <Link href="/studio#shop" className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('shop.openStudio')}
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
        toast(t('shop.orderConfirmed'));
        await load();
        return;
      }
      checkout({
        orderId: r.payment.orderId,
        clientSecret: r.payment.clientSecret,
        provider: r.payment.provider,
        label: t('shop.checkoutLabel', { title: p.title, price: formatMoney(p.priceCents, p.currency, locale) }),
        onPaid: async () => {
          await load();
          if (p.kind === 'digital') toast(t('shop.paidDownload'));
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
        <article key={p.id} id={`product-${p.id}`} className={p.id === focusId ? 'yp-card shop__item shop__item--focus' : 'yp-card shop__item'}>
          <div className="shop__main">
            <div className="row" style={{ gap: 8 }}>
              <strong>{p.title}</strong>
              <Badge tone="neutral">{t(KIND_LABEL[p.kind])}</Badge>
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
                  {t('shop.addFile')}
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
                {t('m.shop.download')}
              </Button>
            ) : p.kind === 'service' ? (
              <Button size="sm" onClick={() => (me ? setBooking(p) : signIn())}>
                {t('m.shop.book')}
              </Button>
            ) : p.inventory === 0 ? (
              <span className="muted">{t('shop.soldOut')}</span>
            ) : (
              <Button size="sm" loading={busy === p.id} onClick={() => buy(p)}>
                {t('m.shop.buy')}
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
  const { toast, locale, t } = useSession();
  const checkout = useCheckout();
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet open={!!item} onClose={onClose} title={item ? t('shop.bookTitle', { title: item.title }) : t('m.shop.book')}>
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
                  label: t('shop.checkoutLabel', { title: item.title, price: formatMoney(item.priceCents, item.currency, locale) }),
                  onPaid: () => toast(t('shop.paidBooking', { name: seller })),
                });
              else toast(t('shop.requestSent', { name: seller }));
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label={t('shop.when')} type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} required />
          <TextField label={t('shop.note')} multiline value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {item.priceCents
              ? t('shop.payNow', { price: formatMoney(item.priceCents, item.currency, locale), name: seller })
              : t('shop.confirmTime', { name: seller })}
          </p>
          <Button type="submit" loading={busy} disabled={!when}>
            {item.priceCents ? t('shop.continuePayment') : t('shop.sendRequest')}
          </Button>
        </form>
      ) : null}
    </BottomSheet>
  );
}

/** Downloads you bought, each with a fresh download link on demand. */
export function PurchasesCard() {
  const { toast, locale, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.shop.purchases>>['items'] | null>(null);
  const [subs, setSubs] = useState<Awaited<ReturnType<typeof api.economy.mySubscriptions>>['items']>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(null);
    api.shop.purchases().then(
      (r) => setItems(r.items),
      (e) => {
        setItems((cur) => cur ?? []);
        setFailed(errorMessage(e));
      },
    );
    api.economy.mySubscriptions().then(
      (r) => setSubs(r.items),
      () => {},
    );
  }, []);
  useEffect(load, [load]);
  if (!items) return null;
  const day = (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(d));
  return (
    <>
      <section className="yp-card stack-sm" style={{ padding: 16 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          {t('shop.purchases.title')}
        </h2>
        {failed ? (
          <div className="row" role="alert">
            <span className="muted">{failed}</span>
            <Button size="sm" variant="secondary" onClick={load}>
              {t('m.common.retry')}
            </Button>
          </div>
        ) : null}
        {/* This card is the whole Purchases page: it says so when there's nothing yet, rather than leaving it blank. */}
        {!items.length && !failed ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('m.purchases.noDownloads')}
          </p>
        ) : null}
        {items.map((p) => (
          <div key={p.productId} className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>{p.title}</strong>
              <span className="muted">
                {' '}
                · {p.seller.displayName} · {day(p.boughtAt)}
              </span>
            </span>
            <Button size="sm" variant="secondary" disabled={!p.file} onClick={() => startDownload(p.productId).catch((e) => toast(errorMessage(e)))}>
              {t('m.shop.download')}
            </Button>
          </div>
        ))}
      </section>
      {/* Subscriptions to creators: what you pay for, until when, and a way to cancel. */}
      <section className="yp-card stack-sm" style={{ padding: 16 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          {t('m.purchases.subscriptions')}
        </h2>
        {subs.length ? (
          subs.map((s) => (
            <div key={s.id} className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>
                <Link href={`/u/${s.creator.username}`}>
                  <strong>{s.creator.displayName}</strong>
                </Link>
                <span className="muted">
                  {' '}
                  · {s.plan} · {t('m.money.perMonth', { price: formatMoney(s.priceCents, s.currency, locale) })} ·{' '}
                  {s.status === 'active' && s.currentPeriodEnd ? t('purchases.paidUntil', { date: day(s.currentPeriodEnd) }) : t('m.money.waitingPayment')}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={cancelling === s.id}
                onClick={async () => {
                  if (!window.confirm(`${t('m.purchases.cancelTitle', { name: s.creator.displayName })}\n\n${t('m.purchases.cancelBody')}`)) return;
                  setCancelling(s.id);
                  try {
                    await api.economy.cancel(s.id);
                    toast(t('m.purchases.cancelled'));
                    load();
                  } catch (e) {
                    toast(errorMessage(e));
                  } finally {
                    setCancelling(null);
                  }
                }}
              >
                {t('m.purchases.cancel')}
              </Button>
            </div>
          ))
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('m.purchases.noSubscriptions')}
          </p>
        )}
      </section>
    </>
  );
}
