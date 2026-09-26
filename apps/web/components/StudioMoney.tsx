'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, List, ListItem, Select, Stat, TextField } from '@yapilapi/design-system';
import type { Boost, SalesReport, ServiceBooking, ShopItem } from '@yapilapi/api-client';
import { CURRENCIES, currencyForCountry, formatMoney, formatRelativeTime, t as translate, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '@/app/providers';

/** Add what you sell on your profile's Shop tab: products, downloads (with their file) and services. */
export function ShopManager() {
  const { me, toast, locale } = useSession();
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
    void load();
  }, [load]);

  return (
    <section className="stack-sm" id="shop">
      <h2 className="section-title">Shop</h2>
      <p className="muted" style={{ margin: 0 }}>
        What you add here shows on the Shop tab of your profile. Downloads are stored privately and only buyers can get them. A 5% platform fee applies.
      </p>
      {items.map((p) => (
        <div key={p.id} className="yp-card shop__item">
          <div className="shop__main">
            <div className="row" style={{ gap: 8 }}>
              <strong>{p.title}</strong>
              <Badge tone="neutral">{p.kind === 'digital' ? 'Download' : p.kind === 'service' ? 'Service' : 'Product'}</Badge>
            </div>
            <span className="shop__price">
              {formatMoney(p.priceCents, p.currency, locale)}
              {p.kind === 'digital' ? <span className="muted"> · {p.file ? p.file.name : "No file yet. Buyers can't buy it until you add one."}</span> : null}
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
                {p.file ? 'Replace file' : 'Add file'}
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
            toast('File added');
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
              toast('Added. Now add the file buyers will download.');
              fileFor.current = r.product.id;
              input.current?.click();
            } else toast('Added to your shop');
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row">
          <Select label="Type" value={kind} onChange={(e) => setKind(e.currentTarget.value as typeof kind)}>
            <option value="digital">Download</option>
            <option value="service">Service</option>
            <option value="product">Product</option>
          </Select>
          <TextField label="Price" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.currentTarget.value)} />
          <Select label="Currency" value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        <TextField label="Description" multiline value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={5000} />
        <Button type="submit" loading={busy} disabled={!title.trim()} style={{ alignSelf: 'flex-start' }}>
          Add to shop
        </Button>
      </form>
    </section>
  );
}

/** Sales from your shop over the last 30 days, and bookings for your services to confirm. */
export function SalesPanel() {
  const { toast, locale } = useSession();
  const [sales, setSales] = useState<SalesReport | null>(null);
  const [bookings, setBookings] = useState<ServiceBooking[]>([]);
  const load = useCallback(async () => {
    const [s, b] = await Promise.all([api.shop.sales(30), api.shop.serviceBookings()]);
    setSales(s);
    setBookings(b.items);
  }, []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  if (!sales) return null;

  const decide = async (id: string, confirm: boolean) => {
    try {
      await api.bookings.decide(id, confirm);
      toast(confirm ? 'Booking confirmed' : 'Booking declined. The customer gets their money back.');
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <section className="stack-sm">
      <h2 className="section-title">Sales</h2>
      {sales.totals.length ? (
        <div className="stats">
          {sales.totals.map((x) => (
            <Stat
              key={x.currency}
              label={`${x.orders} ${x.orders === 1 ? 'sale' : 'sales'} (${x.currency})`}
              value={formatMoney(x.netCents, x.currency, locale)}
              delta={`${formatMoney(x.grossCents, x.currency, locale)} before the 5% fee`}
            />
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No sales in the last {sales.days} days.
        </p>
      )}
      {sales.items.length ? (
        <List label="Latest sales">
          {sales.items.slice(0, 20).map((x) => (
            <ListItem
              key={`${x.orderId}-${x.product.id}`}
              primary={x.product.title}
              secondary={`${x.buyer.displayName} · ${formatRelativeTime(x.createdAt, locale)}`}
              end={
                <span>
                  {formatMoney(x.amountCents, x.currency, locale)} {x.status === 'refunded' ? <Badge tone="warning">Refunded</Badge> : null}
                </span>
              }
            />
          ))}
        </List>
      ) : null}
      {bookings.length ? (
        <>
          <h3 className="section-title">Service bookings</h3>
          <List label="Service bookings">
            {bookings.map((b) => (
              <ListItem
                key={b.id}
                primary={`${b.product.title} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.startsAt))}`}
                secondary={`${b.customer.displayName}${b.note ? ` · ${b.note}` : ''}`}
                end={
                  b.status === 'requested' ? (
                    <span className="row">
                      <Button size="sm" onClick={() => decide(b.id, true)}>
                        Confirm
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => decide(b.id, false)}>
                        Decline
                      </Button>
                    </span>
                  ) : (
                    <Badge tone={b.status === 'confirmed' ? 'success' : 'neutral'}>
                      {b.status === 'confirmed' ? 'Confirmed' : b.status === 'declined' ? 'Declined' : 'Cancelled'}
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
  const { locale, me } = useSession();
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
      <h2 className="section-title">Boosts</h2>
      {items.length ? (
        <List label="Boosts">
          {items.map((b) => (
            <ListItem
              key={b.campaignId}
              href={`/p/${b.postId}`}
              linkAs={NextLink}
              primary={b.excerpt || 'Your post'}
              secondary={`${translate(`post.boost.status.${b.status}` as MessageKey, locale)} · ${
                b.audience.type === 'country' ? b.audience.countries.join(', ') : b.audience.topics.map((x) => `#${x}`).join(' ')
              }${b.reviewNote ? ` · ${b.reviewNote}` : ''}`}
              end={`${n(b.impressions)} views · ${n(b.clicks)} clicks · ${formatMoney(b.spentCents, b.currency, locale)} of ${formatMoney(
                b.budgetCents + b.refundedCents,
                b.currency,
                locale,
              )}`}
            />
          ))}
        </List>
      ) : (
        <EmptyState
          title="No boosts yet"
          body="Open the menu on one of your public posts and choose Boost."
          action={
            <Link href={me ? `/u/${me.username}` : '/home'} className="yp-btn yp-btn--secondary yp-btn--sm">
              Go to your posts
            </Link>
          }
        />
      )}
    </section>
  );
}
