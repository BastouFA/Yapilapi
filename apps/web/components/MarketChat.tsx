'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Icon } from '@yapilapi/design-system';
import type { MarketChatCard, MarketListingCard, MarketOffer, MarketOfferStatus, Message, MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { AmountSheet, priceText, RateSheet, SafetyTips, statusLabel } from './Market';

/**
 * Market cards in a chat about a listing (web). The card at the top shows the listing as it is now
 * (or that it's gone), with plain safety tips; the seller marks it reserved for, or sold to, the
 * buyer from here, and after a sale each side can rate the other. Offers are cards too: the other
 * person accepts, declines or answers with another amount; whoever made one can withdraw it while it
 * waits. Cards change in place from each answer and from `market.updated` events.
 */

/** "Reserved", "Sold", "Ended" or "No longer available"; nothing while it's for sale. */
function ListingState({ listing }: { listing: MarketListingCard }) {
  const { t } = useSession();
  if (!listing.available) return <Badge>{t('market.chat.unavailable')}</Badge>;
  if (listing.expired && listing.status !== 'sold') return <Badge>{t('market.status.ended')}</Badge>;
  if (listing.status === 'available') return null;
  return <Badge tone={listing.status === 'reserved' ? 'warning' : 'neutral'}>{statusLabel(t, listing.status)}</Badge>;
}

/** The listing's photo, title and price, linking to its page while it's there. */
function ListingSummary({ listing }: { listing: MarketListingCard }) {
  const { t, locale } = useSession();
  const inner = (
    <>
      {listing.photoUrl && listing.available ? (
        // The title is right beside it: the photo is decoration here.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="market-chat__photo" src={listing.photoUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="market-chat__photo market-chat__photo--none" aria-hidden>
          <Icon name="bag" size={22} />
        </span>
      )}
      <span className="market-chat__text">
        <span className="market-chat__title" dir="auto">
          {listing.title}
        </span>
        <span className="market-chat__price">{priceText(t, locale, listing.priceCents, listing.currency)}</span>
        <ListingState listing={listing} />
      </span>
    </>
  );
  return listing.available ? (
    <Link href={`/market/${listing.id}`} className="market-chat__summary">
      {inner}
    </Link>
  ) : (
    <span className="market-chat__summary">{inner}</span>
  );
}

/** The card at the top of a chat about a listing. */
export function MarketListingChat({ card, onCard }: { card: MarketChatCard; onCard: (c: MarketChatCard) => void }) {
  const { t, toast } = useSession();
  const [busy, setBusy] = useState<'reserved' | 'sold' | null>(null);
  const [rating, setRating] = useState(false);
  const [said, setSaid] = useState('');
  const other = card.you === 'seller' ? card.buyer : card.seller;
  const seller = card.you === 'seller';

  async function mark(status: 'reserved' | 'sold') {
    setBusy(status);
    try {
      const { listing } = await api.market.setStatus(card.listing.id, status, card.buyer.id);
      const sold = status === 'sold';
      onCard({
        ...card,
        listing: { ...card.listing, status: listing.status },
        reservedForBuyer: !sold,
        soldToBuyer: sold,
        canMarkReserved: false,
        canMarkSold: !sold,
        canRate: sold ? !card.rated : card.canRate,
      });
      const text = sold ? t('market.chat.markedSold', { name: card.buyer.displayName }) : t('market.chat.markedReserved', { name: card.buyer.displayName });
      setSaid(text);
      toast(text);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="market-chat">
      <span className="market-chat__kicker">{t('market.chat.about')}</span>
      <ListingSummary listing={card.listing} />
      {card.soldToBuyer ? (
        <p className="market-chat__status">{seller ? t('market.chat.soldTo', { name: card.buyer.displayName }) : t('market.chat.soldToYou')}</p>
      ) : card.reservedForBuyer ? (
        <p className="market-chat__status">{seller ? t('market.chat.reservedFor', { name: card.buyer.displayName }) : t('market.chat.reservedForYou')}</p>
      ) : null}
      <span className="yp-visually-hidden" role="status">
        {said}
      </span>
      {seller && card.listing.available && (card.canMarkReserved || card.canMarkSold) ? (
        <div className="market-chat__actions">
          {card.canMarkReserved ? (
            <Button size="sm" variant="secondary" loading={busy === 'reserved'} disabled={!!busy} onClick={() => void mark('reserved')}>
              {t('market.chat.markReserved')}
            </Button>
          ) : null}
          {card.canMarkSold ? (
            <Button size="sm" loading={busy === 'sold'} disabled={!!busy} onClick={() => void mark('sold')}>
              {t('market.chat.markSold', { name: card.buyer.displayName })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {card.canRate ? (
        <div className="market-chat__actions">
          <Button size="sm" variant="secondary" icon="star" onClick={() => setRating(true)}>
            {t('market.rate.button', { name: other.displayName })}
          </Button>
        </div>
      ) : card.rated ? (
        <p className="market-chat__status muted">{t('market.rate.rated', { name: other.displayName })}</p>
      ) : null}
      <SafetyTips compact />
      <RateSheet
        open={rating}
        onClose={() => setRating(false)}
        listingId={card.listing.id}
        name={other.displayName}
        onRated={() => onCard({ ...card, canRate: false, rated: true })}
      />
    </div>
  );
}

const OFFER_STATUS: Record<MarketOfferStatus, MessageKey> = {
  pending: 'market.offer.status.pending',
  accepted: 'market.offer.status.accepted',
  declined: 'market.offer.status.declined',
  countered: 'market.offer.status.countered',
  withdrawn: 'market.offer.status.withdrawn',
};

/** An offer (or a counter-offer): the amount, who made it, where it stands, and the answers you can give. */
export function MarketOfferChat({
  offer,
  meId,
  onOffer,
  onMessage,
}: {
  offer: MarketOffer;
  meId?: string;
  onOffer: (o: MarketOffer) => void;
  onMessage: (m: Message) => void;
}) {
  const { t, toast, locale } = useSession();
  const [busy, setBusy] = useState<'accept' | 'decline' | 'withdraw' | null>(null);
  const [countering, setCountering] = useState(false);
  const [said, setSaid] = useState('');
  const maker = offer.madeBy === 'buyer' ? offer.buyer : offer.seller;
  const mine = maker.id === meId;
  const counter = offer.counterOfId !== null;
  const who = mine
    ? counter
      ? t('market.offer.youCountered')
      : t('market.offer.youOffered')
    : counter
      ? t('market.offer.theyCountered', { name: maker.displayName })
      : t('market.offer.theyOffered', { name: maker.displayName });
  const amount = priceText(t, locale, offer.amountCents, offer.currency);

  async function act(kind: 'accept' | 'decline' | 'withdraw') {
    setBusy(kind);
    try {
      const fn = kind === 'accept' ? api.market.acceptOffer : kind === 'decline' ? api.market.declineOffer : api.market.withdrawOffer;
      const r = await fn(offer.id);
      onOffer(r.offer);
      setSaid(t(OFFER_STATUS[r.offer.status]));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`market-offer market-offer--${offer.status}`}>
      <span className="market-chat__kicker">{who}</span>
      <strong className="market-offer__amount">{amount}</strong>
      <span className="market-offer__for" dir="auto">
        {offer.listing.available ? (
          <Link href={`/market/${offer.listing.id}`}>{t('market.offer.for', { title: offer.listing.title })}</Link>
        ) : (
          t('market.offer.for', { title: offer.listing.title })
        )}
      </span>
      <span className="market-offer__status">
        <Badge tone={offer.status === 'accepted' ? 'success' : offer.status === 'pending' ? 'new' : 'neutral'}>{t(OFFER_STATUS[offer.status])}</Badge>
      </span>
      {offer.status === 'accepted' ? <p className="market-chat__status">{t('market.offer.acceptedNote')}</p> : null}
      <span className="yp-visually-hidden" role="status">
        {said}
      </span>
      {offer.canRespond ? (
        <div className="market-chat__actions">
          <Button size="sm" loading={busy === 'accept'} disabled={!!busy} onClick={() => void act('accept')}>
            {t('market.offer.accept')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setCountering(true)}>
            {t('market.offer.counter')}
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'decline'} disabled={!!busy} onClick={() => void act('decline')}>
            {t('market.offer.decline')}
          </Button>
        </div>
      ) : null}
      {offer.canWithdraw ? (
        <div className="market-chat__actions">
          <Button size="sm" variant="ghost" loading={busy === 'withdraw'} disabled={!!busy} onClick={() => void act('withdraw')}>
            {t('market.offer.withdraw')}
          </Button>
        </div>
      ) : null}
      <AmountSheet
        open={countering}
        onClose={() => setCountering(false)}
        title={t('market.offer.counterTitle')}
        intro={t('market.offer.counterIntro', { amount })}
        currency={offer.currency}
        initialCents={offer.amountCents}
        submitLabel={t('market.offer.counterSend')}
        onSubmit={async (cents) => {
          const r = await api.market.counterOffer(offer.id, cents);
          onOffer(r.offer);
          onMessage(r.message);
          setSaid(t('market.offer.counterSent'));
        }}
      />
    </div>
  );
}
