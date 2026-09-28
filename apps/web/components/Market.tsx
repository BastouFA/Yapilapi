'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Avatar, Badge, BottomSheet, Button, Checkbox, EmptyState, Icon, Select, Skeleton, TextField } from '@yapilapi/design-system';
import {
  approximatePoint,
  formatMoney,
  formatRelativeTime,
  IMAGE_ACCEPT,
  MARKET_AREA_MAX,
  MARKET_CATEGORIES,
  MARKET_CONDITIONS,
  MARKET_DELIVERY,
  MARKET_DESCRIPTION_MAX,
  MARKET_MAX_PHOTOS,
  MARKET_PHOTO_ALT_MAX,
  MARKET_PRICE_MAX_CENTS,
  MARKET_PROHIBITED,
  MARKET_RATING_TEXT_MAX,
  MARKET_TITLE_MAX,
  prohibitedMatch,
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
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession, type Session } from '@/app/providers';

/**
 * Market (web): people selling and buying used and local things near them, person to person.
 * Nothing is paid in the app; people meet and pay in person. This file has the pieces the Market
 * pages, the profile's Market tab and the chat cards share: words for prices, places and labels,
 * the listing tiles, the seller card, safety tips, the amount and rating sheets, and the form to
 * sell something.
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
          <img src={photo.thumbUrl || photo.url} alt={photo.altText ?? ''} loading="lazy" />
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

// ── Selling: the form ─────────────────────────────────────────────────────

type PhotoDraft = {
  key: string;
  mediaId: string | null;
  /** A preview here while it uploads, then the uploaded photo. */
  url: string;
  altText: string;
  uploading: boolean;
};

type PlaceChoice = { kind: 'keep' } | { kind: 'set'; point: LatLng } | { kind: 'remove' };

/**
 * Sell something, or change a listing: up to MARKET_MAX_PHOTOS photos (each with its own
 * description), title, price or Free, condition, category, description, where to pick it up (and,
 * when the seller taps for it, an approximate place), and how it can change hands.
 *
 * Before publishing, the words are checked against what can't be sold on Market. When they look like
 * one of those things, the seller sees which and can change the listing, or say it isn't one of these
 * (then it waits for a moderator before others see it). The API makes the same check.
 */
