import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, AppState, Linking, Platform, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  bearingDegrees,
  clockTime,
  distanceMetres,
  isLive,
  LOCATION_DURATIONS,
  LOCATION_UPDATE_SECONDS,
  locationAlt,
  locationFromYou,
  locationStatus,
  mapPattern,
  mapsUrl,
  pointFor,
  type LatLng,
  type LocationDuration,
  type LocationPrecision,
  type LocationShare,
} from '../../../packages/shared/src/location';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import type { Message } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { BottomSheet, Button, Icon, Notice, useColors, userText } from './ui';

/**
 * Sharing where you are in a chat (mobile): live for a set time, or a pin once. The position is read
 * with expo-location, only after you tap share (the permission prompt comes then, never before), and
 * only while this chat is open: leaving the chat stops a live share started here.
 *
 * The card draws its own small map (no map tiles, no outside services). Distance and direction from
 * you are worked out on this phone only, from your own live share in the chat; "Open in maps" asks
 * first, then opens Apple Maps (iOS) or the phone's maps app (Android, a geo: link).
 */

type Fix = LatLng & { accuracy?: number };
/** Where you are now, asking for permission first (only when you've tapped share). */
async function readPosition(): Promise<Fix> {
  const perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (!perm || perm.status !== 'granted') throw 'denied';
  try {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? undefined };
  } catch {
    throw 'unavailable';
  }
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

/** Your live share in this chat, kept current by live updates, with Stop. */
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

  // A live share started on this phone: follow where you are while the chat is open and the app is in
  // front, sending a point at most every LOCATION_UPDATE_SECONDS; leaving the chat stops it.
  const [startedHere, setStartedHere] = useState<string | null>(null);
  const startedHereRef = useRef<string | null>(null);
  startedHereRef.current = startedHere;
  const started = useCallback((share: LocationShare) => {
    setMine(share);
    setStartedHere(share.id);
  }, []);
  useEffect(() => {
    if (!startedHere || mine?.id !== startedHere) return;
    const share = mine;
    let sub: Location.LocationSubscription | null = null;
    let lastSent = Date.now();
    let cancelled = false;
    // The app can go back and forth while a watch is still starting: only the latest one is kept, so
    // an earlier one can never go on following you unseen.
    let run = 0;
    const stopWatching = () => {
      try {
        sub?.remove();
      } catch {
        /* already stopped */
      }
      sub = null;
    };
    const watch = async () => {
      const mineRun = ++run;
      stopWatching();
      if (AppState.currentState !== 'active') return;
      const next = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: LOCATION_UPDATE_SECONDS * 1000, distanceInterval: 10 },
        (p) => {
          if (cancelled || Date.now() - lastSent < LOCATION_UPDATE_SECONDS * 1000) return;
          lastSent = Date.now();
          const point = pointFor({ lat: p.coords.latitude, lng: p.coords.longitude }, share.precision);
          void client()
            .then((api) => api.location.update(share.id, { ...point, accuracy: p.coords.accuracy ?? undefined }))
            .then(
              (r) => setMine((cur) => (cur?.id === share.id ? r.location : cur)),
              () => {},
            );
        },
      ).catch(() => null);
      if (cancelled || mineRun !== run || AppState.currentState !== 'active') {
        try {
          next?.remove();
        } catch {
          /* already stopped */
        }
        return;
      }
      sub = next;
    };
    void watch();
    const app = AppState.addEventListener('change', () => void watch());
    return () => {
      cancelled = true;
      run++;
      app.remove();
      stopWatching();
    };
  }, [startedHere, mine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the chat ends a share started here (as closing the page does on the web).
  useEffect(
    () => () => {
      const share = mineRef.current;
      if (share && share.id === startedHereRef.current && isLive(share)) void client().then((api) => api.location.stop(share.id).catch(() => {}));
    },
    [],
  );

  const you = viewer ?? (mine?.point ? { lat: mine.point.lat, lng: mine.point.lng } : null);
  return { mine, viewer: you, setViewer, apply, stop, started, startedHere: !!startedHere && mine?.id === startedHere };
}

// ─── Starting ───────────────────────────────────────────────────────────

