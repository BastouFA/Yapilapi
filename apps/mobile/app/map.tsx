import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, FlatList, Keyboard, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import {
  byDistance,
  MAP_DEFAULT_ZOOM,
  MAP_LAYERS,
  MAP_PRESENCE_DURATIONS,
  MAP_PRESENCE_KEYS,
  queryBox,
  viewBox,
  type MapAnswer,
  type MapCluster,
  type MapLayer,
  type MapPresence,
  type MapPresenceDuration,
} from '../../../packages/shared/src/city-map';
import { clockTime, type LatLng } from '../../../packages/shared/src/location';
import { client, errorMessage } from '../lib/api';
import { CityMapView, LayerChip, MapItemRow, PinCard, readHere } from '../lib/city-map';
import { useFlag } from '../lib/flags';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { BottomSheet, Button, EmptyState, ErrorState, Icon, Loading, Notice, Segmented, useColors, userText } from '../lib/ui';

/**
 * Near you (docs/product/city-map.md): what's on around here right now, on a map or as a list,
 * nearest first. It starts where you are when location was allowed before, else your profile's
 * city, else a city search; "Use my location" asks first. Only the box on screen goes to the
 * server, never your position, except through "Show me on the map to friends" (signed in), which
 * sends a point the server rounds to about a kilometre. Signed in, "Ask a question" asks the city
 * about the part of the map on screen (only its middle, on a 2 km grid, is kept).
 */

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};
const isOff = (e: unknown) => e instanceof ApiError && e.code === 'feature_disabled';

