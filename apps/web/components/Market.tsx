'use client';

import Link from 'next/link';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Avatar, Badge, BottomSheet, Button, EmptyState, Icon, Skeleton, TextField } from '@yapilapi/design-system';
import {
  approximatePoint,
  formatMoney,
  formatRelativeTime,
  MARKET_PRICE_MAX_CENTS,
  MARKET_RATING_TEXT_MAX,
  type LatLng,
  type MarketCategory,
  type MarketCondition,
  type MarketDelivery,
  type MarketListing,
  type MarketMe,
  type MarketProfile,
  type MarketProhibited,
  type MarketSellerCard,
  type MarketStatus,
  type MarketWhere,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { useSession, type Session } from '@/app/providers';

/**
 * Market (web): people selling and buying used and local things near them, person to person.
 * Nothing is paid in the app; people meet and pay in person. This file has the pieces the Market
 * pages, the profile's Market tab and the chat cards share: words for prices, places and labels,
 * the listing tiles, the seller card, safety tips, and the amount and rating sheets. The form to
 * sell something is in MarketForm.tsx, so pages that only show listings don't load it.
 *
 * Places: the browser is asked where you are only when you tap "Use my approximate location". The
 * point is snapped to about a kilometre on this device before it's sent, and kept in memory for
 * this visit only (never in storage). Nobody is ever sent a listing's place, only a distance.
 */

type T = Session['t'];

// ── Words ───────────────────────────────────────────────────────────────

const CATEGORY: Record<MarketCategory, MessageKey> = {
  electronics: 'market.category.electronics',
  phones: 'market.category.phones',
  computers: 'market.category.computers',
  home: 'market.category.home',
  furniture: 'market.category.furniture',
  appliances: 'market.category.appliances',
  clothing: 'market.category.clothing',
  shoes_bags: 'market.category.shoes_bags',
  beauty: 'market.category.beauty',
  baby_kids: 'market.category.baby_kids',
  toys_games: 'market.category.toys_games',
  sports: 'market.category.sports',
  books: 'market.category.books',
  music: 'market.category.music',
  vehicles: 'market.category.vehicles',
  bikes: 'market.category.bikes',
  tools: 'market.category.tools',
  garden: 'market.category.garden',
  art_crafts: 'market.category.art_crafts',
  other: 'market.category.misc',
};
const CONDITION: Record<MarketCondition, MessageKey> = {
  new: 'market.condition.new',
  like_new: 'market.condition.like_new',
  good: 'market.condition.good',
  fair: 'market.condition.fair',
};
const DELIVERY: Record<MarketDelivery, MessageKey> = {
  pickup: 'market.delivery.pickup',
  seller_delivers: 'market.delivery.seller_delivers',
  shipping: 'market.delivery.shipping',
};
const PROHIBITED: Record<MarketProhibited, MessageKey> = {
  weapons: 'market.prohibited.weapons',
  drugs: 'market.prohibited.drugs',
  animals: 'market.prohibited.animals',
  alcohol: 'market.prohibited.alcohol',
  tobacco: 'market.prohibited.tobacco',
  adult: 'market.prohibited.adult',
  counterfeit: 'market.prohibited.counterfeit',
  recalled: 'market.prohibited.recalled',
  medicines: 'market.prohibited.medicines',
};
const STATUS: Record<MarketStatus, MessageKey> = {
  available: 'market.status.available',
  reserved: 'market.status.reserved',
  sold: 'market.status.sold',
};

export const categoryLabel = (t: T, c: MarketCategory) => t(CATEGORY[c]);
export const conditionLabel = (t: T, c: MarketCondition) => t(CONDITION[c]);
export const deliveryLabel = (t: T, d: MarketDelivery) => t(DELIVERY[d]);
export const prohibitedLabel = (t: T, p: MarketProhibited) => t(PROHIBITED[p]);
export const statusLabel = (t: T, s: MarketStatus) => t(STATUS[s]);

/** "₦5,000.00", or "Free". */
export function priceText(t: T, locale: string, cents: number | null, currency: string): string {
  if (cents === null) return t('market.free');
  try {
    return formatMoney(cents, currency, locale);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "About 3 km away", or the area the seller wrote. */
export function whereText(t: T, tp: Session['tp'], where: MarketWhere): string {
  return where.distanceKm !== null ? tp('market.distance', where.distanceKm) : where.area;
}

/** "About 3 km away · Yaba", or just the area. */
export function whereLong(t: T, tp: Session['tp'], where: MarketWhere): string {
  return where.distanceKm !== null ? `${tp('market.distance', where.distanceKm)} · ${where.area}` : where.area;
}

/** An amount typed by a person ("5000", "12.50", "12,50") in hundredths, or null when it isn't one. */
export function parseAmount(text: string): number | null {
  const s = text.trim().replace(/[\s ]/g, '');
  if (!s) return null;
  // One comma and no dot is a decimal comma; otherwise commas separate thousands.
  const n = Number(/^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents >= 1 && cents <= MARKET_PRICE_MAX_CENTS ? cents : null;
}

/** Hundredths back to what a person would type ("5000", "12.5"). */
export const amountInput = (cents: number | null) => (cents === null ? '' : String(cents / 100));

// ── What you can do on Market ─────────────────────────────────────────────

let meCache: Promise<MarketMe | null> | null = null;

/** Your currency and whether you can sell, asked once per visit. */
export function useMarketMe(): MarketMe | null | undefined {
  const { me } = useSession();
  const [value, setValue] = useState<MarketMe | null | undefined>(undefined);
  useEffect(() => {
    if (!me) return setValue(null);
    meCache ??= api.market.me().then(
      (r) => r.market,
      () => {
        meCache = null;
        return null;
      },
    );
    let live = true;
    void meCache.then((m) => live && setValue(m));
    return () => {
      live = false;
    };
  }, [me]);
  return value;
}

/** After publishing, "listings left today" changes: ask again next time. */
export function forgetMarketMe() {
  meCache = null;
}

// ── Where you are (in memory only) ────────────────────────────────────────

type GeoProblem = 'denied' | 'unavailable' | 'unsupported';
let herePoint: LatLng | null = null;
const hereListeners = new Set<() => void>();
function setHere(p: LatLng | null) {
  herePoint = p;
  for (const fn of hereListeners) fn();
}

/** Where this device is, once, snapped to about a kilometre here before it's used anywhere. */
function readApproxPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject('unsupported' satisfies GeoProblem);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(approximatePoint({ lat: p.coords.latitude, lng: p.coords.longitude })),
      (e) => reject((e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable') satisfies GeoProblem),
      // An approximate place is all that's needed: a quick, low-power answer.
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 300_000 },
    );
  });
}

export function geoProblemText(t: T, e: unknown): string {
  if (e === 'denied') return t('market.geo.denied');
  if (e === 'unsupported') return t('market.geo.unsupported');
  if (e === 'unavailable') return t('market.geo.unavailable');
  return errorMessage(e);
}

/**
 * Your approximate place for this visit: shared by the Market pages (so distances show on a listing
 * after you used it to browse), forgotten when the page is closed or reloaded.
 */
export function useApproxHere() {
  const { t, toast } = useSession();
  const here = useSyncExternalStore(
    (fn) => {
      hereListeners.add(fn);
      return () => hereListeners.delete(fn);
    },
    () => herePoint,
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function locate(): Promise<LatLng | null> {
    setBusy(true);
    setProblem(null);
    try {
      const p = await readApproxPosition();
      setHere(p);
      return p;
    } catch (e) {
      const text = geoProblemText(t, e);
      setProblem(text);
      toast(text);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { here, locate, forget: () => setHere(null), busy, problem };
}

// ── Listings in a grid ────────────────────────────────────────────────────

export function StatusBadge({ status, expired }: { status: MarketStatus; expired?: boolean }) {
  const { t } = useSession();
  if (expired && status !== 'sold') return <Badge>{t('market.status.ended')}</Badge>;
  if (status === 'available') return null;
  return <Badge tone={status === 'reserved' ? 'warning' : 'neutral'}>{statusLabel(t, status)}</Badge>;
}

/** One listing: photo, price (or Free), title, how far or where, and Reserved or Sold. */
export function ListingTile({ listing, showMine = false }: { listing: MarketListing; showMine?: boolean }) {
  const { t, tp, locale } = useSession();
  const photo = listing.photos[0];
  return (
    <Link href={`/market/${listing.id}`} className="market-tile">
      <span className="market-tile__photo">
        {photo ? (
          // The title follows in the link, so the photo is described by its own alt text only when the seller wrote one.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.thumbUrl || photo.url} alt={photo.altText ?? ''} loading="lazy" decoding="async" />
        ) : (
          <span className="market-tile__none" aria-hidden>
            <Icon name="bag" size={28} />
          </span>
        )}
        {listing.status !== 'available' || listing.expired ? (
          <span className="market-tile__badge">
            <StatusBadge status={listing.status} expired={listing.expired} />
          </span>
        ) : null}
      </span>
      <span className="market-tile__body">
        <span className="market-tile__price">{priceText(t, locale, listing.priceCents, listing.currency)}</span>
        <span className="market-tile__title" dir="auto">
          {listing.title}
        </span>
        <span className="market-tile__where" dir="auto">
          {whereText(t, tp, listing.where)}
        </span>
        {showMine && listing.moderation === 'review' ? <span className="market-tile__note">{t('market.review.short')}</span> : null}
      </span>
    </Link>
  );
}

export function ListingGrid({
  items,
  empty,
  showMine,
  label,
}: {
  items: MarketListing[] | null;
  empty: { title: string; body?: string; action?: React.ReactNode };
  showMine?: boolean;
  label?: string;
}) {
  if (items === null)
    return (
      <div className="market-grid" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={220} />
        ))}
      </div>
    );
  if (!items.length) return <EmptyState title={empty.title} body={empty.body} action={empty.action} />;
  return (
    <ul className="market-grid" aria-label={label}>
      {items.map((l) => (
        <li key={l.id}>
          <ListingTile listing={l} showMine={showMine} />
        </li>
      ))}
    </ul>
  );
}

// ── Seller, ratings, safety ───────────────────────────────────────────────

/** "4.5 out of 5 (12 ratings)", or "No ratings yet". */
export function ratingText(t: T, tp: Session['tp'], locale: string, r: { average: number | null; count: number }): string {
  if (r.average === null || !r.count) return t('market.rating.none');
  const avg = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(r.average);
  return tp('market.rating.summary', r.count, { average: avg });
}

/** Five stars drawn for a rating; the words say the same for screen readers. */
export function Stars({ value, label }: { value: number; label: string }) {
  return (
    <span className="market-stars" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= Math.round(value) ? 'market-stars__on' : 'market-stars__off'} aria-hidden>
          ★
        </span>
      ))}
    </span>
  );
}

