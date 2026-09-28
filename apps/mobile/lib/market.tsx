import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { formatMoney } from '../../../packages/shared/src/i18n';
import { approximatePoint, type LatLng } from '../../../packages/shared/src/location';
import {
  MARKET_RATING_TEXT_MAX,
  type MarketCategory,
  type MarketCondition,
  type MarketDelivery,
  type MarketListing,
  type MarketMe,
  type MarketProfile,
  type MarketProhibited,
  type MarketRating,
  type MarketSellerCard,
  type MarketStatus,
  type MarketWhere,
} from '../../../packages/shared/src/market';
import type { NotificationItem } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { StarPicker, Stars } from './forms';
import { useT, type Translator } from './i18n';
import { radius, space } from './theme';
import { Avatar, BottomSheet, Button, EmptyState, Field, Icon, Notice, SkeletonList, useColors, userText } from './ui';

/**
 * Market on the phone: people selling and buying used and local things near them, person to person.
 * Nothing is paid in the app; people meet and pay in person, so the listing and the chat card carry
 * plain safety tips. The screens are app/market/* and app/market-edit.tsx; the chat cards are in
 * lib/chat-market.tsx.
 *
 * Places: this build has no location module (expo-location isn't installed). Where the platform
 * itself offers a position (navigator.geolocation), "Nearby" reads it once when asked, snaps it to
 * about a kilometre on the phone (approximatePoint) and keeps it in memory only for this session;
 * otherwise browsing is by newest in your country and listings carry their area text.
 */

// ── Words ───────────────────────────────────────────────────────────────

export const CATEGORY_KEYS: Record<MarketCategory, MessageKey> = {
  electronics: 'm.market.category.electronics',
  phones: 'm.market.category.phones',
  computers: 'm.market.category.computers',
  home: 'm.market.category.home',
  furniture: 'm.market.category.furniture',
  appliances: 'm.market.category.appliances',
  clothing: 'm.market.category.clothing',
  shoes_bags: 'm.market.category.shoesBags',
  beauty: 'm.market.category.beauty',
  baby_kids: 'm.market.category.babyKids',
  toys_games: 'm.market.category.toysGames',
  sports: 'm.market.category.sports',
  books: 'm.market.category.books',
  music: 'm.market.category.music',
  vehicles: 'm.market.category.vehicles',
  bikes: 'm.market.category.bikes',
  tools: 'm.market.category.tools',
  garden: 'm.market.category.garden',
  art_crafts: 'm.market.category.artCrafts',
  other: 'm.market.category.other',
};

export const CONDITION_KEYS: Record<MarketCondition, MessageKey> = {
  new: 'm.market.condition.new',
  like_new: 'm.market.condition.likeNew',
  good: 'm.market.condition.good',
  fair: 'm.market.condition.fair',
};

export const DELIVERY_KEYS: Record<MarketDelivery, MessageKey> = {
  pickup: 'm.market.delivery.pickup',
  seller_delivers: 'm.market.delivery.sellerDelivers',
  shipping: 'm.market.delivery.shipping',
};

export const STATUS_KEYS: Record<MarketStatus, MessageKey> = {
  available: 'm.market.status.available',
  reserved: 'm.market.status.reserved',
  sold: 'm.market.status.sold',
};

export const PROHIBITED_KEYS: Record<MarketProhibited, MessageKey> = {
  weapons: 'm.market.prohibited.weapons',
  drugs: 'm.market.prohibited.drugs',
  animals: 'm.market.prohibited.animals',
  alcohol: 'm.market.prohibited.alcohol',
  tobacco: 'm.market.prohibited.tobacco',
  adult: 'm.market.prohibited.adult',
  counterfeit: 'm.market.prohibited.counterfeit',
  recalled: 'm.market.prohibited.recalled',
  medicines: 'm.market.prohibited.medicines',
};

