import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Platform, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  bearingDegrees,
  clockTime,
  distanceMetres,
  isLive,
  locationAlt,
  locationFromYou,
  locationStatus,
  mapPattern,
  mapsUrl,
  pointFor,
  type LatLng,
  type LocationPrecision,
  type LocationShare,
} from '../../../packages/shared/src/location';
import type { Message } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { BottomSheet, Button, Icon, Notice, useColors, userText } from './ui';

/**
 * Sharing where you are in a chat (mobile). This app build has no location module (expo-location
 * isn't installed), so the phone shows shared locations, stops your own live share, and sends a
 * pin once only where the platform itself offers a position (navigator.geolocation); otherwise it
 * says sharing needs the next app update. See docs/product/status.md for the one install step.
 *
 * The card draws its own small map (no map tiles, no outside services). Distance and direction from
 * you are worked out on this phone only, from your own live share in the chat; "Open in maps" asks
 * first, then opens Apple Maps (iOS) or the phone's maps app (Android, a geo: link).
 */

type Fix = LatLng & { accuracy?: number };
type Geo = {
  getCurrentPosition: (
    ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void,
    fail: (e: { code: number }) => void,
    o?: object,
  ) => void;
};

/** The platform's own position reader, when this build has one (React Native doesn't by default). */
function geolocation(): Geo | null {
  const nav = (globalThis as { navigator?: { geolocation?: Geo } }).navigator;
  return nav?.geolocation && typeof nav.geolocation.getCurrentPosition === 'function' ? nav.geolocation : null;
}

function readPosition(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    const geo = geolocation();
    if (!geo) return reject('unsupported');
    geo.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(e.code === 1 ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 10_000 },
    );
  });
}

/** The time now, moving on every few seconds while `active`, for "Updated 20 s ago". */
function useNow(active: boolean, every = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(i);
  }, [active, every]);
  return now;
}

/** Your live share in this chat (started on the web), kept current by live updates, with Stop. */
export function useLocationSharing(conversationId: string, meId: string | undefined) {
  const [mine, setMine] = useState<LocationShare | null>(null);
  const [viewer, setViewer] = useState<LatLng | null>(null);
  const mineRef = useRef<LocationShare | null>(null);
  mineRef.current = mine;

  useEffect(() => {
    setMine(null);
    if (!meId) return;
    void client()
      .then((api) => api.conversations.locationShares(conversationId))
      .then(
        (r) => setMine(r.items.find((s) => s.sharer.id === meId) ?? null),
        () => {},
      );
  }, [conversationId, meId]);

  const apply = useCallback(
    (share: LocationShare) => {
      if (share.sharer.id !== meId || share.mode !== 'live' || share.conversationId !== conversationId) return;
      if (isLive(share)) setMine(share);
      else setMine((cur) => (cur?.id === share.id ? null : cur));
    },
    [meId, conversationId],
  );

  useEffect(() => {
    if (!mine?.endsAt) return;
    const timer = setTimeout(() => setMine((cur) => (cur?.id === mine.id ? null : cur)), Math.max(0, new Date(mine.endsAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [mine?.id, mine?.endsAt]);

  async function stop(): Promise<LocationShare | null> {
    const share = mineRef.current;
    if (!share) return null;
    const r = await (await client()).location.stop(share.id);
    setMine(null);
    return r.location;
  }

  const you = viewer ?? (mine?.point ? { lat: mine.point.lat, lng: mine.point.lng } : null);
  return { mine, viewer: you, setViewer, apply, stop };
}

// ─── Starting ───────────────────────────────────────────────────────────

/**
 * "Share where I am" on the phone: a pin once where this build can read a position; live sharing
 * (and everything else, where it can't) waits for the next app update.
 */
export function ShareLocationSheet({
  visible,
  onClose,
  conversationId,
  onSent,
}: {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
}) {
  const { t } = useT();
  const c = useColors();
  const [precision, setPrecision] = useState<LocationPrecision>('precise');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canOnce = !!geolocation();

  async function once() {
    setBusy(true);
    setProblem(null);
    try {
      const here = await readPosition();
      const p = pointFor(here, precision);
      const api = await client();
      const { message } = await api.conversations.shareLocation(conversationId, {
        mode: 'once',
        precision,
        lat: p.lat,
        lng: p.lng,
        accuracy: here.accuracy,
        clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      onSent(message);
      onClose();
    } catch (e) {
      setProblem(
        e === 'denied'
          ? t('location.denied')
          : e === 'unavailable'
            ? t('location.unavailable')
            : e === 'unsupported'
              ? t('location.needsUpdate')
              : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('location.sheet.title')}>
      <Notice tone="info" title={t('location.needsUpdate')}>
        <Text style={{ color: c.ink, lineHeight: 20 }}>{t('location.needsUpdateHint')}</Text>
      </Notice>
      {canOnce ? (
        <View style={{ gap: space[3] }}>
          <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('location.sheet.intro')}</Text>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('location.precision')}
          </Text>
          {(['precise', 'approximate'] as const).map((p) => {
            const on = precision === p;
            return (
              <Pressable
                key={p}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setPrecision(p)}
                style={{
                  minHeight: 44,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space[2],
                  padding: space[3],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: on ? c.yapi : c.line,
                  backgroundColor: on ? c.yapiSoft : 'transparent',
                }}
              >
                <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? c.yapi : c.inkMuted} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.ink, fontWeight: '700' }}>
                    {t(p === 'precise' ? 'location.precision.precise' : 'location.precision.approximate')}
                  </Text>
                  <Text style={{ color: c.inkMuted, fontSize: 13 }}>
                    {t(p === 'precise' ? 'location.precision.preciseHint' : 'location.precision.approximateHint')}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          <Button label={t('location.once')} icon="location-outline" disabled={busy} onPress={once} />
          <Text style={{ color: c.inkMuted, fontSize: 13, textAlign: 'center' }}>{t('location.onceHint')}</Text>
        </View>
      ) : null}
      {problem ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger, lineHeight: 20 }}>
          {problem}
        </Text>
      ) : null}
    </BottomSheet>
  );
}

// ─── While you share ────────────────────────────────────────────────────

/** "You're sharing where you are until 14:30" (started on the web), with Stop. */
export function SharingBanner({ share, onStop }: { share: LocationShare | null; onStop: () => Promise<unknown> }) {
  const c = useColors();
  const { t, locale } = useT();
  if (!share?.endsAt) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        paddingStart: space[4],
        paddingEnd: space[3],
        paddingVertical: space[2],
        backgroundColor: c.yapiSoft,
        borderBottomWidth: 1,
        borderBottomColor: c.yapi,
      }}
    >
      <Icon name="location" size={20} color={c.yapi} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontWeight: '700', fontSize: 14 }}>{t('location.banner', { time: clockTime(share.endsAt, locale) })}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('location.bannerElsewhere')}</Text>
      </View>
      <Button label={t('location.stop')} size="sm" variant="danger" onPress={onStop} />
    </View>
  );
}