export function SellerCard({ card, heading = true }: { card: MarketSellerCard; heading?: boolean }) {
  const { t, tp, locale } = useSession();
  const since = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(card.memberSince));
  const titleId = useId();
  return (
    <section className="market-seller yp-card" aria-labelledby={heading ? titleId : undefined}>
      {heading ? (
        <h2 id={titleId} className="section-title" style={{ margin: 0 }}>
          {t('market.seller.title')}
        </h2>
      ) : null}
      <div className="market-seller__who">
        <span aria-hidden>
          <Avatar name={card.user.displayName} src={card.user.avatarUrl} />
        </span>
        <span className="stack" style={{ gap: 2 }}>
          <Link href={`/u/${card.user.username}`} className="market-seller__name">
            <bdi>{card.user.displayName}</bdi>
          </Link>
          <span className="muted market-seller__since">{t('market.seller.since', { date: since })}</span>
        </span>
      </div>
      <ul className="market-seller__facts">
        <li>
          {card.rating.average !== null && card.rating.count ? <Stars value={card.rating.average} label={ratingText(t, tp, locale, card.rating)} /> : null}
          <span aria-hidden={card.rating.average !== null && card.rating.count ? true : undefined}>{ratingText(t, tp, locale, card.rating)}</span>
        </li>
        <li>{card.responseRate !== null ? t('market.seller.responseRate', { rate: card.responseRate }) : t('market.seller.responseRateNew')}</li>
        <li>{tp('market.seller.sold', card.sold)}</li>
      </ul>
    </section>
  );
}

