'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon, Select } from '@yapilapi/design-system';
import { dropCountdown, dropDay, dropPhase, formatMoney, type Drop } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession, type Session } from '@/app/providers';
import { useCheckout } from './Checkout';

/**
 * Drops: product launches announced ahead of time. Cards for profiles and Home, the words for a
 * drop's time (plain, like "Opens Friday at 6:00 PM", never a ticking clock), and buying from an
 * open drop. The seller's form is in DropEditor.tsx, so Home and profiles don't load it.
 */

/** The current time, moved on every `ms` so relative words stay right. Minutes are enough. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "Opens today at 6:00 PM", "Opens tomorrow at 9:00 AM", "Opens Friday at 6:00 PM", "Opens Tue, Oct 20 at 6:00 PM". */
export function opensText(t: Session['t'], locale: string, startsAt: string, now = new Date()): string {
  const d = dropDay(startsAt, locale, now);
  if (d.kind === 'today') return t('m.drops.opensToday', { time: d.time });
  if (d.kind === 'tomorrow') return t('m.drops.opensTomorrow', { time: d.time });
  return t('m.drops.opensOn', { day: d.day, time: d.time });
}

/** "in 3 days", "in 5 hours", in the viewer's language. */
export function untilText(locale: string, at: string, now = new Date()): string | null {
  const c = dropCountdown(at, now);
  if (!c) return null;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(c.value, c.unit);
  } catch {
    return null;
  }
}

const shortWhen = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** One line for where a drop is: when it opens, that it's open (and until when), or how it ended. */
export function dropStatusText(t: Session['t'], locale: string, d: Drop, now = new Date()): string {
  const phase = dropPhase(d, now);
  if (phase === 'upcoming' || phase === 'draft') {
    const until = untilText(locale, d.startsAt, now);
    const opens = opensText(t, locale, d.startsAt, now);
    return phase === 'draft' ? `${t('m.drops.draft')} · ${opens}` : until ? `${opens} · ${until}` : opens;
  }
  if (phase === 'opening') return t('m.drops.opening');
  if (phase === 'open') return d.endsAt ? t('m.drops.closesOn', { when: shortWhen(locale, d.endsAt) }) : t('m.drops.open');
  if (phase === 'cancelled') return t('m.drops.cancelled');
  return d.endReason === 'sold_out' ? t('m.drops.soldOut') : t('m.drops.ended');
}

/** The cover photo, or the brand gradient with a bag when there is none. Cards load it when they scroll near; `eager` is for the top of a drop's page. */
export function DropCover({
  drop,
  className = 'drop-cover',
  eager = false,
}: {
  drop: Pick<Drop, 'coverUrl' | 'coverAlt' | 'title'>;
  className?: string;
  eager?: boolean;
}) {
  const { t } = useSession();
  return drop.coverUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={drop.coverUrl}
      alt={drop.coverAlt || t('m.drops.coverAlt', { title: drop.title })}
      loading={eager ? undefined : 'lazy'}
      decoding="async"
    />
  ) : (
    <span className={`${className} drop-cover--plain`} aria-hidden>
      <Icon name="bag" size={28} />
    </span>
  );
}

/** A drop in a row: cover, name, who, and when. */
export function DropCard({ drop, now, showSeller = true }: { drop: Drop; now: Date; showSeller?: boolean }) {
  const { t, tp, locale } = useSession();
  const phase = dropPhase(drop, now);
  return (
    <Link href={`/drops/${drop.id}`} className="drop-card">
      <DropCover drop={drop} />
      <span className="drop-card__body">
        <span className="drop-card__title" dir="auto">
          {drop.title}
        </span>
        {showSeller ? <span className="drop-card__meta">{t('m.drops.by', { name: drop.seller.displayName })}</span> : null}
        <span className={phase === 'open' || phase === 'opening' ? 'drop-card__when drop-card__when--open' : 'drop-card__when'}>
          {dropStatusText(t, locale, drop, now)}
        </span>
        <span className="drop-card__meta">{tp('m.drops.products', drop.items.length)}</span>
      </span>
    </Link>
  );
}

