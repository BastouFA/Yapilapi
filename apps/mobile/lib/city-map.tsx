import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Linking, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  clampZoom,
  clusterItems,
  MAP_ATTRIBUTION,
  MAP_ATTRIBUTION_URL,
  MAP_LAYER_KEYS,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_TILE_SIZE,
  MAP_TILE_URL,
  mapDistance,
  panBy,
  screenPoint,
  tilesFor,
  tileUrl,
  type MapCluster,
  type MapItem,
  type MapLayer,
  type MapTarget,
} from '../../../packages/shared/src/city-map';
import { clockTime, distanceMetres, type LatLng } from '../../../packages/shared/src/location';
import { client, mediaUrl, webUrl } from './api';
import { useT } from './i18n';
import { elevation, radius, space } from './theme';
import { Avatar, Button, Field, Icon, useColors, userText, type IconName } from './ui';

/**
 * Near you on the phone (docs/product/city-map.md): the map drawn with React Native's own Image for
 * 256-pixel tiles (no map library), dragged to pan and zoomed with buttons, pins grouped when they
 * are close on screen; the rows the list and the pin cards use; reading where you are; and "Add a place",
 * which puts a post on the map.
 *
 * Where you are stays on the phone: it centres the map and works out distances. Only the box on
 * screen is sent for the map ("Show me on the map to friends" sends a point, rounded by the server).
 */

/** The tiles' address: the build's own provider (extra.mapTileUrl) when it names one, else OpenStreetMap's. */
const TILE_TEMPLATE = ((Constants.expoConfig?.extra ?? {}) as { mapTileUrl?: string }).mapTileUrl ?? MAP_TILE_URL;
/** Tile servers ask apps to say who they are. */
const TILE_HEADERS = { 'User-Agent': `YAPILAPI/${Constants.expoConfig?.version ?? '1'} (+${webUrl})` };

const LAYER_ICONS: Record<MapLayer, IconName> = {
  live: 'radio-outline',
  today: 'calendar-outline',
  market: 'pricetag-outline',
  places: 'flame-outline',
  chains: 'mic-outline',
  questions: 'help-circle-outline',
  friends: 'person-outline',
};

/**
 * Where you are now, or 'denied' / 'unavailable'. With `ask` the permission prompt may show (only
 * after a tap); without it, the position is read only when it was allowed before.
 */
export async function readHere(ask: boolean): Promise<LatLng> {
  const perm = await (ask ? Location.requestForegroundPermissionsAsync() : Location.getForegroundPermissionsAsync()).catch(() => null);
  if (!perm || perm.status !== 'granted') throw 'denied';
  try {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    throw 'unavailable';
  }
}

/** The phone screen an item opens. */
export function openMapTarget(target: MapTarget) {
  switch (target.kind) {
    case 'live':
      return router.push(`/live/${target.id}`);
    case 'event':
      return router.push(`/event/${target.id}`);
    case 'listing':
      return router.push(`/market/${target.id}`);
    case 'place':
      return router.push(`/place/${target.id}`);
    case 'chain':
      return router.push(`/chain/${target.id}`);
    case 'post':
      return router.push(`/p/${target.id}`);
    case 'chat':
      return router.push(`/chat/${target.id}`);
    case 'user':
      return router.push(`/u/${target.username}`);
  }
}