/** Plain safety tips, and that paying happens in person. */
export function SafetyTips({ compact = false }: { compact?: boolean }) {
  const { t } = useSession();
  if (compact)
    return (
      <p className="market-safety-line">
        <Icon name="shield" size={14} /> <span>{t('market.safety.short')}</span>
      </p>
    );
  return (
    <section className="market-safety" aria-labelledby="market-safety-title">
      <h2 id="market-safety-title" className="market-safety__title">
        <Icon name="shield" size={18} /> {t('market.safety.title')}
      </h2>
      <ul>
        <li>{t('market.safety.public')}</li>
        <li>{t('market.safety.check')}</li>
        <li>{t('market.safety.advance')}</li>
        <li>{t('market.safety.inPerson')}</li>
      </ul>
    </section>
  );
}

/** Why someone can't sell yet (under 18, or no date of birth on the account). */
export function SellNote({ market }: { market: MarketMe }) {
  const { t } = useSession();
  if (market.canSell) return null;
  return (
    <p className="market-note" role="note">
      <Icon name="info" size={16} /> <span>{market.sellBlock === 'birth_date_required' ? t('market.sell.needsBirthDate') : t('market.sell.adultsOnly')}</span>
    </p>
  );
}

// ── Sheets ──────────────────────────────────────────────────────────────

