'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, Badge, BottomSheet, Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import {
  marketDaysLeft,
  type MarketContactBlock,
  type MarketListingDetail,
  type MarketPhoto,
  type MessageKey,
  type PublicListingPreview,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage, isGone } from '@/lib/api';
import {
  AmountSheet,
  categoryLabel,
  conditionLabel,
  deliveryLabel,
  priceText,
  RateSheet,
  SafetyTips,
  SellerCard,
  StatusBadge,
  statusLabel,
  useApproxHere,
  whereLong,
} from '@/components/Market';
import { ReportSheet } from '@/components/PostList';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import { useSession } from '../../../providers';

const CONTACT_BLOCK: Record<Exclude<MarketContactBlock, 'self'>, MessageKey> = {
  minor_protection: 'market.contact.minor',
  blocked: 'market.contact.blocked',
  unavailable: 'market.contact.unavailable',
};

const REVIEW_REASON: Record<NonNullable<MarketListingDetail['reviewReason']>, MessageKey> = {
  prohibited: 'market.review.reason.prohibited',
  duplicate: 'market.review.reason.duplicate',
  low_price: 'market.review.reason.low_price',
  photos: 'market.review.reason.photos',
  text: 'market.review.reason.text',
};

/**
 * A listing: its photos, price, condition, where it is (the area and, when both sides gave a place,
 * about how far), how it can change hands, the seller's card and plain safety tips. Buyers message
 * the seller, make an offer, save, share or report it. Sellers edit it, mark it reserved or sold
 * (to one of the people who wrote to them, or someone else), renew it near the end, or delete it.
 * Without an account, a shared link shows the public preview.
 */