/** The small line under an item's title: its layer, how far, and when (or how many). */
export function useItemMeta() {
  const { t, tp, locale, number, timeAgo } = useT();
  return (item: MapItem, from: LatLng | null): string => {
    const parts = [t(MAP_LAYER_KEYS[item.layer])];
    const far = from ? mapDistance(t, distanceMetres(from, item.point), locale) : null;
    if (far) parts.push(far);
    if (item.approximate) parts.push(t('location.precision.approximate'));
    if (item.layer === 'today' && item.at)
      parts.push(item.endsAt ? `${clockTime(item.at, locale)}–${clockTime(item.endsAt, locale)}` : clockTime(item.at, locale));
    else if (item.layer === 'friends' && item.endsAt) parts.push(t('location.until', { time: clockTime(item.endsAt, locale) }));
    else if (item.layer === 'places' && item.count) parts.push(tp('map.recent', item.count, { count: number(item.count) }));
    else if (item.layer === 'chains' && item.count) parts.push(tp('m.sound.reelCount', item.count, { count: number(item.count) }));
    else if (item.layer === 'questions') parts.push(item.count ? tp('askCity.answers', item.count) : t('askCity.needsAnswer'));
    else if (item.layer === 'live' && item.at) parts.push(timeAgo(item.at));
    return parts.join(' · ');
  };
}

/** What an item is called: its title, or its layer's name when it has none (a spoken question without words). */
export function useItemTitle() {
  const { t } = useT();
  return (item: MapItem) => item.title || t(MAP_LAYER_KEYS[item.layer]);
}

