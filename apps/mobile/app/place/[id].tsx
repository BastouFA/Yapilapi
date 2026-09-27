import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { formatMoney } from '../../../../packages/shared/src/i18n';
import type { EventItem } from '../../../../packages/shared/src/types';
import { client } from '../../lib/api';
import { SectionHeader } from '../../lib/chips';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, Icon, Loading, Row, useColors, userText } from '../../lib/ui';

type PlaceData = { place: Record<string, any>; events: EventItem[]; products: Record<string, any>[] };

/**
 * A place: what it is, where, its hours, what's on there and what it offers. Opened from Wander
 * and from events held there. Buying, booking a table and reviews are on the web for now.
 */
export default function PlaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, locale, dateTime } = useT();
  const [data, setData] = useState<PlaceData | null | undefined>(undefined);

  useEffect(() => {
    void client()
      .then((api) => api.places.get(id))
      .then(setData, () => setData(null));
  }, [id]);

  if (data === undefined) return <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.place.notFound')} />
      </View>
    );

  const { place, events, products } = data;
  const address = [place.address, place.city, place.country].filter(Boolean).join(', ');
  const hours = Object.entries((place.hours ?? {}) as Record<string, string>);
  const hasMap = typeof place.lat === 'number' && typeof place.lng === 'number';

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}>
      <Card style={{ gap: space[2] }}>
        {place.category ? (
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' }}>{String(place.category)}</Text>
        ) : null}
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>
          {String(place.name)}
        </Text>
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
            onPress={() => void Linking.openURL(`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=17/${place.lat}/${place.lng}`)}
          />
        ) : null}
      </Card>

      {hours.length ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('m.place.hours')} />
          <Card style={{ gap: space[1] }}>
            {hours.map(([day, h]) => (
              <View key={day} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space[3] }}>
                <Text style={{ color: c.ink, fontWeight: '600', textTransform: 'capitalize' }}>{day}</Text>
                <Text style={{ color: c.inkMuted }}>{h}</Text>
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
    </ScrollView>
  );
}
