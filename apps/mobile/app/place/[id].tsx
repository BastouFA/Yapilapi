import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { formatMoney } from '../../../../packages/shared/src/i18n-core';
import type { EventItem } from '../../../../packages/shared/src/types';
import { PLACE_CATEGORIES } from '../../../../packages/shared/src/constants';
import type { MessageKey } from '../../../../packages/shared/src/i18n-core';
import { hoursInWeekOrder, hoursKeyLabel } from '../../../../packages/shared/src/scheduling';
import { client, errorMessage, isGone } from '../../lib/api';
import { BookPlace, ManageBookings, MyBookings, PlaceReviews, RatingLine, usePlaceOwner, type ReviewData } from '../../lib/place-extras';
import { SectionHeader } from '../../lib/chips';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, Icon, KeyboardAvoid, Loading, Row, ScreenError, useColors, useRefresh, userText } from '../../lib/ui';

type PlaceData = { place: Record<string, any>; events: EventItem[]; products: Record<string, any>[] };

/**
 * A place: what it is, where, its rating, its hours, what's on there and what it offers. People
 * ask to book a time (places with a business on YAPILAPI) and read and write reviews; the owner
 * confirms or declines bookings here. Buying is on the web for now.
 */
export default function PlaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, locale, dateTime } = useT();
  const [data, setData] = useState<PlaceData | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone; a place already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ReviewData | null>(null);
  const [booked, setBooked] = useState(0);
  const hasBusiness = !!data?.place.business;
  const owner = usePlaceOwner(id, hasBusiness);

  const load = useCallback(async () => {
    try {
      setData(await (await client()).places.get(id));
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setData(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const loadReviews = useCallback(async () => {
    try {
      setReviews(await (await client()).reviews.list(id));
    } catch {
      setReviews({ average: null, count: 0, items: [] });
    }
  }, [id]);
  useEffect(() => {
    void loadReviews();
  }, [loadReviews]);
  const refresh = useRefresh(() => Promise.all([load(), loadReviews()]));

  if (data === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.place.notFound')} action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void load() }} />
      </View>
    );

  const { place, events, products } = data;
  const address = [place.address, place.city, place.country].filter(Boolean).join(', ');
  const hours = hoursInWeekOrder(place.hours as Record<string, unknown> | null);
  const hasMap = typeof place.lat === 'number' && typeof place.lng === 'number';

  return (
    // A review and a booking note are typed low on the page: the keyboard makes room for them.
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        refreshControl={refresh}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      >
        <Card style={{ gap: space[2] }}>
          {place.category ? (
            <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }}>
              {(PLACE_CATEGORIES as readonly string[]).includes(place.category) ? t(`place.category.${place.category}` as MessageKey) : String(place.category)}
            </Text>
          ) : null}
          <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>
            {String(place.name)}
          </Text>
          <RatingLine data={reviews} />
          {address ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Icon name="location-outline" size={16} color={c.inkMuted} />
              <Text style={[{ color: c.inkMuted, flex: 1 }, userText]}>{address}</Text>
            </View>
          ) : null}
          {place.description ? <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 22 }, userText]}>{String(place.description)}</Text> : null}
          {hasMap ? (
            <Button
              label={t('m.place.openMap')}
              icon="map-outline"
              variant="secondary"
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => Linking.openURL(`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=17/${place.lat}/${place.lng}`)}
            />
          ) : null}
        </Card>

        {owner.bookings ? <ManageBookings items={owner.bookings} reload={owner.reload} /> : null}

        {hasBusiness && owner.bookings === false ? (
          <View style={{ gap: space[2] }}>
            <SectionHeader title={t('m.booking.title')} />
            <BookPlace placeId={id} hours={(place.hours ?? null) as Record<string, unknown> | null} onBooked={() => setBooked((n) => n + 1)} />
          </View>
        ) : null}
        {hasBusiness ? <MyBookings placeId={id} version={booked} /> : null}

        {hours.length ? (
          <View style={{ gap: space[2] }}>
            <SectionHeader title={t('m.place.hours')} />
            <Card style={{ gap: space[1] }}>
              {hours.map(([day, h]) => (
                <View key={day} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space[3] }}>
                  <Text style={{ color: c.ink, fontWeight: '600' }}>{hoursKeyLabel(day, locale)}</Text>
                  <Text style={{ color: c.inkMuted }}>{/^\s*closed\s*$/i.test(String(h)) ? t('place.closed') : String(h)}</Text>
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {events.length ? (
          <View style={{ gap: space[2] }}>
            <SectionHeader title={t('m.place.upcoming')} />
            {events.map((e) => (
              <Row
                key={e.id}
                title={e.title}
                subtitle={dateTime(e.startsAt)}
                start={<Icon name="calendar-outline" size={22} color={c.yapi} />}
                onPress={() => router.push(`/event/${e.id}`)}
              />
            ))}
          </View>
        ) : null}

        {products.length ? (
          <View style={{ gap: space[2] }}>
            <SectionHeader title={t('m.place.offers')} />
            {products.map((p) => (
              <Row
                key={String(p.id)}
                title={String(p.title)}
                subtitle={typeof p.priceCents === 'number' && p.currency ? formatMoney(p.priceCents, String(p.currency), locale) : undefined}
              />
            ))}
          </View>
        ) : null}

        <PlaceReviews placeId={id} data={reviews} reload={loadReviews} isOwner={!!owner.bookings} />
      </ScrollView>
    </KeyboardAvoid>
  );
}