/** "Share where I am": live for 15 minutes, an hour or 8 hours, or a pin once; precise or approximate. */
export function ShareLocationSheet({
  visible,
  onClose,
  conversationId,
  onSent,
  onStarted,
}: {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
  /** A live share started here: the chat keeps its point current while it stays open. */
  onStarted?: (share: LocationShare) => void;
}) {
  const { t, locale } = useT();
  const c = useColors();
  const [precision, setPrecision] = useState<LocationPrecision>('precise');
  const [minutes, setMinutes] = useState<LocationDuration>(60);
  const [busy, setBusy] = useState<'live' | 'once' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const durationName = (m: LocationDuration) => t(`location.duration.${m}` as MessageKey);

  async function share(mode: 'live' | 'once') {
    setBusy(mode);
    setProblem(null);
    try {
      const here = await readPosition();
      const p = pointFor(here, precision);
      const api = await client();
      const { message } = await api.conversations.shareLocation(conversationId, {
        mode,
        ...(mode === 'live' ? { minutes } : {}),
        precision,
        lat: p.lat,
        lng: p.lng,
        accuracy: here.accuracy,
        clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      onSent(message);
      if (mode === 'live' && message.location) {
        onStarted?.(message.location);
        if (message.location.endsAt)
          AccessibilityInfo.announceForAccessibility(t('location.startedToast', { time: clockTime(message.location.endsAt, locale) }));
      }
      onClose();
    } catch (e) {
      setProblem(e === 'denied' ? t('location.denied') : e === 'unavailable' ? t('location.unavailable') : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const choice = (on: boolean) => ({
    minHeight: 44,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space[2],
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: on ? c.yapi : c.line,
    backgroundColor: on ? c.yapiSoft : 'transparent',
  });

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('location.sheet.title')}>
      <View style={{ gap: space[3] }}>
        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('location.sheet.intro')}</Text>
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
          {t('location.duration')}
        </Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: space[2] }}>
          {LOCATION_DURATIONS.map((m) => {
            const on = minutes === m;
            return (
              <Pressable
                key={m}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setMinutes(m)}
                style={[choice(on), { flex: 1, justifyContent: 'center' }]}
              >
                <Text style={{ color: c.ink, fontWeight: on ? '700' : '600' }}>{durationName(m)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
          {t('location.precision')}
        </Text>
        {(['precise', 'approximate'] as const).map((p) => {
          const on = precision === p;
          return (
            <Pressable key={p} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => setPrecision(p)} style={choice(on)}>
              <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? c.yapi : c.inkMuted} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: '700' }}>{t(p === 'precise' ? 'location.precision.precise' : 'location.precision.approximate')}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>
                  {t(p === 'precise' ? 'location.precision.preciseHint' : 'location.precision.approximateHint')}
                </Text>
              </View>
            </Pressable>
          );
        })}
        <Button
          label={busy === 'live' ? t('location.locating') : t('location.start', { time: durationName(minutes) })}
          icon="navigate-outline"
          disabled={!!busy}
          onPress={() => void share('live')}
        />
        <Text style={{ color: c.inkMuted, fontSize: 13, textAlign: 'center' }}>{t('location.phoneNote')}</Text>
        <Button
          label={busy === 'once' ? t('location.locating') : t('location.once')}
          icon="location-outline"
          variant="secondary"
          disabled={!!busy}
          onPress={() => void share('once')}
        />
        <Text style={{ color: c.inkMuted, fontSize: 13, textAlign: 'center' }}>{t('location.onceHint')}</Text>
        {problem ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.danger, lineHeight: 20 }}>
            {problem}
          </Text>
        ) : null}
      </View>
    </BottomSheet>
  );
}

// ─── While you share ────────────────────────────────────────────────────

/** "You're sharing where you are until 14:30", with Stop (and where it keeps going). */
export function SharingBanner({ share, onStop, here = false }: { share: LocationShare | null; onStop: () => Promise<unknown>; here?: boolean }) {
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
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t(here ? 'location.phoneNote' : 'location.bannerElsewhere')}</Text>
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
  const canFind = true;

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
