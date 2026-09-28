import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  cellRect,
  COLLAGE_BACKGROUNDS,
  COLLAGE_GAPS,
  COLLAGE_MAX_PHOTOS,
  COLLAGE_MAX_ZOOM,
  COLLAGE_RADII,
  COLLAGE_SHAPES,
  COLLAGE_SIZES,
  collageInk,
  collageLayout,
  collageLayoutsFor,
  coverBox,
  defaultCollage,
  dragFocus,
  swapCells,
  withLayout,
  type CellRect,
  type CollageLayout,
  type CollageShape,
  type CollageSpec,
} from '../../../packages/shared/src/collage';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import type { Picked } from './media';
import { radius, space } from './theme';
import { Button, Icon, Segmented, useColors } from './ui';

/** A photo that can go in a collage: one of your uploads. */
export interface CollagePhoto {
  id: string;
  url: string;
}

/** The collage made on the server, used in the post or story like an uploaded photo. */
export interface MadeCollage {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

interface Loaded {
  uri: string;
  width: number;
  height: number;
}

const newKey = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const distance = (e: GestureResponderEvent) => {
  const [a, b] = e.nativeEvent.touches;
  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
};

/**
 * Pick 2 to 9 photos from the library for a collage. Returns null when the person closed the
 * picker, or 'denied' when photo access is off.
 */
export async function pickCollagePhotos(): Promise<Picked[] | 'denied' | null> {
  const launch = () =>
    ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: COLLAGE_MAX_PHOTOS,
      orderedSelection: true,
      quality: 0.9,
    });
  let r: ImagePicker.ImagePickerResult;
  try {
    r = await launch();
  } catch {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.accessPrivileges !== 'limited') return 'denied';
    r = await launch();
  }
  if (r.canceled) return null;
  return r.assets.filter((a) => a.type !== 'video' && a.mimeType !== 'image/gif').slice(0, COLLAGE_MAX_PHOTOS);
}

/** A small drawing of a layout for the picker. */
function LayoutThumb({ layout, shape, ink, gap }: { layout: CollageLayout; shape: CollageShape; ink: string; gap: string }) {
  const { width, height } = COLLAGE_SIZES[shape];
  const h = 34;
  const w = (h * width) / height;
  return (
    <View style={{ width: w, height: h }}>
      {layout.cells.map((cell, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: cell.x * w,
            top: cell.y * h,
            width: cell.w * w,
            height: cell.h * h,
            backgroundColor: ink,
            borderWidth: 1,
            borderColor: gap,
            transform: cell.rotate ? [{ rotate: `${cell.rotate}deg` }] : undefined,
          }}
        />
      ))}
    </View>
  );
}

/**
 * One cell of the preview. Tap to choose it (tap another to swap), drag to choose the part of the
 * photo that shows, pinch to zoom. Screen readers get the same as actions.
 */
function Cell({
  index,
  image,
  rect,
  scale,
  focus,
  zoom,
  chosen,
  label,
  actions,
  onTap,
  onFocus,
  onZoom,
  onAction,
}: {
  index: number;
  image: Loaded;
  rect: CellRect;
  scale: number;
  focus: { x: number; y: number };
  zoom: number;
  chosen: boolean;
  label: string;
  actions: { name: string; label: string }[];
  onTap: (i: number) => void;
  onFocus: (i: number, f: { x: number; y: number }) => void;
  onZoom: (i: number, z: number) => void;
  onAction: (i: number, name: string) => void;
}) {
  const c = useColors();
  const latest = useRef({ index, image, rect, scale, focus, zoom, onTap, onFocus, onZoom });
  latest.current = { index, image, rect, scale, focus, zoom, onTap, onFocus, onZoom };
  const start = useRef({ focus, zoom, pinch: 0, moved: false });

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const l = latest.current;
        start.current = { focus: l.focus, zoom: l.zoom, pinch: distance(e), moved: false };
      },
      onPanResponderMove: (e, g) => {
        const l = latest.current;
        const s = start.current;
        if (g.numberActiveTouches >= 2) {
          const d = distance(e);
          if (!s.pinch) s.pinch = d;
          if (s.pinch > 0 && d > 0) {
            s.moved = true;
            l.onZoom(l.index, clamp((s.zoom * d) / s.pinch, 1, COLLAGE_MAX_ZOOM));
          }
          return;
        }
        if (!s.moved && Math.hypot(g.dx, g.dy) < 6) return;
        s.moved = true;
        if (!l.scale) return;
        l.onFocus(l.index, dragFocus(s.focus, g.dx / l.scale, g.dy / l.scale, l.image, l.rect, l.zoom));
      },
      onPanResponderRelease: () => {
        if (!start.current.moved) latest.current.onTap(latest.current.index);
      },
    }),
  ).current;

  const fit = coverBox(image.width, image.height, rect.width, rect.height, focus.x, focus.y, zoom);
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: chosen }}
      accessibilityActions={[{ name: 'activate' }, ...actions]}
      onAccessibilityAction={(e: AccessibilityActionEvent) => onAction(index, e.nativeEvent.actionName)}
      {...pan.panHandlers}
      style={{
        position: 'absolute',
        left: (rect.left - rect.frame) * scale,
        top: (rect.top - rect.frame) * scale,
        width: (rect.width + 2 * rect.frame) * scale,
        height: (rect.height + 2 * rect.frame) * scale,
        borderWidth: rect.frame * scale,
        borderColor: '#FFFFFF',
        backgroundColor: '#FFFFFF',
        borderRadius: rect.radius * scale,
        transform: rect.rotate ? [{ rotate: `${rect.rotate}deg` }] : undefined,
        zIndex: chosen ? 2 : 1,
      }}
    >
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: Math.max(0, rect.radius - rect.frame) * scale }}>
        <Image
          source={{ uri: image.uri }}
          accessibilityIgnoresInvertColors
          style={{ position: 'absolute', left: fit.left * scale, top: fit.top * scale, width: fit.width * scale, height: fit.height * scale }}
        />
      </View>
      {chosen ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: -4, top: -4, right: -4, bottom: -4, borderWidth: 3, borderColor: c.yapi, borderRadius: rect.radius * scale + 4 }}
        />
      ) : null}
    </View>
  );
}

