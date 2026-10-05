import { router } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { MarketChatCard, MarketOffer, MarketOfferStatus } from '../../../packages/shared/src/market';
import type { Message } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import { AmountSheet, priceText, RateSheet, SafetyTips } from './market';
import { radius, space } from './theme';
import { Icon, useColors, userText, type IconName } from './ui';

/**
 * Market in a chat (mobile): the card at the top of a chat about a listing, and offer cards. The
 * seller marks the listing reserved for, or sold to, the buyer in this chat from the card; after
 * the sale each side can rate the other. Offers are answered from their card (accept, decline, or
 * another amount), and the one who made an offer can withdraw it while it waits. Cards change in
 * place from the responses and from `market.updated` on the realtime socket (app/chat/[id].tsx).
 */

const OFFER_STATUS: Record<MarketOfferStatus, MessageKey> = {
  pending: 'm.market.offer.status.pending',
  accepted: 'm.market.offer.status.accepted',
  declined: 'm.market.offer.status.declined',
  countered: 'm.market.offer.status.countered',
  withdrawn: 'm.market.offer.status.withdrawn',
};

/** A button on a card in a bubble: outlined in the bubble's text colour, 44 points tall. */
function CardButton({ label, icon, tint, onPress, strong }: { label: string; icon: IconName; tint: string; onPress: () => unknown; strong?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await onPress();
        } finally {
          setBusy(false);
        }
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[1],
        paddingHorizontal: space[3],
        borderRadius: radius.full,
        borderWidth: strong ? 2 : 1,
        borderColor: tint,
        opacity: busy ? 0.6 : pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={18} color={tint} />
      <Text style={{ color: tint, fontSize: 14, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

/** The listing a chat is about: photo, title, price, where it stands, and the seller's and rating actions. */
export function ListingChatCard({
  card,
  tint,
  onCard,
  onNote,
}: {
  card: MarketChatCard;
  tint: string;
  onCard: (card: MarketChatCard) => void;
  onNote: (text: string, failed?: boolean) => void;
}) {
  const tr = useT();
  const { t } = tr;
  const c = useColors();
  const [rateOpen, setRateOpen] = useState(false);
  const l = card.listing;
  const other = card.you === 'seller' ? card.buyer : card.seller;
  const price = priceText(tr, l.priceCents, l.currency);
  const state = !l.available
    ? t('m.market.unavailable')
    : card.soldToBuyer
      ? card.you === 'buyer'
        ? t('m.market.forYou.sold')
        : t('m.market.card.soldTo', { name: card.buyer.displayName })
      : card.reservedForBuyer
        ? card.you === 'buyer'
          ? t('m.market.forYou.reserved')
          : t('m.market.card.reservedFor', { name: card.buyer.displayName })
        : l.status === 'sold'
          ? t('m.market.status.sold')
          : l.status === 'reserved'
            ? t('m.market.status.reserved')
            : l.expired
              ? t('m.market.ended')
              : null;

  async function mark(status: 'reserved' | 'sold') {
    try {
      const r = await (await client()).market.setStatus(l.id, status, card.buyer.id);
      onCard({
        ...card,
        listing: { ...l, status: r.listing.status },
        reservedForBuyer: status === 'reserved',
        soldToBuyer: status === 'sold',
        canMarkReserved: false,
        canMarkSold: status !== 'sold',
        canRate: status === 'sold' ? !card.rated : card.canRate,
      });
      onNote(t(status === 'sold' ? 'm.market.card.soldTo' : 'm.market.card.reservedFor', { name: card.buyer.displayName }));
    } catch (e) {
      onNote(errorMessage(e), true);
    }
  }

  const summary = (
    <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center', minHeight: 44 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: c.surfaceSunken,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {l.photoUrl && l.available ? (
          <Image source={{ uri: mediaUrl(l.photoUrl) }} style={{ width: 56, height: 56 }} accessible={false} accessibilityIgnoresInvertColors />
        ) : (
          <Icon name="pricetag-outline" size={22} color={c.inkMuted} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[{ color: tint, fontWeight: '800', fontSize: 15 }, userText]} numberOfLines={2}>
          {l.title}
        </Text>
        {l.available ? <Text style={{ color: tint, fontWeight: '700', fontSize: 14 }}>{price}</Text> : null}
        {state ? (
          <Text accessibilityLiveRegion="polite" style={{ color: tint, fontSize: 13, opacity: 0.9 }}>
            {state}
          </Text>
        ) : null}
      </View>
      {l.available ? <Icon name="chevron-forward" size={18} color={tint} directional /> : null}
    </View>
  );

  return (
    <View style={{ gap: space[2], minWidth: 240 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="pricetag-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>{t('m.market.card.kind')}</Text>
      </View>
      {l.available ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={[t('m.market.card.open', { title: l.title }), price, state].filter(Boolean).join(', ')}
          onPress={() => router.push(`/market/${l.id}`)}
        >
          {summary}
        </Pressable>
      ) : (
        summary
      )}
      {l.available && (card.canMarkReserved || card.canMarkSold || card.canRate) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {card.you === 'seller' && card.canMarkReserved ? (
            <CardButton label={t('m.market.markReserved')} icon="time-outline" tint={tint} onPress={() => mark('reserved')} />
          ) : null}
          {card.you === 'seller' && card.canMarkSold ? (
            <CardButton
              label={t('m.market.card.markSoldTo', { name: card.buyer.displayName })}
              icon="checkmark-done-outline"
              tint={tint}
              onPress={() => mark('sold')}
              strong
            />
          ) : null}
          {card.canRate ? (
            <CardButton label={t('m.market.rate', { name: other.displayName })} icon="star-outline" tint={tint} onPress={() => setRateOpen(true)} />
          ) : null}
        </View>
      ) : null}
      {card.rated ? <Text style={{ color: tint, fontSize: 13, opacity: 0.9 }}>{t('m.market.ratedAlready', { name: other.displayName })}</Text> : null}
      <SafetyTips compact tint={tint} />
      <RateSheet
        visible={rateOpen}
        listingId={l.id}
        name={other.displayName}
        onClose={() => setRateOpen(false)}
        onRated={() => {
          onCard({ ...card, canRate: false, rated: true });
          onNote(t('m.market.rated'));
        }}
      />
    </View>
  );
}

/** An offer (or a counter-offer): the amount, who made it, where it stands, and Accept, Decline, Counter or Withdraw. */
export function OfferChatCard({
  offer,
  meId,
  tint,
  onOffer,
  onAppend,
  onNote,
}: {
  offer: MarketOffer;
  meId: string | undefined;
  tint: string;
  onOffer: (offer: MarketOffer) => void;
  /** A counter-offer is a new card in the chat. */
  onAppend: (message: Message) => void;
  onNote: (text: string, failed?: boolean) => void;
}) {
  const tr = useT();
  const { t } = tr;
  const [counterOpen, setCounterOpen] = useState(false);
  const iAmBuyer = offer.buyer.id === meId;
  const mine = (offer.madeBy === 'buyer') === iAmBuyer;
  const who = mine
    ? offer.madeBy === 'seller'
      ? t('m.market.offer.yourCounter')
      : t('m.market.offer.you')
    : offer.madeBy === 'seller'
      ? t('m.market.offer.counterFrom', { name: offer.seller.displayName })
      : t('m.market.offer.them', { name: offer.buyer.displayName });
  const amount = priceText(tr, offer.amountCents, offer.currency);
  const status = t(OFFER_STATUS[offer.status]);

  async function run(fn: () => Promise<{ offer: MarketOffer; message?: Message }>, done: string) {
    try {
      const r = await fn();
      onOffer(r.offer);
      if (r.message) onAppend(r.message);
      onNote(done);
    } catch (e) {
      // Only an offer already answered is "changed"; a listing that sold or ended says so in the API's words.
      onNote(e instanceof ApiError && e.code === 'offer_closed' ? t('m.market.offer.changed') : errorMessage(e), true);
    }
  }

  return (
    <View style={{ gap: space[2], minWidth: 240 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="cash-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>{who}</Text>
      </View>
      <Text style={{ color: tint, fontSize: 22, fontWeight: '800' }}>{amount}</Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('m.market.card.open', { title: offer.listing.title })}
        disabled={!offer.listing.available}
        onPress={() => router.push(`/market/${offer.listingId}`)}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={[{ color: tint, fontSize: 13, opacity: 0.9 }, userText]} numberOfLines={1}>
          {offer.listing.title}
        </Text>
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={{ color: tint, fontSize: 13, fontWeight: '700' }}>
        {status}
      </Text>
      {offer.canRespond || offer.canWithdraw ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {offer.canRespond ? (
            <>
              <CardButton
                label={t('m.common.accept')}
                icon="checkmark"
                tint={tint}
                strong
                onPress={() => run(async () => (await client()).market.acceptOffer(offer.id), t('m.market.offer.status.accepted'))}
              />
              <CardButton
                label={t('m.common.decline')}
                icon="close"
                tint={tint}
                onPress={() => run(async () => (await client()).market.declineOffer(offer.id), t('m.market.offer.status.declined'))}
              />
              <CardButton label={t('m.market.offer.counter')} icon="swap-horizontal" tint={tint} onPress={() => setCounterOpen(true)} />
            </>
          ) : null}
          {offer.canWithdraw ? (
            <CardButton
              label={t('m.market.offer.withdraw')}
              icon="arrow-undo-outline"
              tint={tint}
              onPress={() => run(async () => (await client()).market.withdrawOffer(offer.id), t('m.market.offer.status.withdrawn'))}
            />
          ) : null}
        </View>
      ) : null}
      <AmountSheet
        visible={counterOpen}
        title={t('m.market.counterTitle')}
        sendLabel={t('m.market.counterSend')}
        currency={offer.currency}
        hint={t('m.market.counterHint', { amount })}
        onClose={() => setCounterOpen(false)}
        onSend={async (cents) => {
          const r = await (await client()).market.counterOffer(offer.id, cents);
          // `r.offer` is the new counter-offer, which has its own card in `r.message`; this card is
          // the one answered (market.updated says so too).
          onOffer({ ...offer, status: 'countered', canRespond: false, canWithdraw: false, respondedAt: offer.respondedAt ?? new Date().toISOString() });
          onAppend(r.message);
          onNote(t('m.market.offer.status.countered'));
        }}
      />
    </View>
  );
}