// ─── The card ───────────────────────────────────────────────────────────

/** A shared location in the chat: a small drawn map with the pin, how long ago it moved, how far from you, and "Open in maps". */
export function LocationCard({
  message,
  meId,
  tint,
  viewer,
  onViewer,
  onStop,
}: {
  message: Message;
  meId?: string;
  tint: string;
  viewer: LatLng | null;
  onViewer: (p: LatLng) => void;
  onStop: () => Promise<unknown>;
}) {
  const w = useT();
  const { t } = w;
  const share = message.location!;
  const running = share.mode === 'live' && !share.stoppedAt;
  const now = useNow(running);
  const live = isLive(share, now);
  const own = share.sharer.id === meId;
  const point = share.point && (share.mode === 'once' || live) ? share.point : null;
  const from = !own && point && viewer ? viewer : null;
  const alt = locationAlt(w, share, meId, from, now);
  const canFind = !!geolocation();

  function openMaps() {
    if (!point) return;
    const url = mapsUrl(point, Platform.OS === 'ios' ? 'ios' : 'android');
    Alert.alert(t('location.leaveTitle'), t('location.leaveBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('location.leaveGo'), onPress: () => void Linking.openURL(url).catch(() => Alert.alert(t('location.unavailable'))) },
    ]);
  }

  async function findMe() {
    try {
      const p = await readPosition();
      onViewer({ lat: p.lat, lng: p.lng });
    } catch (e) {
      Alert.alert(e === 'denied' ? t('location.denied') : t('location.unavailable'));
    }
  }

  return (
    <View style={{ gap: space[2], minWidth: 240 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="location-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>
          {t(share.mode === 'once' ? 'location.pin' : 'location.live')}
        </Text>
      </View>
      <LocationMap point={point} viewer={from} approximate={share.precision === 'approximate'} seed={share.id} label={alt} />
      <Text style={{ color: tint, fontSize: 13, fontWeight: '600' }}>
        {point || share.mode === 'live' ? locationStatus(w, share, now) : t('location.hidden')}
        {point && share.precision === 'approximate' ? ` · ${t('location.approximateLabel')}` : ''}
      </Text>
      {from && point ? <Text style={[{ color: tint, fontSize: 14, fontWeight: '700' }, userText]}>{locationFromYou(w, from, point)}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {point && !own && !from && canFind ? <CardButton label={t('location.showDistance')} icon="compass-outline" tint={tint} onPress={findMe} /> : null}
        {point ? <CardButton label={t('location.openMaps')} icon="map-outline" tint={tint} onPress={openMaps} /> : null}
        {own && live ? <CardButton label={t('location.stopSharing')} icon="stop-circle-outline" tint={tint} onPress={onStop} strong /> : null}
      </View>
    </View>
  );
}

function CardButton({
  label,
  icon,
  tint,
  onPress,
  strong,
}: {
  label: string;
  icon: 'compass-outline' | 'map-outline' | 'stop-circle-outline';
  tint: string;
  onPress: () => unknown;
  strong?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await onPress();
        } finally {
          setBusy(false);
        }
      }}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[1],
        paddingHorizontal: space[3],
        borderRadius: radius.full,
        borderWidth: strong ? 2 : 1,
        borderColor: tint,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Icon name={icon} size={18} color={tint} />
      <Text style={{ color: tint, fontSize: 14, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The drawn map, from plain views: a made-up street pattern (it says nothing about the real streets
 * there), a soft circle for an approximate place, the pin, and you, the right way from it. One image
 * for screen readers, with the card's text alternative.
 */
function LocationMap({
  point,
  viewer,
  approximate,
  seed,
  label,
}: {
  point: LatLng | null;
  viewer: LatLng | null;
  approximate: boolean;
  seed: string;
  label: string;
}) {
  const c = useColors();
  const { t } = useT();
  const [width, setWidth] = useState(240);
  const H = 120;
  const cx = width / 2;
  const cy = H / 2 + 6;
  const base = point ?? { lat: seed.charCodeAt(0) + seed.charCodeAt(1), lng: seed.charCodeAt(2) + seed.charCodeAt(3) };
  const lines = mapPattern(base);
  let you: { x: number; y: number } | null = null;
  if (point && viewer) {
    const b = (bearingDegrees(viewer, point) * Math.PI) / 180;
    const r = Math.max(26, Math.min(48, 18 + Math.log10(Math.max(distanceMetres(viewer, point), 10)) * 9));
    you = { x: cx - Math.sin(b) * r * 1.6, y: cy + Math.cos(b) * r };
  }
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}
      style={{ width: '100%', height: H, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.surfaceSunken, borderWidth: 1, borderColor: c.line }}
    >
      {lines.map((l, i) => {
        const x1 = (l.x1 / 100) * width;
        const y1 = (l.y1 / 100) * H;
        const x2 = (l.x2 / 100) * width;
        const y2 = (l.y2 / 100) * H;
        const length = Math.hypot(x2 - x1, y2 - y1);
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        const thick = l.major ? 6 : 3;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: (x1 + x2) / 2 - length / 2,
              top: (y1 + y2) / 2 - thick / 2,
              width: length,
              height: thick,
              borderRadius: thick,
              backgroundColor: l.major ? c.lineStrong : c.line,
              opacity: point ? 1 : 0.6,
              transform: [{ rotate: `${angle}deg` }],
            }}
          />
        );
      })}
      {point && approximate ? (
        <View
          style={{
            position: 'absolute',
            left: cx - 30,
            top: cy - 34,
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: c.yapiSoft,
            borderWidth: 1.5,
            borderColor: c.yapi,
            borderStyle: 'dashed',
            opacity: 0.85,
          }}
        />
      ) : null}
      {you ? (
        <View style={{ position: 'absolute', left: you.x - 16, top: you.y - 22, width: 32, alignItems: 'center' }}>
          <Text style={{ color: c.ink, fontSize: 10, fontWeight: '800' }}>{t('location.youMarker')}</Text>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.ink, borderWidth: 2.5, borderColor: c.surface }} />
        </View>
      ) : null}
      <View style={{ position: 'absolute', left: cx - 16, top: cy - 34 }}>
        <Icon name="location" size={32} color={point ? c.yapi : c.inkMuted} />
      </View>
    </View>
  );
}

/** "Ada asked where everyone is", with a button for the others to share. */
export function LocationRequestLine({ message, meId, onShare }: { message: Message; meId?: string; onShare: () => void }) {
  const c = useColors();
  const { t } = useT();
  const mine = message.sender.id === meId;
  return (
    <View style={{ alignSelf: 'center', alignItems: 'center', gap: space[1], maxWidth: '90%', paddingVertical: space[1] }}>
      <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'center' }}>
        <Icon name="location-outline" size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>
          {mine ? t('location.request.lineYou') : t('location.request.line', { name: message.sender.displayName })}
        </Text>
      </View>
      {!mine ? <Button label={t('location.menu')} size="sm" variant="secondary" icon="location-outline" onPress={onShare} /> : null}
    </View>
  );
}