/**
 * The collage editor: layouts for the number of photos, shape, gap, corners and background, and a
 * preview drawn with the same arithmetic as the server (@yapilapi/shared collage.ts). "Use collage"
 * has it made on the server (POST /v1/media/collage).
 */
export function CollageEditor({
  photos,
  shape: initialShape = 'square',
  onDone,
  onCancel,
}: {
  photos: CollagePhoto[];
  shape?: CollageShape;
  onDone: (m: MadeCollage) => void;
  onCancel: () => void;
}) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [spec, setSpec] = useState<CollageSpec>(() =>
    defaultCollage(
      photos.map((p) => p.id),
      initialShape,
    )!,
  );
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [area, setArea] = useState({ w: 0, h: 0 });
  // One key per version of the collage: sending the same one again (a retry) gives back the same result.
  const specJson = JSON.stringify(spec);
  const clientKey = useMemo(() => newKey(), [specJson]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server only takes photos its media job has finished with; wait for each, and use its sizes.
  useEffect(() => {
    const stop = new AbortController();
    (async () => {
      const api = await client();
      await Promise.all(
        photos.map(async (p) => {
          const m = await api.media.waitUntilProcessed(p.id, { signal: stop.signal });
          const uri = mediaUrl(m.variants.large ?? m.variants.medium ?? m.url ?? p.url);
          setLoaded((cur) => ({ ...cur, [p.id]: { uri, width: m.width ?? 1, height: m.height ?? 1 } }));
        }),
      );
    })().catch((e) => {
      if (!stop.signal.aborted) setError(errorMessage(e));
    });
    return () => stop.abort();
  }, [photos]);

  const layout = collageLayout(spec.layout)!;
  const size = COLLAGE_SIZES[spec.shape];
  const scale = area.w && area.h ? Math.min(area.w / size.width, area.h / size.height) : 0;
  const ready = photos.every((p) => loaded[p.id]);
  const bg = COLLAGE_BACKGROUNDS.find((b) => b.id === spec.background)!;
  const photoNumber = (mediaId: string) => photos.findIndex((p) => p.id === mediaId) + 1;

  const setCell = (i: number, change: Partial<CollageSpec['cells'][number]>) =>
    setSpec((s) => ({ ...s, cells: s.cells.map((x, j) => (j === i ? { ...x, ...change } : x)) }));

  function tap(i: number) {
    if (selected === null) return setSelected(i);
    if (selected === i) return setSelected(null);
    setSpec((s) => swapCells(s, selected, i));
    AccessibilityInfo.announceForAccessibility(t('collage.swapped', { a: selected + 1, b: i + 1 }));
    setSelected(null);
  }
  function act(i: number, name: string) {
    const z = spec.cells[i]!.zoom ?? 1;
    if (name === 'activate') tap(i);
    else if (name === 'zoomIn') setCell(i, { zoom: clamp(z + 0.25, 1, COLLAGE_MAX_ZOOM) });
    else if (name === 'zoomOut') setCell(i, { zoom: clamp(z - 0.25, 1, COLLAGE_MAX_ZOOM) });
    else if (name === 'recentre') setCell(i, { focusX: 0.5, focusY: 0.5, zoom: 1 });
  }
  const actions = [
    { name: 'zoomIn', label: t('collage.zoomIn') },
    { name: 'zoomOut', label: t('collage.zoomOut') },
    { name: 'recentre', label: t('collage.recentre') },
  ];

  async function use() {
    setBusy(true);
    setError(null);
    try {
      const api = await client();
      const { media } = await api.media.collage({ clientKey, ...spec, altText: t('collage.alt', { count: photos.length }) });
      onDone({ id: media.id, url: media.url, altText: media.altText, width: media.width, height: media.height });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const label = { color: c.ink, fontWeight: '700', fontSize: 14 } as const;
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={busy ? () => undefined : onCancel}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
          <Button label={t('collage.cancel')} variant="ghost" size="sm" onPress={onCancel} disabled={busy} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
            {t('collage.make')}
          </Text>
          <Button label={busy ? t('collage.working') : t('collage.use')} size="sm" onPress={use} disabled={busy || !ready} />
        </View>
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', margin: space[3] }}
          onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          {scale ? (
            <View
              accessibilityLabel={t('collage.preview')}
              style={{
                width: size.width * scale,
                height: size.height * scale,
                backgroundColor: bg.hex,
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: c.lineStrong,
              }}
            >
              {ready ? (
                spec.cells.map((cell, i) => (
                  <Cell
                    key={`${i}-${cell.mediaId}`}
                    index={i}
                    image={loaded[cell.mediaId]!}
                    rect={cellRect(layout, i, size.width, size.height, spec.gap, spec.radius)}
                    scale={scale}
                    focus={{ x: cell.focusX, y: cell.focusY }}
                    zoom={cell.zoom ?? 1}
                    chosen={selected === i}
                    label={t(selected === i ? 'collage.cellChosen' : 'collage.cell', { cell: i + 1, photo: photoNumber(cell.mediaId) })}
                    actions={actions}
                    onTap={tap}
                    onFocus={(j, f) => setCell(j, { focusX: f.x, focusY: f.y })}
                    onZoom={(j, z) => setCell(j, { zoom: z })}
                    onAction={act}
                  />
                ))
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[2] }} accessibilityLiveRegion="polite">
                  <ActivityIndicator color={collageInk(spec.background)} />
                  <Text style={{ color: collageInk(spec.background), fontWeight: '600' }}>{t('collage.preparing')}</Text>
                </View>
              )}
            </View>
          ) : null}
          {busy ? <ActivityIndicator style={{ position: 'absolute' }} accessibilityLabel={t('collage.working')} /> : null}
        </View>
        <ScrollView style={{ maxHeight: '42%' }} contentContainerStyle={{ padding: space[3], gap: space[3] }}>
          {error ? (
            <Text accessibilityRole="alert" style={{ color: c.danger, lineHeight: 20 }}>
              {error}
            </Text>
          ) : null}
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {t('collage.hint')} {t('collage.hintPinch')}
          </Text>
          <Text style={label}>{t('collage.layouts')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
            {collageLayoutsFor(photos.length).map((l) => {
              const on = l.id === spec.layout;
              return (
                <Pressable
                  key={l.id}
                  accessibilityRole="button"
                  accessibilityLabel={t('collage.layoutLabel', { name: t(l.name) })}
                  accessibilityState={{ selected: on }}
                  onPress={() => setSpec((s) => withLayout(s, l.id))}
                  style={{
                    minWidth: 52,
                    height: 52,
                    paddingHorizontal: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.md,
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? c.ink : c.lineStrong,
                    backgroundColor: on ? c.surfaceSunken : c.surface,
                  }}
                >
                  <LayoutThumb layout={l} shape={spec.shape} ink={c.inkMuted} gap={on ? c.surfaceSunken : c.surface} />
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={label}>{t('collage.shape')}</Text>
          <Segmented
            label={t('collage.shape')}
            value={spec.shape}
            onChange={(shape) => setSpec((s) => ({ ...s, shape }))}
            options={COLLAGE_SHAPES.map((id) => ({ id, label: t(`collage.shape.${id}` as MessageKey) }))}
          />
          {!layout.scrapbook ? (
            <>
              <Text style={label}>{t('collage.gap')}</Text>
              <Segmented
                label={t('collage.gap')}
                value={spec.gap}
                onChange={(gap) => setSpec((s) => ({ ...s, gap }))}
                options={COLLAGE_GAPS.map((id) => ({ id, label: t(`collage.gap.${id}` as MessageKey) }))}
              />
            </>
          ) : null}
          <Text style={label}>{t('collage.radius')}</Text>
          <Segmented
            label={t('collage.radius')}
            value={spec.radius}
            onChange={(r) => setSpec((s) => ({ ...s, radius: r }))}
            options={COLLAGE_RADII.map((id) => ({ id, label: t(`collage.radius.${id}` as MessageKey) }))}
          />
          <Text style={label}>{t('collage.background')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {COLLAGE_BACKGROUNDS.map((b) => {
              const on = b.id === spec.background;
              return (
                <Pressable
                  key={b.id}
                  accessibilityRole="button"
                  accessibilityLabel={t('collage.bgLabel', { name: t(`collage.bg.${b.id}` as MessageKey) })}
                  accessibilityState={{ selected: on }}
                  onPress={() => setSpec((s) => ({ ...s, background: b.id }))}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: b.hex,
                    borderWidth: on ? 3 : 1,
                    borderColor: on ? c.ink : c.lineStrong,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {on ? <Icon name="checkmark" size={20} color={collageInk(b.id)} /> : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