export function ListingForm({ listing }: { listing?: MarketListing }) {
  const { t, toast, locale } = useSession();
  const router = useRouter();
  const market = useMarketMe();
  const place = useApproxHere();
  const currency = listing?.currency ?? market?.currency ?? 'USD';

  const [photos, setPhotos] = useState<PhotoDraft[]>(
    () => listing?.photos.map((p) => ({ key: p.mediaId, mediaId: p.mediaId, url: p.url, altText: p.altText ?? '', uploading: false })) ?? [],
  );
  const [title, setTitle] = useState(listing?.title ?? '');
  const [free, setFree] = useState(listing ? listing.priceCents === null : false);
  const [price, setPrice] = useState(amountInput(listing?.priceCents ?? null));
  const [condition, setCondition] = useState<MarketCondition | ''>(listing?.condition ?? '');
  const [category, setCategory] = useState<MarketCategory | ''>(listing?.category ?? '');
  const [description, setDescription] = useState(listing?.description ?? '');
  const [area, setArea] = useState(listing?.where.area ?? '');
  const [placeChoice, setPlaceChoice] = useState<PlaceChoice>({ kind: 'keep' });
  const [delivery, setDelivery] = useState<MarketDelivery[]>(listing?.delivery ?? ['pickup']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  // Words that look like something Market doesn't allow: which kind (null when the API said so without one).
  const [prohibited, setProhibited] = useState<{ kind: MarketProhibited | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const hasPlace = placeChoice.kind === 'set' || (placeChoice.kind === 'keep' && !!listing?.hasPlace);
  const uploading = photos.some((p) => p.uploading);

  async function addFiles(files: File[]) {
    const room = MARKET_MAX_PHOTOS - photos.length;
    if (files.length > room) toast(t('market.form.photosMax', { count: MARKET_MAX_PHOTOS }));
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      previews.current.push(url);
      setPhotos((cur) => [...cur, { key, mediaId: null, url, altText: '', uploading: true }]);
      try {
        const { media } = await api.media.upload(file);
        if (media.kind !== 'image') throw new Error(t('market.form.photoOnly'));
        setPhotos((cur) => cur.map((p) => (p.key === key ? { ...p, mediaId: media.id, uploading: false } : p)));
      } catch (e) {
        setPhotos((cur) => cur.filter((p) => p.key !== key));
        toast(e instanceof Error && !(e instanceof ApiError) ? e.message : errorMessage(e));
      }
    }
    setErrors((e) => ({ ...e, photos: '' }));
  }

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= photos.length) return;
    const next = [...photos];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setPhotos(next);
    setSaid(t('market.form.photoMoved', { position: j + 1, count: next.length }));
    // Focus follows the photo to its new place.
    requestAnimationFrame(() => document.getElementById(`market-photo-${next[j]!.key}-${by < 0 ? 'up' : 'down'}`)?.focus());
  }

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!photos.length) e.photos = t('market.form.error.photos');
    if (title.trim().length < 3) e.title = t('market.form.error.title');
    if (!free && parseAmount(price) === null) e.price = t('market.form.error.price');
    if (!condition) e.condition = t('market.form.error.condition');
    if (!category) e.category = t('market.form.error.category');
    if (area.trim().length < 2) e.area = t('market.form.error.area');
    if (!delivery.length) e.delivery = t('market.form.error.delivery');
    return e;
  }

  async function submit(notProhibited = false) {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      toast(t('market.form.error.check'));
      return;
    }
    if (uploading) return toast(t('market.form.waitUploads'));
    // A first look before sending: the same check the API makes.
    if (!notProhibited) {
      const kind = prohibitedMatch(title, description);
      if (kind) return setProhibited({ kind });
    }
    setProhibited(null);
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        description: description.trim(),
        category: category as MarketCategory,
        condition: condition as MarketCondition,
        priceCents: free ? null : parseAmount(price),
        photos: photos.map((p) => ({ mediaId: p.mediaId!, altText: p.altText.trim() || undefined })),
        area: area.trim(),
        delivery,
        ...(placeChoice.kind === 'set' ? { place: placeChoice.point } : placeChoice.kind === 'remove' ? { place: null } : {}),
        ...(notProhibited ? { notProhibited: true } : {}),
      };
      const r = listing ? await api.market.update(listing.id, body) : await api.market.create(body);
      forgetMarketMe();
      toast(r.notice ?? (r.listing.moderation === 'review' ? t('market.review.saved') : listing ? t('market.form.saved') : t('market.form.published')));
      router.push(`/market/${r.listing.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'prohibited_item') {
        const k = typeof err.details?.kind === 'string' ? err.details.kind : undefined;
        const kind = (MARKET_PROHIBITED as readonly string[]).includes(k ?? '') ? (k as MarketProhibited) : prohibitedMatch(title, description);
        setProhibited({ kind });
      } else if (err instanceof ApiError && err.code === 'market_daily_limit') {
        toast(t('market.form.dailyLimit'));
      } else if (err instanceof ApiError && err.code === 'adults_only') {
        toast(t('market.sell.adultsOnly'));
      } else {
        if (err instanceof ApiError && err.fields) setErrors(err.fields);
        toast(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (market === undefined) return <Skeleton height={320} />;
  if (market && !market.canSell && !listing)
    return (
      <EmptyState
        title={t('market.sell.cantTitle')}
        body={market.sellBlock === 'birth_date_required' ? t('market.sell.needsBirthDate') : t('market.sell.adultsOnly')}
      />
    );
  const limitReached = !listing && market !== null && market.listingsLeftToday <= 0;

  return (
    <form
      className="stack market-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {limitReached ? <Alert tone="info">{t('market.form.dailyLimit')}</Alert> : null}

      <fieldset className="market-form__group" aria-describedby="market-photos-hint">
        <legend>{t('market.form.photos')}</legend>
        <p id="market-photos-hint" className="muted" style={{ margin: 0 }}>
          {t('market.form.photosHint', { count: MARKET_MAX_PHOTOS })}
        </p>
        {errors.photos ? (
          <p className="yp-field__error" role="alert" style={{ margin: 0 }}>
            {errors.photos}
          </p>
        ) : null}
        {photos.length ? (
          <ol className="market-form__photos">
            {photos.map((p, i) => (
              <li key={p.key} className="market-form__photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.altText || t('market.form.photoN', { n: i + 1 })} />
                <div className="market-form__photo-side">
                  <span className="market-form__photo-n">
                    {i === 0 ? t('market.form.cover') : t('market.form.photoN', { n: i + 1 })}
                    {p.uploading ? ` · ${t('market.form.uploading')}` : ''}
                  </span>
                  <TextField
                    label={t('market.form.alt')}
                    value={p.altText}
                    maxLength={MARKET_PHOTO_ALT_MAX}
                    hint={t('market.form.altHint')}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setPhotos((cur) => cur.map((x) => (x.key === p.key ? { ...x, altText: v } : x)));
                    }}
                  />
                  <div className="row market-form__photo-actions">
                    <button
                      type="button"
                      id={`market-photo-${p.key}-up`}
                      className="yp-action market-form__icon-btn"
                      disabled={i === 0}
                      aria-label={t('market.form.moveEarlier', { n: i + 1 })}
                      onClick={() => move(i, -1)}
                    >
                      <Icon name="chevron-up" size={18} />
                    </button>
                    <button
                      type="button"
                      id={`market-photo-${p.key}-down`}
                      className="yp-action market-form__icon-btn"
                      disabled={i === photos.length - 1}
                      aria-label={t('market.form.moveLater', { n: i + 1 })}
                      onClick={() => move(i, 1)}
                    >
                      <Icon name="chevron-down" size={18} />
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      aria-label={t('market.form.removePhotoN', { n: i + 1 })}
                      onClick={() => {
                        setPhotos((cur) => cur.filter((x) => x.key !== p.key));
                        setSaid(t('market.form.photoRemoved'));
                        fileRef.current?.parentElement?.querySelector<HTMLButtonElement>('.market-form__add')?.focus();
                      }}
                    >
                      {t('market.form.removePhoto')}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <span className="yp-visually-hidden" role="status">
          {said}
        </span>
        {photos.length < MARKET_MAX_PHOTOS ? (
          <Button variant="secondary" icon="image" className="market-form__add" onClick={() => fileRef.current?.click()}>
            {photos.length ? t('market.form.addMore') : t('market.form.addPhotos')}
          </Button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            if (files.length) void addFiles(files);
          }}
        />
      </fieldset>

      <TextField
        id="market-title"
        label={t('market.form.title')}
        value={title}
        maxLength={MARKET_TITLE_MAX}
        onChange={(e) => setTitle(e.currentTarget.value)}
        error={errors.title}
        hint={`${title.length}/${MARKET_TITLE_MAX}`}
        required
      />

      <fieldset className="market-form__group">
        <legend>{t('market.form.price')}</legend>
        <Checkbox label={t('market.form.free')} description={t('market.form.freeHint')} checked={free} onChange={(e) => setFree(e.currentTarget.checked)} />
        {!free ? (
          <TextField
            label={t('market.form.priceIn', { currency })}
            inputMode="decimal"
            autoComplete="off"
            value={price}
            onChange={(e) => setPrice(e.currentTarget.value)}
            error={errors.price}
            hint={parseAmount(price) !== null ? priceText(t, locale, parseAmount(price), currency) : t('market.form.priceHint')}
          />
        ) : null}
      </fieldset>

      <div className="market-form__pair">
        <Select
          label={t('market.form.condition')}
          value={condition}
          onChange={(e) => setCondition(e.currentTarget.value as MarketCondition)}
          aria-invalid={errors.condition ? true : undefined}
          hint={errors.condition}
        >
          <option value="" disabled>
            {t('market.form.choose')}
          </option>
          {MARKET_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {conditionLabel(t, c)}
            </option>
          ))}
        </Select>
        <Select
          label={t('market.form.category')}
          value={category}
          onChange={(e) => setCategory(e.currentTarget.value as MarketCategory)}
          aria-invalid={errors.category ? true : undefined}
          hint={errors.category}
          aria-describedby="market-prohibited"
        >
          <option value="" disabled>
            {t('market.form.choose')}
          </option>
          {MARKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(t, c)}
            </option>
          ))}
        </Select>
      </div>
      <details className="market-prohibited" id="market-prohibited">
        <summary>{t('market.prohibited.title')}</summary>
        <p className="muted" style={{ margin: 0 }}>
          {t('market.prohibited.intro')}
        </p>
        <ul>
          {MARKET_PROHIBITED.map((p) => (
            <li key={p}>{prohibitedLabel(t, p)}</li>
          ))}
        </ul>
      </details>

      <TextField
        label={t('market.form.description')}
        multiline
        rows={5}
        value={description}
        maxLength={MARKET_DESCRIPTION_MAX}
        onChange={(e) => setDescription(e.currentTarget.value)}
        hint={`${description.length}/${MARKET_DESCRIPTION_MAX}`}
      />

      <fieldset className="market-form__group">
        <legend>{t('market.form.where')}</legend>
        <TextField
          label={t('market.form.area')}
          value={area}
          maxLength={MARKET_AREA_MAX}
          onChange={(e) => setArea(e.currentTarget.value)}
          error={errors.area}
          hint={t('market.form.areaHint')}
          required
        />
        <p className="market-note" id="market-place-note">
          <Icon name="lock" size={16} /> <span>{t('market.form.placeNote')}</span>
        </p>
        <div className="row">
          <Button
            variant="secondary"
            icon="map-pin"
            loading={place.busy}
            aria-describedby="market-place-note"
            onClick={async () => {
              const p = await place.locate();
              if (p) {
                setPlaceChoice({ kind: 'set', point: p });
                setSaid(t('market.form.placeAdded'));
              }
            }}
          >
            {hasPlace ? t('market.form.placeUpdate') : t('market.geo.use')}
          </Button>
          {hasPlace ? (
            <Button
              variant="ghost"
              onClick={() => {
                setPlaceChoice(listing?.hasPlace ? { kind: 'remove' } : { kind: 'keep' });
                setSaid(t('market.form.placeRemoved'));
              }}
            >
              {t('market.form.placeRemove')}
            </Button>
          ) : null}
        </div>
        {hasPlace ? <p className="muted market-form__status">{t('market.form.placeOn')}</p> : null}
        {place.problem ? (
          <p className="yp-field__error" role="alert" style={{ margin: 0 }}>
            {place.problem}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="market-form__group" aria-describedby={errors.delivery ? 'market-delivery-err' : undefined}>
        <legend>{t('market.form.delivery')}</legend>
        {MARKET_DELIVERY.map((d) => (
          <Checkbox
            key={d}
            label={deliveryLabel(t, d)}
            checked={delivery.includes(d)}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              setDelivery((cur) => (on ? [...cur, d] : cur.filter((x) => x !== d)));
            }}
          />
        ))}
        {errors.delivery ? (
          <p id="market-delivery-err" className="yp-field__error" style={{ margin: 0 }}>
            {errors.delivery}
          </p>
        ) : null}
      </fieldset>

      {prohibited ? (
        <Alert tone="warning" title={t('market.prohibited.foundTitle')}>
          <div className="stack-sm">
            <p style={{ margin: 0 }}>
              {prohibited.kind ? t('market.prohibited.found', { kind: prohibitedLabel(t, prohibited.kind) }) : t('market.prohibited.foundAny')}
            </p>
            <p style={{ margin: 0 }}>{t('market.prohibited.explain')}</p>
            <div className="row">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setProhibited(null);
                  document.getElementById('market-title')?.focus();
                }}
              >
                {t('market.prohibited.change')}
              </Button>
              <Button size="sm" loading={busy} onClick={() => void submit(true)}>
                {t('market.prohibited.notOne')}
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      <p className="market-note">
        <Icon name="info" size={16} /> <span>{t('market.form.reviewNote')}</span>
      </p>
      <div className="row">
        <Button type="submit" loading={busy} disabled={limitReached || uploading}>
          {listing ? t('market.form.save') : t('market.form.publish')}
        </Button>
        <Link href={listing ? `/market/${listing.id}` : '/market'} className="yp-btn yp-btn--ghost">
          {t('market.form.cancel')}
        </Link>
      </div>
    </form>
  );
}

// ── On a profile ──────────────────────────────────────────────────────────

/** Someone's Market tab: their seller card, what they have for sale, and what people said. */
export function ProfileMarket({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t, tp, locale } = useSession();
  const [data, setData] = useState<MarketProfile | null | 'missing'>(null);
  useEffect(() => {
    setData(null);
    api.market.profile(userId).then(
      (r) => setData(r.market),
      () => setData('missing'),
    );
  }, [userId]);
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
