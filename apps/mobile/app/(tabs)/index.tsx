import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import {
  byDistance,
  MAP_DEFAULT_ZOOM,
  MAP_LAYERS,
  MAP_LAYER_KEYS,
  queryBox,
  viewBox,
  type MapAnswer,
  type MapCluster,
  type MapLayer,
} from '../../../../packages/shared/src/city-map';
import type { LatLng } from '../../../../packages/shared/src/location';
import { LAUNCH_CITIES } from '../../../../packages/shared/src/stash';
import { client, errorMessage } from '../../lib/api';
import { CityMapView, LAYER_ICONS, MapItemRow, PinCard, readHere } from '../../lib/city-map';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, Icon, Loading, Notice, useColors, userText } from '../../lib/ui';

/** "What's on now", in this order, a few of each (the nearest first). */
const SECTIONS: MapLayer[] = ['stashes', 'live', 'today', 'places', 'questions', 'market'];
const PER_SECTION = 4;

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/**
 * Near, the first tab of "Your city, alive" (docs/product/your-city-alive.md): the city map around
 * you and what's on now (stashes near you, lives, events tonight, busy places, open questions and
 * Market nearby), with search and Explore at the top. Where you are is read only when allowed
 * before or after a tap on "Use my location", and stays on the phone; without it, your profile's
 * city, or a launch city. Only the part of the map on screen goes to the server.
 */
export default function NearScreen() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const win = useWindowDimensions();
  const live = useFlag('LIVE') === true;
  const ask = useFlag('ASK_CITY') !== false;
  const stash = useFlag('STASH') !== false;
  const [here, setHere] = useState<LatLng | null>(null);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [zoom, setZoom] = useState(MAP_DEFAULT_ZOOM);
  const [size, setSize] = useState({ width: win.width - space[4] * 2, height: 300 });
  const [answer, setAnswer] = useState<MapAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapCluster | null>(null);
  const [locating, setLocating] = useState(false);
  const [q, setQ] = useState('');

  const layers = MAP_LAYERS.filter(
    (l) => l !== 'friends' && l !== 'chains' && (l !== 'live' || live) && (l !== 'questions' || ask) && (l !== 'stashes' || (stash && !!me)),
  );
  const layersKey = layers.join(',');

  // Where to start: here when allowed before (no prompt), else the profile's city, else Lagos.
  useEffect(() => {
    void (async () => {
      try {
        const p = await readHere(false);
        setHere(p);
        setCenter(p);
        return;
      } catch {
        // Not allowed before.
      }
      const r = await client()
        .then((api) => api.map.center())
        .catch(() => null);
      setCenter(r?.center?.center ?? LAUNCH_CITIES[0].center);
    })();
  }, []);

  const run = useRef(0);
  useEffect(() => {
    if (!center) return;
    const mine = ++run.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await (await client()).map.items(queryBox(viewBox(center, zoom, size.width, size.height)), layersKey.split(',') as MapLayer[], timeZone());
          if (mine !== run.current) return;
          setAnswer(r);
          setProblem(null);
        } catch (e) {
          if (mine === run.current) setProblem(errorMessage(e));
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [center, zoom, size.width, size.height, layersKey]);

  const locate = useCallback(async () => {
    setLocating(true);
    try {
      const p = await readHere(true);
      setHere(p);
      setCenter(p);
      setSelected(null);
    } catch {
      setProblem(t('location.unavailable'));
    } finally {
      setLocating(false);
    }
  }, [t]);

  if (!center) return <Loading />;
  const items = answer?.items ?? [];
  const from = here ?? center;
  const sorted = byDistance(items, from);
  const sections = SECTIONS.filter((l) => layers.includes(l))
    .map((l) => ({ layer: l, items: sorted.filter((i) => i.layer === l).slice(0, PER_SECTION) }))
    .filter((s) => s.items.length);
  const search = () => {
    if (q.trim()) router.push({ pathname: '/discover', params: { q: q.trim() } });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: 140 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            minHeight: 44,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: c.line,
            backgroundColor: c.surface,
            paddingStart: space[4],
          }}
        >
          <Icon name="search" size={18} color={c.inkMuted} />
          <TextInput
            accessibilityLabel={t('m.discover.search')}
            placeholder={t('m.discover.search')}
            placeholderTextColor={c.inkMuted}
            value={q}
            onChangeText={setQ}
            onSubmitEditing={search}
            returnKeyType="search"
            maxLength={100}
            style={[{ flex: 1, color: c.ink, fontSize: 16, paddingVertical: space[2] }, userText]}
          />
        </View>
        <Button label={t('near.explore')} icon="compass-outline" size="sm" variant="secondary" onPress={() => router.push('/discover')} />
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 22 }}>{t('near.intro')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] }}>
        {here ? null : (
          <Button
            label={locating ? t('location.locating') : t('map.useLocation')}
            icon="locate-outline"
            size="sm"
            variant="secondary"
            disabled={locating}
            onPress={() => locate()}
          />
        )}
        <Text style={{ color: c.inkMuted }}>{t('near.pickCity')}</Text>
        {LAUNCH_CITIES.map((x) => (
          <Button
            key={x.key}
            label={x.name}
            size="sm"
            variant="ghost"
            onPress={() => {
              setCenter(x.center);
              setSelected(null);
            }}
          />
        ))}
      </View>

      <View style={{ height: 300, borderRadius: radius.lg, overflow: 'hidden' }}>
        <CityMapView
          center={center}
          zoom={zoom}
          size={size}
          items={items}
          here={here}
          selected={selected?.key ?? null}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (width && height && (Math.round(width) !== size.width || Math.round(height) !== size.height))
              setSize({ width: Math.round(width), height: Math.round(height) });
          }}
          onMove={setCenter}
          onZoom={(z) => {
            setSelected(null);
            setZoom(z);
          }}
          onSelect={setSelected}
          onLocate={() => (here ? setCenter(here) : void locate())}
          locateHint={here ? undefined : t('map.locationWhy')}
        />
        {selected ? <PinCard cluster={selected} from={from} onClose={() => setSelected(null)} /> : null}
      </View>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 20, fontWeight: '800' }}>
          {t('near.whatsOn')}
        </Text>
        {me && stash ? <Button label={t('stash.hide')} icon="gift-outline" size="sm" onPress={() => router.push('/stash/new')} /> : null}
      </View>
      {answer && !sections.length ? <Text style={{ color: c.inkMuted }}>{t('near.empty')}</Text> : null}
      {sections.map((s) => (
        <View key={s.layer} style={{ gap: space[1] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Icon name={LAYER_ICONS[s.layer]} size={18} color={c.yapi} />
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 16, fontWeight: '700' }}>
              {t(MAP_LAYER_KEYS[s.layer])}
            </Text>
          </View>
          {s.items.map((i) => (
            <MapItemRow key={i.key} item={i} from={from} />
          ))}
        </View>
      ))}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {stash && me ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => router.push('/stash')}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[2] }}
          >
            <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('stash.near')}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/map')}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[2] }}
        >
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('map.title')}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
