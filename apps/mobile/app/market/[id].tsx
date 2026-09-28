import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Alert, Image, Platform, Pressable, RefreshControl, ScrollView, Share, Text, useWindowDimensions, View } from 'react-native';
import { ApiError } from '../../../../packages/api-client/src/index';
import { MARKET_LISTING_DAYS, marketDaysLeft, type MarketListingDetail, type MarketPhoto } from '../../../../packages/shared/src/market';
import type { PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl, webUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import {
  AmountSheet,
  CATEGORY_KEYS,
  CONDITION_KEYS,
  currentNear,
  DELIVERY_KEYS,
  priceText,
  RateSheet,
  SafetyTips,
  SellerCardView,
  STATUS_KEYS,
  StatusBadge,
  whereText,
} from '../../lib/market';
import { useReport } from '../../lib/report';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, Icon, Loading, Notice, useActionSheet, useColors, userText } from '../../lib/ui';

/**
 * A Market listing: its photos (with the seller's descriptions for screen readers), price,
 * condition, where (the area, or about how far), how it changes hands, the description and the
 * seller card, with the safety tips. Others can message the seller, make an offer, save, share or
 * report it; the seller edits it, marks it available, reserved or sold (to someone who wrote about
 * it, or someone else), renews it and deletes it. After a sale each side can rate the other once.
 */
