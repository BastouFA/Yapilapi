'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, EmptyState, Icon, Select, Skeleton, TextField } from '@yapilapi/design-system';
import {
  noticeText,
  IMAGE_ACCEPT,
  MARKET_AREA_MAX,
  MARKET_CATEGORIES,
  MARKET_CONDITIONS,
  MARKET_DELIVERY,
  MARKET_DESCRIPTION_MAX,
  MARKET_MAX_PHOTOS,
  MARKET_PHOTO_ALT_MAX,
  MARKET_PROHIBITED,
  MARKET_TITLE_MAX,
  prohibitedMatch,
  type LatLng,
  type MarketCategory,
  type MarketCondition,
  type MarketDelivery,
  type MarketListing,
  type MarketProhibited,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import {
  amountInput,
  categoryLabel,
  conditionLabel,
  deliveryLabel,
  forgetMarketMe,
  parseAmount,
  priceText,
  prohibitedLabel,
  useApproxHere,
  useMarketMe,
} from '@/components/Market';

// ── Selling: the form ─────────────────────────────────────────────────────
// Only the new-listing and edit pages load this file (see Market.tsx for the shared pieces).

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
      toast(
        noticeText({ code: r.noticeCode, message: r.notice }, t) ??
          (r.listing.moderation === 'review' ? t('market.review.saved') : listing ? t('market.form.saved') : t('market.form.published')),
      );
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