export default function ListingPageClient({ preview }: { preview: PublicListingPreview | null }) {
  const { id } = useParams<{ id: string }>();
  const { t, tp, toast, locale, me, loading } = useSession();
  const router = useRouter();
  const place = useApproxHere();
  const [listing, setListing] = useState<MarketListingDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone; a listing already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [offering, setOffering] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [rating, setRating] = useState(false);
  const [marking, setMarking] = useState<'reserved' | 'sold' | null>(null);
  const [said, setSaid] = useState('');

  const load = useCallback(() => {
    setLoadError(null);
    return api.market.get(id, place.here ?? undefined).then(
      (r) => {
        setListing(r.listing);
        setMissing(false);
      },
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [id, place.here]);
  useEffect(() => {
    if (me) void load();
  }, [load, me]);

  if (!me) {
    if (loading) return <Skeleton height={320} />;
    return preview ? <PublicListing preview={preview} /> : <NeedsAccount title={t('market.signIn.title')} body={t('market.signIn.body')} />;
  }
  if (missing) return <EmptyState level={1} title={t('market.listing.missing')} body={t('market.listing.missingBody')} />;
  if (!listing && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={() => void load()}>{t('m.common.retry')}</Button>} />;
  if (!listing) return <Skeleton height={420} />;

  const l = listing;
  const daysLeft = marketDaysLeft(l.expiresAt);

  async function run(key: string, fn: () => Promise<void>, done?: string) {
    setBusy(key);
    try {
      await fn();
      if (done) {
        toast(done);
        setSaid(done);
      }
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    const url = `${location.origin}/market/${l.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: l.title, text: `${l.title} · ${priceText(t, locale, l.priceCents, l.currency)}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast(t('market.listing.linkCopied'));
    } catch (e) {
      // Closing the share sheet isn't an error.
      if ((e as Error).name !== 'AbortError') toast(t('market.listing.shareFailed'));
    }
  }

  const contact = () =>
    run('message', async () => {
      const conversationId = l.conversationId ?? (await api.market.message(l.id)).conversationId;
      router.push(`/inbox/${conversationId}`);
    });

  return (
    <div className="yp-shell__inner market market-listing">
      <Gallery photos={l.photos} title={l.title} />

      <header className="stack-sm">
        <p className="market-listing__price">{priceText(t, locale, l.priceCents, l.currency)}</p>
        <h1 className="market-listing__title" dir="auto">
          {l.title}
        </h1>
        <p className="market-listing__badges">
          <StatusBadge status={l.status} expired={l.expired} />
          {l.forYou ? <Badge tone="success">{l.status === 'sold' ? t('market.listing.soldToYou') : t('market.listing.reservedForYou')}</Badge> : null}
          <Badge>{conditionLabel(t, l.condition)}</Badge>
          <Badge>{categoryLabel(t, l.category)}</Badge>
        </p>
        <p className="market-listing__where">
          <Icon name="map-pin" size={16} /> <span dir="auto">{whereLong(t, tp, l.where)}</span>
        </p>
        {l.where.distanceKm === null && l.hasPlace && !place.here ? (
          <div>
            <Button variant="ghost" size="sm" icon="compass" loading={place.busy} onClick={() => void place.locate()} aria-describedby="market-distance-note">
              {t('market.listing.showDistance')}
            </Button>
            <p id="market-distance-note" className="muted market-listing__small">
              {t('market.browse.nearNote')}
            </p>
          </div>
        ) : null}
        <p className="market-listing__delivery">
          <span className="yp-visually-hidden">{t('market.form.delivery')}: </span>
          {l.delivery.map((d) => (
            <span key={d} className="market-listing__chip">
              <Icon name="check" size={14} /> {deliveryLabel(t, d)}
            </span>
          ))}
        </p>
      </header>

      <span className="yp-visually-hidden" role="status">
        {said}
      </span>

      {l.mine ? (
        <OwnerPanel
          listing={l}
          daysLeft={daysLeft}
          busy={busy}
          onRenew={() =>
            run(
              'renew',
              async () => {
                await api.market.renew(l.id);
                await load();
              },
              t('market.owner.renewed'),
            )
          }
          onAvailable={() =>
            run(
              'available',
              async () => {
                await api.market.setStatus(l.id, 'available');
                await load();
              },
              t('market.owner.markedAvailable'),
            )
          }
          onMark={setMarking}
          onDelete={() => {
            if (!confirm(t('market.owner.deleteConfirm'))) return;
            void run(
              'delete',
              async () => {
                await api.market.remove(l.id);
                router.push('/market/mine');
              },
              t('market.owner.deleted'),
            );
          }}
        />
      ) : (
        <section className="market-listing__actions" aria-label={t('market.listing.actions')}>
          {l.canContact && l.status !== 'sold' && !l.expired ? (
            <>
              <Button icon="message" loading={busy === 'message'} onClick={() => void contact()}>
                {l.conversationId ? t('market.listing.openChat') : t('market.listing.message')}
              </Button>
              {l.priceCents !== null ? (
                <Button variant="secondary" onClick={() => setOffering(true)}>
                  {t('market.listing.offer')}
                </Button>
              ) : null}
            </>
          ) : l.canContact && l.conversationId ? (
            <Button icon="message" variant="secondary" onClick={() => router.push(`/inbox/${l.conversationId}`)}>
              {t('market.listing.openChat')}
            </Button>
          ) : null}
          {!l.canContact && l.contactBlock && l.contactBlock !== 'self' ? (
            <p className="market-note" role="note">
              <Icon name="info" size={16} /> <span>{t(CONTACT_BLOCK[l.contactBlock])}</span>
            </p>
          ) : null}
        </section>
      )}

      {l.rating?.otherUser ? (
        l.rating.canRate ? (
          <div className="row">
            <Button variant="secondary" icon="star" onClick={() => setRating(true)}>
              {t('market.rate.button', { name: l.rating.otherUser.displayName })}
            </Button>
          </div>
        ) : l.rating.rated ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('market.rate.rated', { name: l.rating.otherUser.displayName })}
          </p>
        ) : null
      ) : null}

      <div className="row market-listing__secondary">
        {!l.mine ? (
          <Button
            variant="ghost"
            icon="bookmark"
            aria-pressed={l.saved}
            loading={busy === 'save'}
            onClick={() =>
              run(
                'save',
                async () => {
                  if (l.saved) await api.market.unsave(l.id);
                  else await api.market.save(l.id);
                  setListing({ ...l, saved: !l.saved });
                },
                l.saved ? t('market.listing.unsaved') : t('market.listing.savedDone'),
              )
            }
          >
            {l.saved ? t('market.listing.savedButton') : t('market.listing.save')}
          </Button>
        ) : null}
        <Button variant="ghost" icon="link" onClick={() => void share()}>
          {t('market.listing.share')}
        </Button>
        {!l.mine ? (
          <Button variant="ghost" icon="flag" onClick={() => setReporting(true)}>
            {t('market.listing.report')}
          </Button>
        ) : null}
      </div>

      {l.description ? (
        <section className="stack-sm" aria-labelledby="market-description">
          <h2 id="market-description" className="section-title" style={{ margin: 0 }}>
            {t('market.form.description')}
          </h2>
          <p className="market-listing__description" dir="auto">
            {l.description}
          </p>
        </section>
      ) : null}

      <SellerCard card={l.sellerCard} />
      <SafetyTips />

      <AmountSheet
        open={offering}
        onClose={() => setOffering(false)}
        title={t('market.offer.title')}
        intro={t('market.offer.intro', { price: priceText(t, locale, l.priceCents, l.currency) })}
        currency={l.currency}
        initialCents={l.priceCents}
        submitLabel={t('market.offer.send')}
        onSubmit={async (cents) => {
          try {
            const r = await api.market.offer(l.id, cents);
            toast(t('market.offer.sent'));
            router.push(`/inbox/${r.conversationId}`);
          } catch (e) {
            if (e instanceof ApiError && e.code === 'offer_pending') throw new ApiError(409, 'offer_pending', t('market.offer.pending'));
            throw e;
          }
        }}
      />
      {l.rating?.otherUser ? (
        <RateSheet
          open={rating}
          onClose={() => setRating(false)}
          listingId={l.id}
          name={l.rating.otherUser.displayName}
          onRated={() => setListing({ ...l, rating: { ...l.rating!, canRate: false, rated: true } })}
        />
      ) : null}
      <MarkSheet
        listing={l}
        status={marking}
        onClose={() => setMarking(null)}
        onDone={async (text) => {
          await load();
          toast(text);
          setSaid(text);
        }}
      />
      <ReportSheet target={reporting ? { type: 'listing', id: l.id } : null} onClose={() => setReporting(false)} />
    </div>
  );
}