/** "₦5,000.00", or "Free". */
export function priceText({ t, locale }: Pick<Translator, 't' | 'locale'>, priceCents: number | null, currency: string): string {
  if (priceCents === null) return t('m.market.free');
  try {
    return formatMoney(priceCents, currency, locale);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${currency}`;
  }
}

/** "About 3 km away" when both sides gave a place, otherwise the pickup area. */
export function whereText({ tp }: Pick<Translator, 'tp'>, where: MarketWhere): string {
  return where.distanceKm !== null ? tp('m.market.away', where.distanceKm) : where.area;
}

/** Whole units typed by a person ("2500", "2 500", "2500.50") as hundredths, or null when it isn't a positive amount. */
export function parseAmount(text: string): number | null {
  const clean = text.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(parseFloat(clean) * 100);
  return cents > 0 ? cents : null;
}

// ── Where you are (in memory only) ──────────────────────────────────────

type Geo = {
  getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void, fail: (e: { code: number }) => void, o?: object) => void;
};

/** The platform's own position reader, when this build has one (React Native doesn't by default). */
export function marketGeolocation(): Geo | null {
  const nav = (globalThis as { navigator?: { geolocation?: Geo } }).navigator;
  return nav?.geolocation && typeof nav.geolocation.getCurrentPosition === 'function' ? nav.geolocation : null;
}

/** Your approximate place for this session: never saved on the phone, gone when the app closes. */
let approximateHere: LatLng | null = null;
export const currentNear = () => approximateHere;

/** Read the position once, snap it to about a kilometre, and keep it in memory. Rejects with 'unsupported', 'denied' or 'unavailable'. */
export function readApproximatePlace(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    const geo = marketGeolocation();
    if (!geo) return reject('unsupported');
    geo.getCurrentPosition(
      (p) => {
        approximateHere = approximatePoint({ lat: p.coords.latitude, lng: p.coords.longitude });
        resolve(approximateHere);
      },
      (e) => reject(e.code === 1 ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 60_000 },
    );
  });
}

/** What went wrong reading the position, in words. */
export function placeProblem(t: Translator['t'], e: unknown): string {
  if (e === 'denied') return t('m.market.nearby.denied');
  if (e === 'unavailable') return t('m.market.nearby.unavailable');
  if (e === 'unsupported') return t('m.market.nearby.needsUpdate');
  return errorMessage(e);
}

// ── What you can do ─────────────────────────────────────────────────────

/** Your currency and whether you can sell; null while it loads (or when it couldn't). */
export function useMarketMe() {
  const [me, setMe] = useState<MarketMe | null>(null);
  const load = useCallback(async () => {
    try {
      setMe((await (await client()).market.me()).market);
    } catch {
      // Browsing works without it; selling asks again.
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { me, reload: load };
}

/** Why you can't sell, calmly: under 18, or no date of birth on the account yet. */
export function SellBlockNote({ block }: { block: MarketMe['sellBlock'] }) {
  const { t } = useT();
  if (!block) return null;
  return <Notice>{block === 'birth_date_required' ? t('m.market.birthDateRequired') : t('m.market.adultsOnly')}</Notice>;
}

// ── Pieces of a listing ─────────────────────────────────────────────────

/** Reserved or sold, as a small badge on a photo or a card. */
export function StatusBadge({ status, expired }: { status: MarketStatus; expired?: boolean }) {
  const c = useColors();
  const { t } = useT();
  if (status === 'available' && !expired) return null;
  const text = status === 'sold' ? t('m.market.status.sold') : status === 'reserved' ? t('m.market.status.reserved') : t('m.market.ended');
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: status === 'reserved' ? c.saffronSoft : c.surfaceSunken,
        borderRadius: radius.full,
        paddingHorizontal: space[2],
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: c.ink, fontSize: 12, fontWeight: '800' }}>{text}</Text>
    </View>
  );
}

/** One listing in a grid: photo, price (or Free), title, how far or where, and Reserved/Sold. Opens the listing. */
export function ListingTile({ listing, width }: { listing: MarketListing; width: number }) {
  const c = useColors();
  const tr = useT();
  const { t } = tr;
  const photo = listing.photos[0];
  const price = priceText(tr, listing.priceCents, listing.currency);
  const where = whereText(tr, listing.where);
  const state = listing.status !== 'available' ? t(STATUS_KEYS[listing.status]) : listing.expired ? t('m.market.ended') : null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={[listing.title, price, where, state].filter(Boolean).join(', ')}
      onPress={() => router.push(`/market/${listing.id}`)}
      style={({ pressed }) => ({ width, gap: space[1], opacity: pressed ? 0.85 : 1 })}
    >
      <View style={{ width, aspectRatio: 1, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.surfaceSunken }}>
        {photo ? (
          <Image
            source={{ uri: mediaUrl(photo.thumbUrl || photo.url) }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
            accessible={false}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="pricetag-outline" size={28} color={c.inkMuted} />
          </View>
        )}
        {state ? (
          <View style={{ position: 'absolute', top: space[2], start: space[2] }}>
            <StatusBadge status={listing.status} expired={listing.expired} />
          </View>
        ) : null}
      </View>
      <Text style={{ color: c.ink, fontWeight: '800', fontSize: 15 }} numberOfLines={1}>
        {price}
      </Text>
      <Text style={[{ color: c.ink, fontSize: 14 }, userText]} numberOfLines={2}>
        {listing.title}
      </Text>
      <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
        {where}
      </Text>
    </Pressable>
  );
}

/** Listings in two columns, filling the width it's given (start to end, so it follows right-to-left). */
export function ListingGrid({ items }: { items: MarketListing[] }) {
  const [width, setWidth] = useState(0);
  const gap = space[3];
  const tile = width ? Math.floor((width - gap) / 2) : 0;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {tile ? items.map((l) => <ListingTile key={l.id} listing={l} width={tile} />) : null}
    </View>
  );
}

/** The safety tips: in full on the listing page, as one line in a chat card. */
export function SafetyTips({ compact, tint }: { compact?: boolean; tint?: string }) {
  const c = useColors();
  const { t } = useT();
  const color = tint ?? c.ink;
  if (compact)
    return (
      <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'flex-start' }}>
        <Icon name="shield-checkmark-outline" size={14} color={color} />
        <Text style={{ color, fontSize: 12, lineHeight: 17, flex: 1, opacity: 0.9 }}>{t('m.market.safety.short')}</Text>
      </View>
    );
  const tips: MessageKey[] = ['m.market.safety.public', 'm.market.safety.check', 'm.market.safety.advance', 'm.market.safety.inPerson'];
  return (
    <View style={{ gap: space[2], padding: space[3], borderRadius: radius.md, backgroundColor: c.yapiSoft }}>
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center' }}>
        <Icon name="shield-checkmark-outline" size={18} color={c.ink} />
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 15 }}>
          {t('m.market.safety.title')}
        </Text>
      </View>
      {tips.map((k) => (
        <View key={k} style={{ flexDirection: 'row', gap: space[2] }}>
          <Text style={{ color: c.ink }} accessibilityElementsHidden importantForAccessibility="no">
            •
          </Text>
          <Text style={{ color: c.ink, lineHeight: 20, flex: 1 }}>{t(k)}</Text>
        </View>
      ))}
    </View>
  );
}

/** "4.8 out of 5 from 12 ratings", or "No ratings yet". */
export function ratingText({ t, tp, number }: Pick<Translator, 't' | 'tp' | 'number'>, rating: { average: number | null; count: number }): string {
  if (rating.average === null || !rating.count) return t('m.market.noRatings');
  return tp('m.market.ratings', rating.count, { average: number(rating.average, { maximumFractionDigits: 1 }) });
}

/** Who sells it: name, on YAPILAPI since, rating, how often they answer, how many sold. Opens their profile. */
export function SellerCardView({ card }: { card: MarketSellerCard }) {
  const c = useColors();
  const tr = useT();
  const { t, tp, date } = tr;
  const lines = [
    t('m.market.memberSince', { date: date(card.memberSince, { month: 'long', year: 'numeric' }) }),
    ratingText(tr, card.rating),
    card.responseRate !== null ? t('m.market.responseRate', { rate: card.responseRate }) : null,
    tp('m.market.soldCount', card.sold),
  ].filter((x): x is string => !!x);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={[card.user.displayName, ...lines].join(', ')}
      onPress={() => router.push(`/u/${encodeURIComponent(card.user.username)}?tab=market`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: space[3],
        alignItems: 'center',
        padding: space[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Avatar name={card.user.displayName} url={card.user.avatarUrl} size={48} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[{ color: c.ink, fontWeight: '800', fontSize: 15 }, userText]} numberOfLines={1}>
          {card.user.displayName}
        </Text>
        {card.rating.average !== null && card.rating.count ? <Stars rating={card.rating.average} size={14} /> : null}
        {lines.map((l) => (
          <Text key={l} style={{ color: c.inkMuted, fontSize: 13 }}>
            {l}
          </Text>
        ))}
      </View>
      <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
    </Pressable>
  );
}

// ── Sheets ──────────────────────────────────────────────────────────────

/** An amount in the listing's currency, for an offer or a counter-offer. */
export function AmountSheet({
  visible,
  title,
  sendLabel,
  currency,
  hint,
  onClose,
  onSend,
}: {
  visible: boolean;
  title: string;
  sendLabel: string;
  currency: string;
  hint?: string;
  onClose: () => void;
  /** Resolves once sent (the sheet closes); throws to show the problem. */
  onSend: (amountCents: number) => Promise<unknown>;
}) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (visible) {
      setText('');
      setError(null);
    }
  }, [visible]);
  const send = async () => {
    const cents = parseAmount(text);
    if (cents === null) return setError(t('m.market.amountInvalid'));
    setError(null);
    try {
      await onSend(cents);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <BottomSheet visible={visible} title={title} subtitle={hint} onClose={onClose}>
      <Field
        label={t('m.market.amount', { currency })}
        value={text}
        onChangeText={setText}
        keyboardType="decimal-pad"
        inputMode="decimal"
        autoFocus
        maxLength={16}
        error={error}
        onSubmitEditing={() => void send()}
      />
      <Button label={sendLabel} icon="send" disabled={!text.trim()} onPress={send} />
    </BottomSheet>
  );
}

/** Rate the other person after a sale: 1 to 5 stars (each a labelled button) and a few words if you like. */
export function RateSheet({
  visible,
  listingId,
  name,
  onClose,
  onRated,
}: {
  visible: boolean;
  listingId: string;
  name: string;
  onClose: () => void;
  onRated: (r: MarketRating) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [stars, setStars] = useState(0);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (visible) {
      setStars(0);
      setBody('');
      setError(null);
    }
  }, [visible]);
  return (
    <BottomSheet visible={visible} title={t('m.market.rate', { name })} onClose={onClose}>
      <StarPicker label={t('m.market.rateStars')} value={stars} onChange={setStars} />
      <Field
        label={t('m.market.rateBody')}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={MARKET_RATING_TEXT_MAX}
        style={{ minHeight: 80, paddingTop: space[2], textAlignVertical: 'top' }}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger }}>
          {error}
        </Text>
      ) : null}
      <Button
        label={t('m.market.rateSend')}
        disabled={!stars}
        onPress={async () => {
          try {
            const r = await (await client()).market.rate(listingId, { stars, body: body.trim() || undefined });
            onRated(r.rating);
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}

// ── On a profile ────────────────────────────────────────────────────────

/** One rating: stars, who, for what, when, and what they said. */
function RatingRow({ rating }: { rating: MarketRating }) {
  const c = useColors();
  const { t, date } = useT();
  return (
    <View style={{ gap: space[1], padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Avatar name={rating.rater.displayName} url={rating.rater.avatarUrl} size={28} />
        <Text style={[{ color: c.ink, fontWeight: '700', flex: 1 }, userText]} numberOfLines={1}>
          {rating.rater.displayName}
        </Text>
        <Stars rating={rating.stars} size={14} />
      </View>
      <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
        {t(rating.raterRole === 'buyer' ? 'm.market.rating.bought' : 'm.market.rating.sold', { title: rating.listingTitle })} ·{' '}
        {date(rating.createdAt, { dateStyle: 'medium' })}
      </Text>
      {rating.body ? <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{rating.body}</Text> : null}
    </View>
  );
}

/** A profile's Market tab: the seller card, what's for sale, and what people said about buying and selling with them. */
export function ProfileMarket({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const c = useColors();
  const tr = useT();
  const { t } = tr;
  const [data, setData] = useState<MarketProfile | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client()
      .then((api) => api.market.profile(userId))
      .then(
        (r) => current && setData(r.market),
        (e) => current && (setData(null), setError(errorMessage(e))),
      );
    return () => {
      current = false;
    };
  }, [userId]);
  if (data === undefined) return <SkeletonList count={3} />;
  if (!data) return error ? <Notice tone="danger">{error}</Notice> : null;
  return (
    <View style={{ gap: space[4], paddingTop: space[2] }}>
      {isSelf ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          <Button label={t('m.market.yours')} size="sm" variant="secondary" icon="pricetags-outline" onPress={() => router.push('/market/mine')} />
          <Button label={t('m.market.title')} size="sm" variant="ghost" icon="storefront-outline" onPress={() => router.push('/market')} />
        </View>
      ) : null}
      <SellerCardView card={data.seller} />
      <View style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('m.market.profile.forSale')}
        </Text>
        {data.listings.length ? <ListingGrid items={data.listings} /> : <Text style={{ color: c.inkMuted }}>{t('m.market.profile.empty')}</Text>}
      </View>
      <View style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('m.market.profile.ratings')}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.market.profile.asBuyer', { rating: ratingText(tr, data.asBuyer) })}</Text>
        {data.ratings.length ? (
          data.ratings.map((r) => <RatingRow key={r.id} rating={r} />)
        ) : (
          <EmptyState icon="star-outline" title={t('m.market.noRatings')} />
        )}
      </View>
    </View>
  );
}

// ── Notifications ───────────────────────────────────────────────────────

/** What a Market notification says, or null for other kinds. */
export function marketNoticeText(n: NotificationItem, t: Translator['t'], tp: Translator['tp']): string | null {
  const name = n.actor?.displayName ?? '';
  const title = typeof n.data.title === 'string' ? n.data.title : '';
  switch (n.type) {
    case 'market_offer':
      return t('m.market.notif.offer', { name, title });
    case 'market_offer_accepted':
      return t('m.market.notif.offerAccepted', { name, title });
    case 'market_offer_declined':
      return t('m.market.notif.offerDeclined', { name, title });
    case 'market_offer_countered':
      return t('m.market.notif.offerCountered', { name, title });
    case 'market_sold_to_you':
      return t('m.market.notif.soldToYou', { name, title });
    case 'market_rated':
      return t('m.market.notif.rated', { name, title });
    case 'market_expiring':
      return tp('m.market.notif.expiring', Math.max(1, Number(n.data.days) || 1), { title });
    case 'market_expired':
      return t('m.market.notif.expired', { title });
  }
  return null;
}