/** An amount in a currency: making an offer, or a counter-offer. */
export function AmountSheet({
  open,
  onClose,
  title,
  intro,
  currency,
  initialCents,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  intro?: string;
  currency: string;
  initialCents: number | null;
  submitLabel: string;
  onSubmit: (cents: number) => Promise<void>;
}) {
  const { t, locale } = useSession();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setValue(amountInput(initialCents));
    setError(undefined);
  }, [open, initialCents]);
  const cents = parseAmount(value);
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <form
        className="stack"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (cents === null) return setError(t('market.amount.invalid'));
          setBusy(true);
          try {
            await onSubmit(cents);
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {intro ? (
          <p className="muted" style={{ margin: 0 }}>
            {intro}
          </p>
        ) : null}
        <TextField
          label={t('market.amount.label', { currency })}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            setError(undefined);
          }}
          error={error}
          hint={cents !== null ? priceText(t, locale, cents, currency) : undefined}
          autoFocus
        />
        <p className="muted market-sheet__note">{t('market.amount.note')}</p>
        <Button type="submit" block loading={busy}>
          {submitLabel}
        </Button>
      </form>
    </BottomSheet>
  );
}

/** 1 to 5 stars and a few optional words, after a sale. */
export function RateSheet({
  open,
  onClose,
  listingId,
  name,
  onRated,
}: {
  open: boolean;
  onClose: () => void;
  listingId: string;
  name: string;
  onRated: () => void;
}) {
  const { t, tp, toast } = useSession();
  const [stars, setStars] = useState(0);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const group = useId();
  useEffect(() => {
    if (!open) return;
    setStars(0);
    setBody('');
    setError(null);
  }, [open]);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('market.rate.title', { name })}>
      <form
        className="stack"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!stars) return setError(t('market.rate.pick'));
          setBusy(true);
          try {
            await api.market.rate(listingId, { stars, body: body.trim() || undefined });
            toast(t('market.rate.done'));
            onRated();
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="market-rate" aria-describedby={error ? `${group}-err` : undefined}>
          <legend className="yp-field__label">{t('market.rate.stars')}</legend>
          <div className="market-rate__stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className={`market-rate__star${n <= stars ? ' market-rate__star--on' : ''}`}>
                <input
                  type="radio"
                  name={group}
                  value={n}
                  checked={stars === n}
                  onChange={() => {
                    setStars(n);
                    setError(null);
                  }}
                />
                <span aria-hidden>★</span>
                <span className="yp-visually-hidden">{tp('market.rate.starLabel', n)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error ? (
          <p id={`${group}-err`} className="yp-field__error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        ) : null}
        <TextField
          label={t('market.rate.body')}
          multiline
          rows={3}
          maxLength={MARKET_RATING_TEXT_MAX}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          hint={`${body.length}/${MARKET_RATING_TEXT_MAX}`}
        />
        <p className="muted market-sheet__note">{t('market.rate.note')}</p>
        <Button type="submit" block loading={busy}>
          {t('market.rate.submit')}
        </Button>
      </form>
    </BottomSheet>
  );
}

// ── On a profile ──────────────────────────────────────────────────────────

/** Someone's Market tab: their seller card, what they have for sale, and what people said. */
export function ProfileMarket({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t, tp, locale } = useSession();
  const [data, setData] = useState<MarketProfile | null | 'missing'>(null);
  // Why it couldn't load, when that isn't because it's not for this person to see.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setData(null);
    setLoadError(null);
    api.market.profile(userId).then(
      (r) => setData(r.market),
      (e) => (isGone(e) ? setData('missing') : setLoadError(errorMessage(e))),
    );
  }, [userId, attempt]);
  if (data === null && loadError)
    return <EmptyState title={loadError} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('m.common.retry')}</Button>} />;
  if (data === null) return <Skeleton height={240} />;
  if (data === 'missing') return <EmptyState title={t('market.profile.unavailable')} />;
  return (
    <div className="stack market-profile">
      {isSelf ? (
        <div className="row">
          <Link href="/market/new" className="yp-btn yp-btn--primary yp-btn--sm">
            {t('market.sell')}
          </Link>
          <Link href="/market/mine" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('market.yours')}
          </Link>
        </div>
      ) : null}
      <SellerCard card={data.seller} />
      {data.asBuyer.count ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('market.profile.asBuyer', { rating: ratingText(t, tp, locale, data.asBuyer) })}
        </p>
      ) : null}
      <section className="stack-sm" aria-labelledby="market-profile-listings">
        <h2 id="market-profile-listings" className="section-title" style={{ margin: 0 }}>
          {t('market.profile.forSale')}
        </h2>
        <ListingGrid items={data.listings} empty={{ title: isSelf ? t('market.profile.emptySelf') : t('market.profile.empty') }} />
      </section>
      <section className="stack-sm" aria-labelledby="market-profile-ratings">
        <h2 id="market-profile-ratings" className="section-title" style={{ margin: 0 }}>
          {t('market.profile.ratings')}
        </h2>
        {data.ratings.length ? (
          <ul className="market-ratings">
            {data.ratings.map((r) => (
              <li key={r.id} className="market-rating">
                <div className="market-rating__head">
                  <span aria-hidden>
                    <Avatar name={r.rater.displayName} src={r.rater.avatarUrl} size="sm" />
                  </span>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <Link href={`/u/${r.rater.username}`} className="market-rating__who">
                      <bdi>{r.rater.displayName}</bdi>
                    </Link>
                    <span className="muted market-rating__meta">
                      {r.raterRole === 'buyer'
                        ? t('market.rating.boughtItem', { title: r.listingTitle })
                        : t('market.rating.soldItem', { title: r.listingTitle })}
                      {' · '}
                      {formatRelativeTime(r.createdAt, locale)}
                    </span>
                  </span>
                </div>
                <Stars value={r.stars} label={tp('market.rating.stars', r.stars)} />
                {r.body ? (
                  <p className="market-rating__body" dir="auto">
                    {r.body}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('market.rating.none')}
          </p>
        )}
      </section>
    </div>
  );
}