export default function ListingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const tr = useT();
  const { t, tp, date } = tr;
  const { me } = useSession();
  const [listing, setListing] = useState<MarketListingDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const menu = useActionSheet();
  const report = useReport();

  const load = useCallback(async () => {
    try {
      const near = currentNear();
      setListing((await (await client()).market.get(id, near ?? undefined)).listing);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setListing(null);
      else {
        setListing((cur) => cur ?? null);
        setError(errorMessage(e));
      }
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // What an action did, or why it didn't work, is read out: the notes appear further down.
  const said = error ?? note;
  useEffect(() => {
    if (said) AccessibilityInfo.announceForAccessibility(said);
  }, [said]);

  if (listing === undefined) return <Loading />;
  if (listing === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <Stack.Screen options={{ title: t('m.market.listing') }} />
        <EmptyState icon="pricetag-outline" title={t('m.market.missing')} body={error ?? t('m.market.missingBody')} />
      </View>
    );

  const l = listing;
  const price = priceText(tr, l.priceCents, l.currency);
  const webPath = `/market/${encodeURIComponent(l.id)}`;
  const open = l.status !== 'sold' && !l.expired;
  const daysLeft = marketDaysLeft(l.expiresAt);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const merge = (next: Partial<MarketListingDetail>) => setListing((cur) => (cur ? { ...cur, ...next } : cur));

  async function share() {
    const url = `${webUrl}${webPath}`;
    try {
      await Share.share(Platform.OS === 'ios' ? { url, message: l.title } : { message: `${l.title}\n${url}`, title: l.title });
    } catch {
      // The person closed the share sheet.
    }
  }

  async function message() {
    await act(async () => {
      const r = await (await client()).market.message(l.id);
      router.push(`/chat/${r.conversationId}`);
    });
  }

  async function offer(amountCents: number) {
    try {
      const r = await (await client()).market.offer(l.id, amountCents);
      router.push(`/chat/${r.conversationId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) throw new Error(t('m.market.offerPending'));
      throw e;
    }
  }

  async function toggleSave() {
    await act(async () => {
      const api = await client();
      if (l.saved) await api.market.unsave(l.id);
      else await api.market.save(l.id);
      merge({ saved: !l.saved });
      AccessibilityInfo.announceForAccessibility(t(l.saved ? 'm.market.unsavedNote' : 'm.market.savedNote'));
    });
  }

  function setStatus(status: 'available' | 'reserved' | 'sold', buyer: PublicUser | null) {
    void act(
      async () => {
        const r = await (await client()).market.setStatus(l.id, status, buyer?.id ?? null);
        merge(r.listing);
        await load();
      },
      t('m.market.statusChanged', { status: t(STATUS_KEYS[status]) }),
    );
  }

  /** Reserved for, or sold to: one of the people who wrote about it, or someone else. */
  function chooseBuyer(status: 'reserved' | 'sold') {
    const buyers = l.buyers ?? [];
    if (!buyers.length) return setStatus(status, null);
    menu.show({
      title: t(status === 'sold' ? 'm.market.markSold' : 'm.market.markReserved'),
      message: t('m.market.chooseBuyerBody'),
      actions: [
        ...buyers.map((b) => ({ label: b.displayName, icon: 'person-outline' as const, onPress: () => setStatus(status, b) })),
        { label: t('m.market.someoneElse'), icon: 'people-outline' as const, onPress: () => setStatus(status, null) },
      ],
    });
  }

  function remove() {
    Alert.alert(t('m.market.delete'), t('m.market.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: () =>
          void act(async () => {
            await (await client()).market.remove(l.id);
            AccessibilityInfo.announceForAccessibility(t('m.market.deleted'));
            if (router.canGoBack()) router.back();
            else router.replace('/market/mine');
          }),
      },
    ]);
  }

  const contactNote =
    l.contactBlock === 'minor_protection'
      ? t('m.market.contact.minor')
      : l.contactBlock === 'blocked'
        ? t('m.market.contact.blocked')
        : l.contactBlock === 'unavailable'
          ? t('m.market.contact.unavailable')
          : null;
  const details: [string, string][] = [
    [t('m.market.details.condition'), t(CONDITION_KEYS[l.condition])],
    [t('m.market.details.category'), t(CATEGORY_KEYS[l.category])],
    [t('m.market.details.delivery'), l.delivery.map((d) => t(DELIVERY_KEYS[d])).join(', ')],
    [t('m.market.details.where'), l.where.distanceKm !== null ? `${l.where.area} · ${whereText(tr, l.where)}` : l.where.area],
    [t('m.market.details.status'), l.expired ? t('m.market.ended') : t(STATUS_KEYS[l.status])],
  ];

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      refreshControl={
        <RefreshControl
          tintColor={c.yapi}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen
        options={{
          title: t('m.market.listing'),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.post.more')}
              hitSlop={10}
              style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
              onPress={() =>
                menu.show({
                  title: l.title,
                  actions: [
                    { label: t('m.common.share'), icon: 'share-outline' as const, onPress: () => void share() },
                    ...(l.mine
                      ? [
                          {
                            label: t('m.market.edit'),
                            icon: 'create-outline' as const,
                            onPress: () => router.push(`/market-edit?id=${encodeURIComponent(l.id)}`),
                          },
                          { label: t('m.market.delete'), icon: 'trash-outline' as const, destructive: true, onPress: remove },
                        ]
                      : me
                        ? [
                            {
                              label: t('m.market.report'),
                              icon: 'flag-outline' as const,
                              destructive: true,
                              onPress: () => report.open({ type: 'listing', id: l.id, authorId: l.seller.id, authorName: l.seller.displayName }),
                            },
                          ]
                        : []),
                  ],
                })
              }
            >
              <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
            </Pressable>
          ),
        }}
      />
      {menu.sheet}
      {report.sheet}

      <PhotoPager photos={l.photos} title={l.title} />

      <View style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 }, userText]}>
          {l.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' }}>
          <Text style={{ color: c.ink, fontSize: 22, fontWeight: '800' }}>{price}</Text>
          <StatusBadge status={l.status} expired={l.expired} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
          <Icon name="location-outline" size={16} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 14 }, userText]}>{whereText(tr, l.where)}</Text>
        </View>
      </View>

      {l.forYou ? <Notice title={t(l.status === 'sold' ? 'm.market.forYou.sold' : 'm.market.forYou.reserved')}>{t('m.market.forYou.body')}</Notice> : null}
      {l.mine && l.moderation === 'review' ? <Notice tone="warn">{t('m.market.review')}</Notice> : null}
      {l.mine && l.moderation === 'restricted' ? <Notice tone="warn">{t('m.market.restricted')}</Notice> : null}
      {l.expired ? <Notice>{l.mine ? t('m.market.expiredMine') : t('m.market.expired')}</Notice> : null}
      {l.mine && !l.expired && l.status !== 'sold' ? (
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>
          {tp('m.market.endsIn', daysLeft)} · {date(l.expiresAt, { dateStyle: 'medium' })}
        </Text>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {note ? <Notice>{note}</Notice> : null}

      {!l.mine ? (
        <View style={{ gap: space[2] }}>
          {l.canContact && open ? (
            <>
              <Button label={l.conversationId ? t('m.market.openChat') : t('m.market.message')} icon="chatbubble-outline" onPress={message} />
              {l.priceCents !== null ? <Button label={t('m.market.offer')} icon="cash-outline" variant="secondary" onPress={() => setOfferOpen(true)} /> : null}
            </>
          ) : l.conversationId ? (
            <Button label={t('m.market.openChat')} icon="chatbubble-outline" variant="secondary" onPress={() => router.push(`/chat/${l.conversationId}`)} />
          ) : null}
          {contactNote && l.contactBlock !== 'self' ? <Notice>{contactNote}</Notice> : null}
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(l.saved ? 'm.market.unsave' : 'm.market.save')}
              accessibilityState={{ selected: l.saved }}
              onPress={() => void toggleSave()}
              style={({ pressed }) => [actionStyle(c.line), { opacity: pressed ? 0.8 : 1 }]}
            >
              <Icon name={l.saved ? 'bookmark' : 'bookmark-outline'} size={20} color={c.yapi} />
              <Text style={{ color: c.ink, fontWeight: '700' }}>{t(l.saved ? 'm.market.savedLabel' : 'm.market.save')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.common.share')}
              onPress={() => void share()}
              style={({ pressed }) => [actionStyle(c.line), { opacity: pressed ? 0.8 : 1 }]}
            >
              <Icon name="share-outline" size={20} color={c.yapi} />
              <Text style={{ color: c.ink, fontWeight: '700' }}>{t('m.common.share')}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ gap: space[2] }}>
          <Button
            label={t('m.market.edit')}
            icon="create-outline"
            variant="secondary"
            onPress={() => router.push(`/market-edit?id=${encodeURIComponent(l.id)}`)}
          />
          {!l.expired ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {l.status !== 'available' ? (
                <Button label={t('m.market.markAvailable')} size="sm" variant="secondary" onPress={() => setStatus('available', null)} />
              ) : null}
              {l.status === 'available' ? (
                <Button label={t('m.market.markReserved')} size="sm" variant="secondary" onPress={() => chooseBuyer('reserved')} />
              ) : null}
              {l.status !== 'sold' ? <Button label={t('m.market.markSold')} size="sm" variant="secondary" onPress={() => chooseBuyer('sold')} /> : null}
            </View>
          ) : null}
          {l.canRenew ? (
            <Button
              label={t('m.market.renew', { days: MARKET_LISTING_DAYS })}
              icon="refresh"
              onPress={() =>
                act(async () => {
                  merge((await (await client()).market.renew(l.id)).listing);
                }, t('m.market.renewed'))
              }
            />
          ) : null}
          <Button label={t('m.market.delete')} icon="trash-outline" variant="ghost" onPress={remove} />
        </View>
      )}

      {l.rating?.otherUser && (l.rating.canRate || l.rating.rated) ? (
        l.rating.canRate ? (
          <Button
            label={t('m.market.rate', { name: l.rating.otherUser.displayName })}
            icon="star-outline"
            variant="secondary"
            onPress={() => setRateOpen(true)}
          />
        ) : (
          <Text style={{ color: c.inkMuted }}>{t('m.market.ratedAlready', { name: l.rating.otherUser.displayName })}</Text>
        )
      ) : null}

      <View style={{ gap: space[1], padding: space[3], borderRadius: radius.md, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
        {details.map(([label, value]) => (
          <View key={label} accessible accessibilityLabel={`${label}: ${value}`} style={{ flexDirection: 'row', gap: space[3], paddingVertical: space[1] }}>
            <Text style={{ color: c.inkMuted, width: 120 }}>{label}</Text>
            <Text style={[{ color: c.ink, fontWeight: '600', flex: 1 }, userText]}>{value}</Text>
          </View>
        ))}
      </View>

      {l.description ? (
        <View style={{ gap: space[1] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.market.description')}
          </Text>
          <Text selectable style={[{ color: c.ink, fontSize: 15, lineHeight: 22 }, userText]}>
            {l.description}
          </Text>
        </View>
      ) : null}

      <View style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('m.market.seller')}
        </Text>
        <SellerCardView card={l.sellerCard} />
      </View>

      <SafetyTips />

      <AmountSheet
        visible={offerOpen}
        title={t('m.market.offerTitle')}
        sendLabel={t('m.market.offerSend')}
        currency={l.currency}
        hint={t('m.market.offerHint', { price })}
        onClose={() => setOfferOpen(false)}
        onSend={offer}
      />
      {l.rating?.otherUser ? (
        <RateSheet
          visible={rateOpen}
          listingId={l.id}
          name={l.rating.otherUser.displayName}
          onClose={() => setRateOpen(false)}
          onRated={() => {
            merge({ rating: { ...l.rating!, canRate: false, rated: true } });
            setNote(t('m.market.rated'));
          }}
        />
      ) : null}
    </ScrollView>
  );
}

const actionStyle = (line: string) =>
  ({
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: line,
  }) as const;

/** The photos, one at a time, swiped sideways, with where you are ("2 of 5") and each photo's description. */
function PhotoPager({ photos, title }: { photos: MarketPhoto[]; title: string }) {
  const c = useColors();
  const { t } = useT();
  const { width: screen } = useWindowDimensions();
  const [width, setWidth] = useState(screen - space[4] * 2);
  const [index, setIndex] = useState(0);
  if (!photos.length)
    return (
      <View
        style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: radius.lg, backgroundColor: c.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="pricetag-outline" size={40} color={c.inkMuted} />
      </View>
    );
  return (
    <View onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))} style={{ gap: space[2] }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setIndex(Math.max(0, Math.min(photos.length - 1, Math.round(Math.abs(e.nativeEvent.contentOffset.x) / width))))}
        style={{ borderRadius: radius.lg, backgroundColor: c.surfaceSunken }}
      >
        {photos.map((p, i) => (
          <Image
            key={p.mediaId}
            source={{ uri: mediaUrl(p.url) }}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel={`${p.altText || t('m.market.photoAlt', { title })}. ${t('m.market.photoOf', { n: i + 1, total: photos.length })}`}
            accessibilityIgnoresInvertColors
            style={{ width, aspectRatio: 1 }}
          />
        ))}
      </ScrollView>
      {photos.length > 1 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}
        >
          {photos.map((p, i) => (
            <View key={p.mediaId} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i === index ? c.yapi : c.lineStrong }} />
          ))}
          <Text style={{ color: c.inkMuted, fontSize: 12, marginStart: space[2] }}>{t('m.market.photoOf', { n: index + 1, total: photos.length })}</Text>
        </View>
      ) : null}
    </View>
  );
}
