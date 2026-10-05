'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, List, ListItem, Select, Stat, TextField } from '@yapilapi/design-system';
import type { Boost, SalesReport, ServiceBooking, ShopItem } from '@yapilapi/api-client';
import { CURRENCIES, currencyForCountry, formatMoney, formatRelativeTime, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '@/app/providers';

/** Add what you sell on your profile's Shop tab: products, downloads (with their file) and services. */
export function ShopManager() {
  const { me, toast, locale, t } = useSession();
  const [items, setItems] = useState<ShopItem[]>([]);
  const [kind, setKind] = useState<'product' | 'digital' | 'service'>('digital');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('5');
  const [currency, setCurrency] = useState<string>(() => currencyForCountry(me?.country));
  const [busy, setBusy] = useState(false);
  const fileFor = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!me) return;
    setItems((await api.shop.list(me.id)).items);
  }, [me]);
  useEffect(() => {
    load().catch((e) => toast(errorMessage(e)));
  }, [load, toast]);

  return (
    <section className="stack-sm" id="shop">
      <h2 className="section-title">{t('m.shop.tab')}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {t('studio.shop.intro')}
      </p>
      {items.map((p) => (
        <div key={p.id} className="yp-card shop__item">
          <div className="shop__main">
            <div className="row" style={{ gap: 8 }}>
              <strong>{p.title}</strong>
              <Badge tone="neutral">
                {t(
                  p.kind === 'digital'
                    ? 'shop.kind.digital'
                    : p.kind === 'service'
                      ? 'm.shop.service'
                      : p.kind === 'booking'
                        ? 'shop.kind.booking'
                        : 'shop.kind.product',
                )}
              </Badge>
            </div>
            <span className="shop__price">
              {formatMoney(p.priceCents, p.currency, locale)}
              {p.kind === 'digital' ? <span className="muted"> · {p.file ? p.file.name : t('studio.shop.noFile')}</span> : null}
            </span>
          </div>
          {p.kind === 'digital' ? (
            <div className="shop__actions">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  fileFor.current = p.id;
                  input.current?.click();
                }}
              >
                {p.file ? t('studio.shop.replaceFile') : t('shop.addFile')}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <input
        ref={input}
        type="file"
        hidden
        accept=".pdf,.zip,.epub,.mp3,.m4a,.mp4,.png,.jpg,.jpeg,application/pdf,application/zip,application/epub+zip,audio/mpeg,audio/mp4,video/mp4,image/png,image/jpeg"
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file || !fileFor.current) return;
          try {
            await api.shop.uploadFile(fileFor.current, file, file.name);
            toast(t('studio.shop.fileAdded'));
            await load();
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      />
      <form
        className="stack-sm yp-card"
        style={{ padding: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api.shop.create({ kind, title, description, priceCents: Math.round(Number(price) * 100), currency });
            setTitle('');
            setDescription('');
            await load();
            if (kind === 'digital') {
              toast(t('studio.shop.addedNeedsFile'));
              fileFor.current = r.product.id;
              input.current?.click();
            } else toast(t('studio.shop.added'));
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row">
          <Select label={t('studio.shop.type')} value={kind} onChange={(e) => setKind(e.currentTarget.value as typeof kind)}>
            <option value="digital">{t('shop.kind.digital')}</option>
            <option value="service">{t('m.shop.service')}</option>
            <option value="product">{t('shop.kind.product')}</option>
          </Select>
          <TextField label={t('market.form.price')} type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.currentTarget.value)} />
          <Select label={t('m.boost.currency')} value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>
        <TextField label={t('market.form.title')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        <TextField
          label={t('market.form.description')}
          multiline
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          maxLength={5000}
        />
        <Button type="submit" loading={busy} disabled={!title.trim()} style={{ alignSelf: 'flex-start' }}>
          {t('studio.shop.add')}
        </Button>
      </form>
    </section>
  );
}

/** Sales from your shop over the last 30 days, and bookings for your services to confirm. */
export function SalesPanel() {
  const { toast, locale, t, tp } = useSession();
  const [sales, setSales] = useState<SalesReport | null>(null);
  const [bookings, setBookings] = useState<ServiceBooking[]>([]);
  const [refunding, setRefunding] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [s, b] = await Promise.all([api.shop.sales(30), api.shop.serviceBookings()]);
    setSales(s);
    setBookings(b.items);
  }, []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  if (!sales) return null;

  /** Refund a whole order (every line in it): the buyer gets their money back and its items go back on sale. */
  const refund = async (orderId: string, buyer: string) => {
    const lines = sales.items.filter((x) => x.orderId === orderId);
    const amount = formatMoney(
      lines.reduce((n, x) => n + x.amountCents, 0),
      lines[0]!.currency,
      locale,
    );
    if (!window.confirm(t('studio.sales.refundConfirm', { amount, name: buyer }))) return;
    setRefunding(orderId);
    try {
      const r = await api.orders.refund(orderId);
      toast(t(r.status === 'succeeded' ? 'studio.sales.refundDone' : 'studio.sales.refundFailed'));
      await load();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setRefunding(null);
    }
  };

  const decide = async (id: string, confirm: boolean) => {
    try {
      await api.bookings.decide(id, confirm);
      toast(t(confirm ? 'studio.bookings.confirmed' : 'studio.bookings.declined'));
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <section className="stack-sm">
      <h2 className="section-title">{t('m.studio.sales')}</h2>
      {sales.totals.length ? (
        <div className="stats">
          {sales.totals.map((x) => (
            <Stat
              key={x.currency}
              label={tp('m.studio.salesCount', x.orders, { currency: x.currency })}
              value={formatMoney(x.netCents, x.currency, locale)}
              delta={t('m.studio.salesGross', { gross: formatMoney(x.grossCents, x.currency, locale) })}
            />
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {tp('studio.sales.none', sales.days)}
        </p>
      )}
      {sales.items.length ? (
        <List label={t('studio.sales.latest')}>
          {sales.items.slice(0, 20).map((x) => (
            <ListItem
              key={`${x.orderId}-${x.product.id}`}
              primary={x.product.title}
              secondary={`${x.buyer.displayName} · ${formatRelativeTime(x.createdAt, locale)}`}
              end={
                <span className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {formatMoney(x.amountCents, x.currency, locale)}{' '}
                  {x.status === 'refunded' ? (
                    <Badge tone="warning">{t('m.studio.refunded')}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={refunding === x.orderId}
                      aria-label={t('studio.sales.refundA11y', { title: x.product.title, name: x.buyer.displayName })}
                      onClick={() => void refund(x.orderId, x.buyer.displayName)}
                    >
                      {t('studio.sales.refund')}
                    </Button>
                  )}
                </span>
              }
            />
          ))}
        </List>
      ) : null}
      {bookings.length ? (
        <>
          <h3 className="section-title">{t('m.studio.bookings')}</h3>
          <List label={t('m.studio.bookings')}>
            {bookings.map((b) => (
              <ListItem
                key={b.id}
                primary={`${b.product.title} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.startsAt))}`}
                secondary={`${b.customer.displayName}${b.note ? ` · ${b.note}` : ''}`}
                end={
                  b.status === 'requested' ? (
                    <span className="row">
                      <Button size="sm" onClick={() => decide(b.id, true)}>
                        {t('m.studio.confirm')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => decide(b.id, false)}>
                        {t('m.studio.decline')}
                      </Button>
                    </span>
                  ) : (
                    <Badge tone={b.status === 'confirmed' ? 'success' : 'neutral'}>
                      {t(
                        b.status === 'confirmed'
                          ? 'm.booking.status.confirmed'
                          : b.status === 'declined'
                            ? 'm.booking.status.declined'
                            : 'm.booking.status.cancelled',
                      )}
                    </Badge>
                  )
                }
              />
            ))}
          </List>
        </>
      ) : null}
    </section>
  );
}

/** Your boosts and how they're doing. Boost a post from its menu (public posts only). */
export function BoostsPanel() {
  const { locale, me, t } = useSession();
  const [items, setItems] = useState<(Boost & { postId: string; excerpt: string })[] | null>(null);
  useEffect(() => {
    api.boosts.mine().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, []);
  if (!items) return null;
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  return (
    <section className="stack-sm">
      <h2 className="section-title">{t('m.studio.boosts')}</h2>
      {items.length ? (
        <List label={t('m.studio.boosts')}>
          {items.map((b) => (
            <ListItem
              key={b.campaignId}
              href={`/p/${b.postId}`}
              linkAs={NextLink}
              primary={b.excerpt || t('m.studio.untitledPost')}
              secondary={`${t(`post.boost.status.${b.status}` as MessageKey)} · ${
                b.audience.type === 'country' ? b.audience.countries.join(', ') : b.audience.topics.map((x) => `#${x}`).join(' ')
              }${b.reviewNote ? ` · ${b.reviewNote}` : ''}`}
              end={t('studio.boosts.line', {
                views: n(b.impressions),
                clicks: n(b.clicks),
                spent: formatMoney(b.spentCents, b.currency, locale),
                budget: formatMoney(b.budgetCents + b.refundedCents, b.currency, locale),
              })}
            />
          ))}
        </List>
      ) : (
        <EmptyState
          title={t('studio.boosts.empty')}
          body={t('studio.boosts.emptyBody')}
          action={
            <Link href={me ? `/u/${me.username}` : '/home'} className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('studio.boosts.goToPosts')}
            </Link>
          }
        />
      )}
    </section>
  );
}