export default function MapScreen() {
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const win = useWindowDimensions();

  const [start, setStart] = useState<'loading' | 'search' | 'ready'>('loading');
  const [off, setOff] = useState<string | null>(null);
  const [here, setHere] = useState<LatLng | null>(null);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [zoom, setZoom] = useState(MAP_DEFAULT_ZOOM);
  const [size, setSize] = useState({ width: win.width, height: Math.round(win.height * 0.55) });
  const [hidden, setHidden] = useState<MapLayer[]>([]);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [answer, setAnswer] = useState<MapAnswer | null>(null);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<MapCluster | null>(null);
  const [city, setCity] = useState('');
  const [cityError, setCityError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  // Questions (Ask the city) are left out while that feature is off.
  const askOn = useFlag('ASK_CITY') !== false;
  const offered = MAP_LAYERS.filter((l) => (l !== 'friends' || !!me) && (l !== 'questions' || askOn));
  const layers = offered.filter((l) => !hidden.includes(l));
  const layersKey = layers.join(',');

  // Where to start: here when location was allowed before (no prompt), else the profile's city, else a search.
  const grantedAtOpen = useRef(false);
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const p = await readHere(false);
        if (gone) return;
        grantedAtOpen.current = true;
        setHere(p);
        setCenter(p);
        setStart('ready');
        return;
      } catch {
        // Not allowed (or not known): start from the profile's city instead.
      }
      try {
        const r = await (await client()).map.center();
        if (gone) return;
        if (r.center) {
          setCenter(r.center.center);
          setStart('ready');
        } else setStart('search');
      } catch (e) {
        if (gone) return;
        if (isOff(e)) setOff(errorMessage(e));
        else setStart('search');
      }
    })();
    return () => {
      gone = true;
    };
  }, []);

  // What's in the box on screen, once the map has settled for a moment.
  const run = useRef(0);
  useEffect(() => {
    if (!center || off) return;
    const mine = ++run.current;
    const timer = setTimeout(() => {
      if (!layersKey) {
        setAnswer({ items: [], more: [] });
        setLoadError(null);
        return;
      }
      setFetching(true);
      void (async () => {
        try {
          const r = await (await client()).map.items(queryBox(viewBox(center, zoom, size.width, size.height)), layersKey.split(',') as MapLayer[], timeZone());
          if (mine !== run.current) return;
          setAnswer(r);
          setLoadError(null);
        } catch (e) {
          if (mine !== run.current) return;
          if (isOff(e)) setOff(errorMessage(e));
          else setLoadError(errorMessage(e));
        } finally {
          if (mine === run.current) setFetching(false);
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [center, zoom, size.width, size.height, layersKey, off, retry]);

  // "Show me on the map to friends": yours, and moved to where you are when the map opens with location allowed.
  const [presence, setPresence] = useState<MapPresence | null | undefined>(undefined);
  const [presenceSheet, setPresenceSheet] = useState(false);
  const [presenceBusy, setPresenceBusy] = useState<MapPresenceDuration | null>(null);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  useEffect(() => {
    setPresence(undefined);
    if (!me) return;
    let gone = false;
    void client()
      .then((api) => api.map.presence())
      .then(
        (r) => !gone && setPresence(r.presence),
        () => !gone && setPresence(null),
      );
    return () => {
      gone = true;
    };
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const moved = useRef(false);
  useEffect(() => {
    if (!presence || !here || !grantedAtOpen.current || moved.current) return;
    moved.current = true;
    void client()
      .then((api) => api.map.showMe({ lat: here.lat, lng: here.lng }))
      .then(
        (r) => setPresence(r.presence),
        () => {},
      );
  }, [presence, here]);
  useEffect(() => {
    if (!presence) return;
    const timer = setTimeout(() => setPresence(null), Math.max(0, new Date(presence.endsAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [presence]);

  const where = (e: unknown) => (e === 'denied' ? t('m.market.nearby.denied') : e === 'unavailable' ? t('location.unavailable') : errorMessage(e));

  async function locate() {
    setLocating(true);
    setLocateError(null);
    try {
      const p = await readHere(true);
      setHere(p);
      setCenter(p);
      setSelected(null);
      setStart('ready');
    } catch (e) {
      setLocateError(where(e));
    } finally {
      setLocating(false);
    }
  }

  async function searchCity() {
    const q = city.trim();
    if (!q) return;
    setCityError(null);
    try {
      const r = await (await client()).map.center(q);
      if (!r.center) return setCityError(t('map.cityNotFound'));
      Keyboard.dismiss();
      setCenter(r.center.center);
      setZoom(MAP_DEFAULT_ZOOM);
      setSelected(null);
      setStart('ready');
    } catch (e) {
      if (isOff(e)) setOff(errorMessage(e));
      else setCityError(errorMessage(e));
    }
  }

  async function showMe(duration: MapPresenceDuration) {
    setPresenceBusy(duration);
    setPresenceError(null);
    try {
      const p = await readHere(true);
      setHere(p);
      const r = await (await client()).map.showMe({ lat: p.lat, lng: p.lng, duration, timeZone: timeZone() });
      moved.current = true;
      setPresence(r.presence);
      setPresenceSheet(false);
      AccessibilityInfo.announceForAccessibility(t('map.presence.on', { time: clockTime(r.presence.endsAt, locale) }));
    } catch (e) {
      setPresenceError(where(e));
    } finally {
      setPresenceBusy(null);
    }
  }

  async function stopShowing() {
    setPresenceError(null);
    try {
      await (await client()).map.stop();
      setPresence(null);
    } catch (e) {
      setPresenceError(errorMessage(e));
    }
  }

  const onMove = useCallback((p: LatLng) => setCenter(p), []);

  if (off) return <EmptyState title={t('map.title')} body={off} icon="map-outline" />;
  if (start === 'loading') return <Loading />;

  const items = answer?.items ?? [];

  const search = (
    <View style={{ gap: space[1] }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          minHeight: 44,
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: cityError ? c.danger : c.line,
          backgroundColor: c.surface,
          paddingStart: space[4],
        }}
      >
        <Icon name="search" size={18} color={c.inkMuted} />
        <TextInput
          accessibilityLabel={t('map.searchCity')}
          accessibilityHint={cityError ?? undefined}
          placeholder={t('map.searchCity')}
          placeholderTextColor={c.inkMuted}
          value={city}
          onChangeText={(v) => {
            setCity(v);
            setCityError(null);
          }}
          onSubmitEditing={() => void searchCity()}
          returnKeyType="search"
          autoCorrect={false}
          maxLength={100}
          style={[{ flex: 1, color: c.ink, fontSize: 16, paddingVertical: space[2] }, userText]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('map.searchCity')}
          disabled={!city.trim()}
          onPress={() => void searchCity()}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: city.trim() ? 1 : 0.45 }}
        >
          <Icon name="arrow-forward" size={20} color={c.yapi} directional />
        </Pressable>
      </View>
      {cityError ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontSize: 13, fontWeight: '600' }}>
          {cityError}
        </Text>
      ) : null}
    </View>
  );

  const useLocation = here ? null : (
    <View style={{ gap: space[1] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <Button
          label={locating ? t('location.locating') : t('map.useLocation')}
          icon="locate-outline"
          size="sm"
          variant="secondary"
          disabled={locating}
          accessibilityLabel={t('map.useLocation')}
          onPress={() => locate()}
        />
        <Text style={{ flex: 1, color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>{t('map.locationWhy')}</Text>
      </View>
      {locateError ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontSize: 13, fontWeight: '600' }}>
          {locateError}
        </Text>
      ) : null}
    </View>
  );

  if (start === 'search' || !center)
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4] }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 22 }}>{t('map.hint')}</Text>
        {search}
        {useLocation}
      </ScrollView>
    );

  const from = here ?? center;
  const presenceRow = !me ? null : presence ? (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        padding: space[2],
        paddingStart: space[3],
        borderRadius: radius.md,
        backgroundColor: c.yapiSoft,
      }}
    >
      <Icon name="people" size={20} color={c.yapi} />
      <Text style={{ flex: 1, color: c.ink, fontSize: 14, fontWeight: '600' }}>{t('map.presence.on', { time: clockTime(presence.endsAt, locale) })}</Text>
      <Button label={t('location.stop')} size="sm" variant="danger" onPress={() => stopShowing()} />
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('map.presence.title')}
      accessibilityHint={t('map.presence.hint')}
      disabled={presence === undefined}
      onPress={() => {
        setPresenceError(null);
        setPresenceSheet(true);
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 44,
        paddingHorizontal: space[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: pressed ? c.surfaceSunken : c.surface,
        opacity: presence === undefined ? 0.45 : 1,
      })}
    >
      <Icon name="people-outline" size={20} color={c.inkMuted} />
      <Text style={{ flex: 1, color: c.ink, fontSize: 14, fontWeight: '600' }}>{t('map.presence.title')}</Text>
      <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
    </Pressable>
  );

  const notices = (
    <>
      {loadError ? <ErrorState message={loadError} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {!loadError && answer?.more.length ? <Notice>{t('map.more')}</Notice> : null}
      {!loadError && answer && !items.length ? <Notice>{t('map.empty')}</Notice> : null}
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <View style={{ paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[2], gap: space[2] }}>
        {search}
        {useLocation}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityLabel={t('map.layers')}
          contentContainerStyle={{ gap: space[2], paddingVertical: 4 }}
        >
          {offered.map((l) => (
            <LayerChip
              key={l}
              layer={l}
              on={!hidden.includes(l)}
              onPress={() => {
                setSelected(null);
                setHidden((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
              }}
            />
          ))}
        </ScrollView>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <View style={{ flex: 1 }}>
            <Segmented
              options={[
                { id: 'map', label: t('map.view.map') },
                { id: 'list', label: t('map.view.list') },
              ]}
              value={view}
              onChange={(v) => {
                setSelected(null);
                setView(v);
              }}
            />
          </View>
          {fetching ? <ActivityIndicator size="small" color={c.yapi} /> : null}
        </View>
        {presenceRow}
        {me && askOn ? (
          <Button
            label={t('askCity.ask')}
            icon="help-circle-outline"
            size="sm"
            variant="secondary"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => {
              const b = queryBox(viewBox(center, zoom, size.width, size.height));
              router.push({
                pathname: '/ask',
                params: { ask: '1', south: String(b.south), west: String(b.west), north: String(b.north), east: String(b.east) },
              });
            }}
          />
        ) : null}
        {presenceError && !presenceSheet ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontSize: 13, fontWeight: '600' }}>
            {presenceError}
          </Text>
        ) : null}
      </View>

      {view === 'map' ? (
        <View style={{ flex: 1 }}>
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
            onMove={onMove}
            onZoom={(z) => {
              setSelected(null);
              setZoom(z);
            }}
            onSelect={setSelected}
            onLocate={() => {
              if (here) {
                setCenter(here);
                setSelected(null);
              } else void locate();
            }}
            locateHint={here ? undefined : t('map.locationWhy')}
          />
          <View pointerEvents="box-none" style={{ position: 'absolute', top: space[3], start: space[3], end: 44 + space[3] * 2, gap: space[2] }}>
            {notices}
          </View>
          {selected ? <PinCard cluster={selected} from={from} onClose={() => setSelected(null)} /> : null}
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: space[2], paddingBottom: space[6] }}
          data={byDistance(items, from)}
          keyExtractor={(item) => item.key}
          ListHeaderComponent={<View style={{ paddingHorizontal: space[2], gap: space[2], paddingBottom: space[2] }}>{notices}</View>}
          renderItem={({ item }) => <MapItemRow item={item} from={from} />}
          ListEmptyComponent={answer ? null : <Loading />}
        />
      )}

      <BottomSheet visible={presenceSheet} onClose={() => setPresenceSheet(false)} title={t('map.presence.title')}>
        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('map.presence.hint')}</Text>
        {MAP_PRESENCE_DURATIONS.map((d) => (
          <Button
            key={d}
            label={presenceBusy === d ? t('location.locating') : t(MAP_PRESENCE_KEYS[d])}
            accessibilityLabel={`${t('map.presence.title')}: ${t(MAP_PRESENCE_KEYS[d])}`}
            icon="time-outline"
            variant="secondary"
            disabled={!!presenceBusy}
            onPress={() => showMe(d)}
          />
        ))}
        {presenceError ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.danger, lineHeight: 20 }}>
            {presenceError}
          </Text>
        ) : null}
      </BottomSheet>
    </View>
  );
}