/** One item, in the list and on a pin's card: picture, title, where, and the meta line. Opens the item. */
export function MapItemRow({ item, from }: { item: MapItem; from: LatLng | null }) {
  const c = useColors();
  const meta = useItemMeta();
  const title = useItemTitle()(item);
  const line = meta(item, from);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={[title, item.subtitle, line].filter(Boolean).join(', ')}
      onPress={() => openMapTarget(item.target)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 64,
        paddingVertical: space[2],
        paddingHorizontal: space[3],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      {item.thumbUrl ? (
        <Image source={{ uri: mediaUrl(item.thumbUrl) }} style={{ width: 48, height: 48, borderRadius: radius.sm, backgroundColor: c.surfaceSunken }} />
      ) : item.user ? (
        <Avatar name={item.user.displayName} url={item.user.avatarUrl} size={48} />
      ) : (
        <View style={{ width: 48, height: 48, borderRadius: radius.sm, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={LAYER_ICONS[item.layer]} size={22} color={c.yapi} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
          {title}
        </Text>
        {item.subtitle ? (
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {item.subtitle}
          </Text>
        ) : null}
        <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={2}>
          {line}
        </Text>
      </View>
      <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
    </Pressable>
  );
}

/** A round 44pt button on the map (zoom, where I am). */
function MapButton({ icon, label, hint, onPress, disabled }: { icon: IconName; label: string; hint?: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? c.surfaceSunken : c.surface,
          opacity: disabled ? 0.45 : 1,
        },
        elevation(c),
      ]}
    >
      <Icon name={icon} size={22} color={c.ink} />
    </Pressable>
  );
}

/**
 * The map: tiles around `center` at `zoom`, a pin per group of items close together (a count when
 * there are several), your dot when `here` is known, zoom and "Use my location" buttons, and the
 * tiles' attribution. Dragging moves the centre (`onMove`); a pin calls `onSelect`.
 */
export function CityMapView({
  center,
  zoom,
  size,
  items,
  here,
  selected,
  onLayout,
  onMove,
  onZoom,
  onSelect,
  onLocate,
  locateHint,
}: {
  center: LatLng;
  zoom: number;
  size: { width: number; height: number };
  items: MapItem[];
  here: LatLng | null;
  selected: string | null;
  onLayout: (e: LayoutChangeEvent) => void;
  onMove: (c: LatLng) => void;
  onZoom: (z: number) => void;
  onSelect: (cluster: MapCluster | null) => void;
  onLocate: () => void;
  locateHint?: string;
}) {
  const c = useColors();
  const { t, tp, number, locale } = useT();
  const { width, height } = size;

  // The gesture is made once: it reads the latest centre and zoom from refs.
  const latest = useRef({ center, zoom, onMove });
  latest.current = { center, zoom, onMove };
  const start = useRef(center);
  const pan = useMemo(
    () =>
      PanResponder.create({
        // A tap stays with the pin under the finger; a drag of more than a few points moves the map.
        onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
        onPanResponderGrant: () => {
          start.current = latest.current.center;
        },
        onPanResponderMove: (_e, g) => latest.current.onMove(panBy(start.current, latest.current.zoom, g.dx, g.dy)),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  const tiles = width && height ? tilesFor(center, zoom, width, height) : [];
  const clusters = width && height ? clusterItems(items, center, zoom, width, height) : [];
  const you = here && width && height ? screenPoint(here, center, zoom, width, height) : null;
  const meta = useItemMeta();
  const titleOf = useItemTitle();
  const from = here ?? center;

  return (
    <View onLayout={onLayout} style={{ flex: 1, overflow: 'hidden', backgroundColor: c.surfaceSunken }} {...pan.panHandlers}>
      {/* The pictures: screen readers use the list, so they're left out here. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={StyleSheet.absoluteFill}>
        {tiles.map((tile) => (
          <Image
            // The same tile keeps its image while the map moves (the world is far wider than a screen from zoom 10).
            key={`${tile.z}/${tile.x}/${tile.y}`}
            source={{ uri: tileUrl(TILE_TEMPLATE, tile), headers: TILE_HEADERS }}
            style={{ position: 'absolute', left: tile.left, top: tile.top, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE }}
            fadeDuration={0}
          />
        ))}
      </View>

      {clusters.map((cl) => {
        const many = cl.items.length > 1;
        const first = cl.items[0]!;
        const on = selected === cl.key;
        const label = many
          ? tp('map.cluster', cl.items.length, { count: number(cl.items.length) })
          : [titleOf(first), mapDistance(t, distanceMetres(from, first.point), locale)].filter(Boolean).join(', ');
        return (
          <Pressable
            key={cl.key}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={many ? undefined : meta(first, here ?? center)}
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(on ? null : cl)}
            style={{
              position: 'absolute',
              left: cl.x - 22,
              top: cl.y - 22,
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? c.yapiStrong : c.yapi,
              borderWidth: 2,
              borderColor: on ? c.ink : c.surface,
            }}
          >
            {many ? (
              <Text maxFontSizeMultiplier={1.2} style={{ color: c.onYapi, fontWeight: '800', fontSize: 14 }}>
                {number(cl.items.length)}
              </Text>
            ) : (
              <Icon name={LAYER_ICONS[first.layer]} size={20} color={c.onYapi} />
            )}
          </Pressable>
        );
      })}

      {you ? (
        <View
          accessible
          accessibilityLabel={t('nav.profile')}
          style={{
            position: 'absolute',
            left: you.x - 9,
            top: you.y - 9,
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: c.saffron,
            borderWidth: 3,
            borderColor: c.surface,
          }}
        />
      ) : null}

      <View style={{ position: 'absolute', top: space[3], end: space[3], gap: space[2] }}>
        <MapButton icon="add" label={t('collage.zoomIn')} disabled={zoom >= MAP_MAX_ZOOM} onPress={() => onZoom(clampZoom(zoom + 1))} />
        <MapButton icon="remove" label={t('collage.zoomOut')} disabled={zoom <= MAP_MIN_ZOOM} onPress={() => onZoom(clampZoom(zoom - 1))} />
        <MapButton icon="locate-outline" label={t('map.useLocation')} hint={locateHint} onPress={onLocate} />
      </View>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel={MAP_ATTRIBUTION}
        onPress={() => void Linking.openURL(MAP_ATTRIBUTION_URL).catch(() => {})}
        hitSlop={{ top: 14, bottom: 8, left: 8, right: 8 }}
        style={{
          position: 'absolute',
          bottom: 0,
          end: 0,
          paddingHorizontal: space[2],
          paddingVertical: 4,
          backgroundColor: c.surface,
          borderTopStartRadius: radius.sm,
        }}
      >
        <Text style={{ color: c.ink, fontSize: 11 }}>{MAP_ATTRIBUTION}</Text>
      </Pressable>
    </View>
  );
}

/** A pin's card over the map: the item, or the group's items, each opening it. */
export function PinCard({ cluster, from, onClose }: { cluster: MapCluster; from: LatLng | null; onClose: () => void }) {
  const c = useColors();
  const { t, tp, number } = useT();
  const many = cluster.items.length > 1;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        {
          position: 'absolute',
          start: space[3],
          end: space[3],
          bottom: space[6],
          maxHeight: 280,
          backgroundColor: c.surface,
          borderRadius: radius.lg,
          paddingVertical: space[1],
        },
        elevation(c, 'lg'),
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingStart: space[3] }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: c.inkMuted, fontSize: 13, fontWeight: '700' }}>
          {many ? tp('map.cluster', cluster.items.length, { count: number(cluster.items.length) }) : t(MAP_LAYER_KEYS[cluster.items[0]!.layer])}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.common.close')}
          onPress={onClose}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="close" size={20} color={c.inkMuted} />
        </Pressable>
      </View>
      <ScrollView>
        {cluster.items.map((item) => (
          <MapItemRow key={item.key} item={item} from={from} />
        ))}
      </ScrollView>
    </View>
  );
}

/** A layer to show or hide: a checkbox chip, 36 tall with 4 of slop, so 44 to tap. */
export function LayerChip({ layer, on, onPress }: { layer: MapLayer; on: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={t(MAP_LAYER_KEYS[layer])}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 36,
        paddingHorizontal: space[3],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: on ? c.yapi : c.line,
        backgroundColor: on ? c.yapiSoft : c.surface,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name={on ? 'checkmark' : LAYER_ICONS[layer]} size={16} color={on ? c.yapi : c.inkMuted} />
      <Text style={{ color: c.ink, fontWeight: on ? '700' : '600', fontSize: 14 }} numberOfLines={1}>
        {t(MAP_LAYER_KEYS[layer])}
      </Text>
    </Pressable>
  );
}

/** A place page found by name, as tagging one sends it (`placeId`). */
export type PlacePick = { id: string; name: string; city: string | null };

/**
 * "Add a place": a place page found by name (a Yap made there, a question about it), shown on the
 * post and on the Near you map. `label` names the search field.
 */
export function PlacePicker({ value, onChange, label }: { value: PlacePick | null; onChange: (p: PlacePick | null) => void; label?: string }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [places, setPlaces] = useState<PlacePick[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) return setPlaces([]);
    const timer = setTimeout(() => {
      void client()
        .then((api) => api.search(q.trim(), 'places'))
        .then(
          (r) => setPlaces(((r.results.places as PlacePick[] | undefined) ?? []).slice(0, 5)),
          () => setPlaces([]),
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [q, value]);
  if (value)
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Icon name="location-outline" size={18} color={c.inkMuted} />
        <Text style={[{ color: c.ink, flex: 1, fontWeight: '600' }, userText]} numberOfLines={1}>
          {value.city ? `${value.name}, ${value.city}` : value.name}
        </Text>
        <Button label={t('m.common.remove')} variant="ghost" size="sm" icon="close" onPress={() => onChange(null)} />
      </View>
    );
  return (
    <View style={{ gap: space[2] }}>
      <Field label={label ?? t('m.sticker.findPlace')} value={q} onChangeText={setQ} maxLength={100} />
      {places.map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Icon name="location-outline" size={16} color={c.inkMuted} />
          <Text style={[{ color: c.ink, flex: 1 }, userText]} numberOfLines={1}>
            {p.name}
            {p.city ? ` · ${p.city}` : ''}
          </Text>
          <Button
            label={t('m.sticker.add')}
            size="sm"
            variant="secondary"
            onPress={() => {
              onChange(p);
              setQ('');
            }}
          />
        </View>
      ))}
      {q.trim().length >= 2 && !places.length ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.sticker.noPlaces')}</Text> : null}
    </View>
  );
}
