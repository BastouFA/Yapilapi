import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
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
} from '../../../packages/shared/src/city-map';
import type { LatLng } from '../../../packages/shared/src/location';
import { LAUNCH_CITIES } from '../../../packages/shared/src/stash';
import { client, errorMessage } from './api';
import { CityMapView, LAYER_ICONS, MapItemRow, PinCard, readHere } from './city-map';
import { useFlag } from './flags';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { Button, Icon, Notice, SkeletonList, useColors } from './ui';

/** "What's on now", in this order, a few of each (the nearest first). */
const SECTIONS: MapLayer[] = ['stashes', 'live', 'today', 'places', 'questions', 'market'];
const PER_SECTION = 4;
const MAP_HEIGHT = 300;

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/**
 * The top of Wander (docs/product/your-city-alive.md, "The menu"): the city map around you, with
 * the Stashes layer and the others, and what's on now (stashes near you, lives, events tonight,
 * busy places, open questions and Market nearby). Where you are is read only when allowed before
 * or after a tap on "Use my location", and stays on the phone; without it, your profile's city, or
 * a launch city. Only the part of the map on screen goes to the server. A new `refreshKey` (pull
 * to refresh) asks again.
 */
export function CityNow({ refreshKey = 0 }: { refreshKey?: number }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const win = useWindowDimensions();
  const mapOn = useFlag('CITY_MAP') !== false;
  const live = useFlag('LIVE') === true;
  const ask = useFlag('ASK_CITY') !== false;
  const stash = useFlag('STASH') !== false;
  const [here, setHere] = useState<LatLng | null>(null);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [zoom, setZoom] = useState(MAP_DEFAULT_ZOOM);
  const [size, setSize] = useState({ width: win.width - space[4] * 2, height: MAP_HEIGHT });
  const [answer, setAnswer] = useState<MapAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapCluster | null>(null);
  const [locating, setLocating] = useState(false);

  const layers = MAP_LAYERS.filter(
    (l) => l !== 'friends' && l !== 'chains' && (l !== 'live' || live) && (l !== 'questions' || ask) && (l !== 'stashes' || (stash && !!me)),
  );
  const layersKey = layers.join(',');

  // Where to start: here when allowed before (no prompt), else the profile's city, else Lagos.
  useEffect(() => {
    if (!mapOn) return;
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
  }, [mapOn]);

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
  }, [center, zoom, size.width, size.height, layersKey, refreshKey]);

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

  if (!mapOn) return null;
  const items = answer?.items ?? [];
  const from = here ?? center;
  const sorted = from ? byDistance(items, from) : items;
  const sections = SECTIONS.filter((l) => layers.includes(l))
    .map((l) => ({ layer: l, items: sorted.filter((i) => i.layer === l).slice(0, PER_SECTION) }))
    .filter((s) => s.items.length);

  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 20, fontWeight: '800' }}>
          {t('near.whatsOn')}
        </Text>
        {me && stash ? <Button label={t('stash.hide')} icon="gift-outline" size="sm" onPress={() => router.push('/stash/new')} /> : null}
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

      <View style={{ height: MAP_HEIGHT, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surface }}>
        {center ? (
          <>
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
            {selected && from ? <PinCard cluster={selected} from={from} onClose={() => setSelected(null)} /> : null}
          </>
        ) : null}
      </View>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}

      {center && !answer && !problem ? <SkeletonList count={2} /> : null}
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
            <MapItemRow key={i.key} item={i} from={from ?? i.point} />
          ))}
        </View>
      ))}
      {stash && me ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/stash')}
          style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: space[2] }}
        >
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('stash.near')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