/** Photos one at a time, with arrows (buttons and the keyboard) and a row of thumbnails. */
function Gallery({ photos, title }: { photos: MarketPhoto[]; title: string }) {
  const { t } = useSession();
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const label = useId();
  if (!photos.length)
    return (
      <div className="market-gallery market-gallery--none" aria-hidden>
        <Icon name="bag" size={40} />
      </div>
    );
  const i = Math.min(index, photos.length - 1);
  const photo = photos[i]!;
  const go = (by: number) => setIndex((cur) => (cur + by + photos.length) % photos.length);
  const alt = photo.altText || t('market.gallery.alt', { title, n: i + 1, count: photos.length });
  return (
    <div
      ref={box}
      className="market-gallery"
      role="group"
      aria-roledescription={t('market.gallery.role')}
      aria-labelledby={label}
      tabIndex={photos.length > 1 ? 0 : undefined}
      onKeyDown={(e) => {
        if (photos.length < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        // In a right-to-left layout the next photo is to the left.
        const rtl = box.current ? getComputedStyle(box.current).direction === 'rtl' : false;
        go((e.key === 'ArrowRight') !== rtl ? 1 : -1);
      }}
    >
      <span id={label} className="yp-visually-hidden">
        {t('market.gallery.label', { title })}
      </span>
      <div className="market-gallery__stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url} alt={alt} width={photo.width ?? undefined} height={photo.height ?? undefined} />
        {photos.length > 1 ? (
          <>
            <button type="button" className="market-gallery__nav market-gallery__nav--prev" aria-label={t('market.gallery.prev')} onClick={() => go(-1)}>
              <Icon name="chevron-left" size={22} />
            </button>
            <button type="button" className="market-gallery__nav market-gallery__nav--next" aria-label={t('market.gallery.next')} onClick={() => go(1)}>
              <Icon name="chevron-right" size={22} />
            </button>
            <span className="market-gallery__count" aria-live="polite">
              {t('market.gallery.position', { n: i + 1, count: photos.length })}
            </span>
          </>
        ) : null}
      </div>
      {photos.length > 1 ? (
        <ul className="market-gallery__thumbs">
          {photos.map((p, n) => (
            <li key={p.mediaId}>
              <button
                type="button"
                className="market-gallery__thumb"
                aria-current={n === i ? true : undefined}
                aria-label={t('market.gallery.show', { n: n + 1, count: photos.length })}
                onClick={() => setIndex(n)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.thumbUrl || p.url} alt="" loading="lazy" decoding="async" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** For the seller: notes (waiting for a check, ending soon, ended) and what they can do with their listing. */
function OwnerPanel({
  listing: l,
  daysLeft,
  busy,
  onRenew,
  onAvailable,
  onMark,
  onDelete,
}: {
  listing: MarketListingDetail;
  daysLeft: number;
  busy: string | null;
  onRenew: () => void;
  onAvailable: () => void;
  onMark: (s: 'reserved' | 'sold') => void;
  onDelete: () => void;
}) {
  const { t, tp } = useSession();
  return (
    <section className="market-owner stack-sm" aria-labelledby="market-owner-title">
      <h2 id="market-owner-title" className="section-title" style={{ margin: 0 }}>
        {t('market.owner.title')}
      </h2>
      {l.moderation === 'review' ? (
        <Alert tone="info" title={t('market.review.title')}>
          {l.reviewReason ? t(REVIEW_REASON[l.reviewReason]) : t('market.review.body')}
        </Alert>
      ) : l.moderation === 'restricted' ? (
        <Alert tone="warning">{t('market.review.restricted')}</Alert>
      ) : null}
      {l.expired && l.status !== 'sold' ? (
        <Alert tone="info">{t('market.owner.expired')}</Alert>
      ) : l.status !== 'sold' ? (
        <p className="muted" style={{ margin: 0 }}>
          {daysLeft > 0 ? tp('market.owner.daysLeft', daysLeft) : t('market.owner.endsToday')}
        </p>
      ) : null}
      <p style={{ margin: 0 }}>{t('market.owner.statusNow', { status: statusLabel(t, l.status) })}</p>
      <div className="row">
        {l.status !== 'sold' ? (
          <Link href={`/market/${l.id}/edit`} className="yp-btn yp-btn--secondary">
            {t('market.owner.edit')}
          </Link>
        ) : null}
        {l.canRenew ? (
          <Button loading={busy === 'renew'} onClick={onRenew}>
            {t('market.owner.renew')}
          </Button>
        ) : null}
        {l.status !== 'available' ? (
          <Button variant="secondary" loading={busy === 'available'} onClick={onAvailable}>
            {t('market.owner.markAvailable')}
          </Button>
        ) : null}
        {l.status === 'available' && !l.expired ? (
          <Button variant="secondary" onClick={() => onMark('reserved')}>
            {t('market.owner.markReserved')}
          </Button>
        ) : null}
        {l.status !== 'sold' ? (
          <Button variant="secondary" onClick={() => onMark('sold')}>
            {t('market.owner.markSold')}
          </Button>
        ) : null}
        <Button variant="danger" loading={busy === 'delete'} onClick={onDelete}>
          {t('market.owner.delete')}
        </Button>
      </div>
    </section>
  );
}

/** Reserved for, or sold to: one of the people who wrote about it, or someone else. */
function MarkSheet({
  listing,
  status,
  onClose,
  onDone,
}: {
  listing: MarketListingDetail;
  status: 'reserved' | 'sold' | null;
  onClose: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const { t, toast } = useSession();
  const buyers = listing.buyers ?? [];
  const [pick, setPick] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const name = useId();
  useEffect(() => {
    if (status) setPick(buyers[0]?.id ?? 'else');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const sold = status === 'sold';
  return (
    <BottomSheet open={!!status} onClose={onClose} title={sold ? t('market.mark.soldTitle') : t('market.mark.reservedTitle')}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!status) return;
          setBusy(true);
          try {
            const buyer = buyers.find((b) => b.id === pick) ?? null;
            await api.market.setStatus(listing.id, status, buyer?.id ?? null);
            onClose();
            await onDone(
              buyer
                ? sold
                  ? t('market.chat.markedSold', { name: buyer.displayName })
                  : t('market.chat.markedReserved', { name: buyer.displayName })
                : sold
                  ? t('market.owner.markedSold')
                  : t('market.owner.markedReserved'),
            );
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="chat-radio">
          <legend className="yp-field__label">{sold ? t('market.mark.soldWho') : t('market.mark.reservedWho')}</legend>
          <div className="stack" style={{ gap: 8 }}>
            {buyers.map((b) => (
              <label key={b.id} className={`chat-game-option${pick === b.id ? ' chat-game-option--on' : ''}`}>
                <input type="radio" name={name} value={b.id} checked={pick === b.id} onChange={() => setPick(b.id)} />
                <bdi>{b.displayName}</bdi>
              </label>
            ))}
            <label className={`chat-game-option${pick === 'else' ? ' chat-game-option--on' : ''}`}>
              <input type="radio" name={name} value="else" checked={pick === 'else'} onChange={() => setPick('else')} />
              <span>{t('market.mark.someoneElse')}</span>
            </label>
          </div>
        </fieldset>
        <p className="muted market-sheet__note">{sold ? t('market.mark.soldNote') : t('market.mark.reservedNote')}</p>
        <Button type="submit" block loading={busy}>
          {sold ? t('market.owner.markSold') : t('market.owner.markReserved')}
        </Button>
      </form>
    </BottomSheet>
  );
}

/** What someone without an account sees from a shared link. */
function PublicListing({ preview: p }: { preview: PublicListingPreview }) {
  const { t, locale } = useSession();
  return (
    <div className="yp-shell__inner market market-listing">
      {p.imageUrl ? (
        <div className="market-gallery">
          <div className="market-gallery__stage">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.imageUrl} alt={t('market.gallery.alt', { title: p.title, n: 1, count: 1 })} />
          </div>
        </div>
      ) : null}
      <header className="stack-sm">
        <p className="market-listing__price">{priceText(t, locale, p.priceCents, p.currency)}</p>
        <h1 className="market-listing__title" dir="auto">
          {p.title}
        </h1>
        <p className="market-listing__badges">
          <StatusBadge status={p.status} />
          <Badge>{conditionLabel(t, p.condition)}</Badge>
          <Badge>{categoryLabel(t, p.category)}</Badge>
        </p>
        <p className="market-listing__where">
          <Icon name="map-pin" size={16} /> <span dir="auto">{p.area}</span>
        </p>
        {p.seller ? (
          <p className="muted" style={{ margin: 0 }}>
            <Link href={`/u/${p.seller.username}`}>{t('market.public.by', { name: p.seller.displayName })}</Link>
          </p>
        ) : null}
      </header>
      {p.excerpt ? (
        <p className="market-listing__description" dir="auto">
          {p.excerpt}
        </p>
      ) : null}
      <SafetyTips />
      <JoinNote text={t('market.public.join')} />
    </div>
  );
}