/** A person's drops on their profile (nothing when they have none). */
export function DropsRow({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t, flags } = useSession();
  const now = useNow();
  const [items, setItems] = useState<Drop[]>([]);
  useEffect(() => {
    api.drops.byUser(userId).then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, [userId]);
  if (flags.COMMERCE === false || !items.length) return null;
  return (
    <section className="drops-row" aria-labelledby="drops-row-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 id="drops-row-title" className="section-title" style={{ margin: 0 }}>
          {t('m.drops.onProfile')}
        </h2>
        {isSelf ? (
          <Link href="/drops" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('m.drops.yours')}
          </Link>
        ) : null}
      </div>
      <ul className="drops-row__list">
        {items.map((d) => (
          <li key={d.id}>
            <DropCard drop={d} now={now} showSeller={false} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** On Home: open and coming drops from people you follow (nothing when there are none). */
export function FollowingDrops() {
  const { t, flags } = useSession();
  const now = useNow();
  const [items, setItems] = useState<Drop[]>([]);
  useEffect(() => {
    api.drops.following().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, []);
  if (flags.COMMERCE === false || !items.length) return null;
  return (
    <section className="drops-row" aria-labelledby="following-drops-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 id="following-drops-title" className="section-title" style={{ margin: 0 }}>
          {t('m.drops.fromFollowing')}
        </h2>
        <Link href="/drops" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('m.drops.yours')}
        </Link>
      </div>
      <ul className="drops-row__list">
        {items.map((d) => (
          <li key={d.id}>
            <DropCard drop={d} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Keep a drop current: realtime changes, and a check each 15 seconds while it's about to open. */
export function useDrop(id: string, enabled = true) {
  const [drop, setDrop] = useState<Drop | null>(null);
  const [missing, setMissing] = useState(false);
  const now = useNow(15_000);
  const load = useCallback(
    () =>
      api.drops.get(id).then(
        (r) => {
          setDrop(r.drop);
          setMissing(false);
        },
        () => setMissing(true),
      ),
    [id],
  );
  useEffect(() => {
    if (enabled) void load();
  }, [load, enabled]);
  useRealtime((e) => {
    if (e.type === 'drop.updated' && (e.data as { id?: string } | undefined)?.id === id) void load();
  });
  const opening = drop ? dropPhase(drop, now) === 'opening' : false;
  useEffect(() => {
    if (opening) void load();
  }, [opening, now, load]);
  return { drop, setDrop, missing, reload: load, now };
}

/**
 * Buy from an open drop through the usual checkout. The amount goes up to what is left, the
 * per-person limit and what you already have; the server checks all of it again.
 */
export function DropBuy({ drop, item, onDone }: { drop: Drop; item: Drop['items'][number]; onDone: () => void }) {
  const { t, toast, locale } = useSession();
  const checkout = useCheckout();
  const [busy, setBusy] = useState(false);
  const caps = [10, item.remaining ?? 10, item.perBuyerLimit !== null ? item.perBuyerLimit - (item.yours ?? 0) : 10];
  const most = Math.max(0, Math.min(...caps));
  const [qty, setQty] = useState(1);
  if (item.soldOut) return <Badge>{t('m.drops.soldOut')}</Badge>;
  if (most < 1) return <span className="muted">{t('m.drops.limitReached')}</span>;
  return (
    <div className="row drop-buy">
      {most > 1 ? (
        <Select label={t('m.drops.amount')} value={String(qty)} onChange={(e) => setQty(Number(e.currentTarget.value))} className="drop-buy__qty">
          {Array.from({ length: most }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      ) : null}
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.orders.create([{ productId: item.productId, quantity: qty }], crypto.randomUUID());
            onDone();
            if (r.order.status === 'paid' || !r.payment) toast(t('m.drops.bought', { count: qty }));
            else
              checkout({
                orderId: r.order.id,
                clientSecret: r.payment.clientSecret,
                provider: r.payment.provider,
                label: `${item.title} × ${qty}, ${formatMoney(r.order.totalCents, r.order.currency, locale)}`,
                onPaid: onDone,
              });
          } catch (e) {
            toast(errorMessage(e));
            onDone();
          } finally {
            setBusy(false);
          }
        }}
        aria-label={`${t('m.drops.buy')}: ${item.title}`}
      >
        {t('m.drops.buy')}
      </Button>
    </div>
  );
}
