import { useEventListener } from 'expo';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Modal, PanResponder, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ADJUSTMENT_KEYS,
  ADJUSTMENT_RANGES,
  colorMatrix,
  effectiveAdjustments,
  FILTERS,
  NEUTRAL_ADJUSTMENTS,
  vignetteAlpha,
  vignetteCss,
  type AdjustmentKey,
  type Adjustments,
  type EditorParamsInput,
  type FilterId,
} from '../../../packages/shared/src/filters';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { useT } from './i18n';
import { clock, type Picked } from './media';
import { radius, space } from './theme';
import { Button, Segmented, SwitchRow, useColors } from './ui';

/**
 * The photo and video editor on the phone, a simpler version of the web one:
 *   photos: crop to a shape, turn and flip here (expo-image-manipulator); the look and
 *           adjustments are applied by the server (POST /v1/media/:id/edit) with the same maths
 *           as the web, and previewed here with translucent layers that come close;
 *   videos: trim, look, adjustments, mute and cover, all applied by the server.
 */

// ─── Preview of a look ─────────────────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex = (v: number) =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, '0');

/**
 * Layers that approximate a look without native image filters: a desaturating layer, a
 * soft-light tint taken from what the look does to mid grey, a white layer for lifted blacks
 * (fade), and the same radial vignette the web and the server draw.
 */
export function lookLayers(filter: FilterId, adjustments: Adjustments) {
  const { m, o } = colorMatrix(filter, adjustments);
  const apply = (c: number[]) => [0, 1, 2].map((i) => clamp01(m[i * 3]! * c[0]! + m[i * 3 + 1]! * c[1]! + m[i * 3 + 2]! * c[2]! + o[i]!));
  const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  const chroma = (c: number[]) => Math.hypot(c[0]! - lum(c), c[1]! - lum(c), c[2]! - lum(c));
  const samples = [
    [0.8, 0.25, 0.2],
    [0.25, 0.7, 0.3],
    [0.2, 0.3, 0.8],
  ];
  const ratio = samples.reduce((acc, c) => acc + chroma(apply(c)) / chroma(c), 0) / samples.length;
  const grey = apply([0.5, 0.5, 0.5]);
  const black = apply([0, 0, 0]);
  const lift = Math.min(0.4, (black[0]! + black[1]! + black[2]!) / 3);
  const tint = grey.map((v) => 0.5 + (v - 0.5) * 2.5);
  const layers: StyleProp<ViewStyle>[] = [];
  if (ratio < 0.97) layers.push({ backgroundColor: '#808080', mixBlendMode: 'saturation', opacity: clamp01(1 - ratio) });
  if (tint.some((v) => Math.abs(v - 0.5) > 0.01)) layers.push({ backgroundColor: `#${tint.map(hex).join('')}`, mixBlendMode: 'soft-light' });
  if (lift > 0.01) layers.push({ backgroundColor: '#ffffff', opacity: lift });
  const alpha = vignetteAlpha(effectiveAdjustments(filter, adjustments));
  if (alpha > 0) layers.push({ experimental_backgroundImage: vignetteCss(alpha) });
  return layers;
}

/** A picture or video with a look previewed on top. */
export function LookPreview({
  filter,
  adjustments,
  children,
  style,
}: {
  filter: FilterId;
  adjustments: Adjustments;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ overflow: 'hidden', isolation: 'isolate' }, style]}>
      {children}
      {lookLayers(filter, adjustments).map((l, i) => (
        <View key={i} pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, l]} />
      ))}
    </View>
  );
}

// ─── Slider ────────────────────────────────────────────────────────────

/** A slider that works with a finger and with screen readers (swipe up or down to change it). */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const c = useColors();
  const width = useRef(1);
  const startValue = useRef(value);
  const latest = useRef({ value, min, max, step, onChange });
  latest.current = { value, min, max, step, onChange };
  const snap = (v: number) => {
    const l = latest.current;
    return Math.min(l.max, Math.max(l.min, Math.round(v / l.step) * l.step));
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const l = latest.current;
        const v = snap(l.min + (e.nativeEvent.locationX / width.current) * (l.max - l.min));
        startValue.current = v;
        l.onChange(v);
      },
      onPanResponderMove: (_e, g) => {
        const l = latest.current;
        l.onChange(snap(startValue.current + (g.dx / width.current) * (l.max - l.min)));
      },
    }),
  ).current;
  const frac = max > min ? (value - min) / (max - min) : 0;
  const bigStep = Math.max(step, (max - min) / 20);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{label}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13, fontVariant: ['tabular-nums'] }}>{format(value)}</Text>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: value, text: format(value) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => onChange(snap(value + (e.nativeEvent.actionName === 'increment' ? bigStep : -bigStep)))}
        onLayout={(e) => (width.current = Math.max(1, e.nativeEvent.layout.width))}
        style={{ height: 32, justifyContent: 'center', direction: 'ltr' }}
        {...pan.panHandlers}
      >
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: c.line }}>
          <View style={{ width: `${frac * 100}%`, height: 4, borderRadius: 2, backgroundColor: c.yapi }} />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: `${frac * 100}%`,
            marginLeft: -11,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: c.surface,
            borderWidth: 2,
            borderColor: c.yapi,
          }}
        />
      </View>
    </View>
  );
}

// ─── Shared pieces ─────────────────────────────────────────────────────

const ADJUST_LABELS: Record<AdjustmentKey, MessageKey> = {
  brightness: 'm.editor.adjust.brightness',
  contrast: 'm.editor.adjust.contrast',
  saturation: 'm.editor.adjust.saturation',
  warmth: 'm.editor.adjust.warmth',
  fade: 'm.editor.adjust.fade',
  vignette: 'm.editor.adjust.vignette',
  sharpen: 'm.editor.adjust.sharpen',
};

function FilterChips({ value, onChange, thumb }: { value: FilterId; onChange: (f: FilterId) => void; thumb?: string | null }) {
  const c = useColors();
  const { t } = useT();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2], paddingVertical: 4 }}>
      {FILTERS.map((f) => {
        const on = f.id === value;
        return (
          <Pressable
            key={f.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t(`m.editor.filter.${f.id}` as MessageKey)}
            onPress={() => onChange(f.id)}
            style={{ alignItems: 'center', gap: 4 }}
          >
            <LookPreview
              filter={f.id}
              adjustments={NEUTRAL_ADJUSTMENTS}
              style={{
                width: 64,
                height: 64,
                borderRadius: radius.md,
                borderWidth: 2,
                borderColor: on ? c.yapi : 'transparent',
                backgroundColor: c.surfaceSunken,
              }}
            >
              {thumb ? <Image source={{ uri: thumb }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : <SampleSwatch />}
            </LookPreview>
            <Text style={{ color: on ? c.ink : c.inkMuted, fontSize: 12, fontWeight: on ? '700' : '500' }}>{t(`m.editor.filter.${f.id}` as MessageKey)}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** For videos (no still to show): a few colours, so each look's effect is visible. */
function SampleSwatch() {
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {['#D9534F', '#F0AD4E', '#5CB85C', '#428BCA'].map((col) => (
        <View key={col} style={{ flex: 1, backgroundColor: col }} />
      ))}
    </View>
  );
}

function AdjustSliders({ value, onChange }: { value: Adjustments; onChange: (k: AdjustmentKey, v: number) => void }) {
  const { t } = useT();
  return (
    <View style={{ gap: space[2] }}>
      {ADJUSTMENT_KEYS.map((k) => (
        <Slider
          key={k}
          label={t(ADJUST_LABELS[k])}
          value={value[k]}
          min={ADJUSTMENT_RANGES[k].min}
          max={ADJUSTMENT_RANGES[k].max}
          onChange={(v) => onChange(k, v)}
          format={(v) => (ADJUSTMENT_RANGES[k].min < 0 && v > 0 ? `+${v}` : String(v))}
        />
      ))}
    </View>
  );
}

/** Editor state with undo and reset. Changes marked `merge` within a moment of each other (one slider drag) are one undo step. */
function useHistory<T>(initial: T) {
  const [s, setS] = useState({ list: [initial], index: 0 });
  const lastMerge = useRef(0);
  const value = s.list[s.index]!;
  return {
    value,
    changed: value !== s.list[0],
    canUndo: s.index > 0,
    set: (next: T, merge = false) => {
      const now = Date.now();
      const join = merge && now - lastMerge.current < 800;
      lastMerge.current = merge ? now : 0;
      setS((cur) => {
        const base = cur.list.slice(0, join && cur.index > 0 ? cur.index : cur.index + 1);
        return { list: [...base, next].slice(-60), index: Math.min(base.length, 59) };
      });
    },
    undo: () => setS((cur) => ({ ...cur, index: Math.max(0, cur.index - 1) })),
    reset: () => setS((cur) => ({ list: [...cur.list.slice(0, cur.index + 1), cur.list[0]!], index: cur.index + 1 })),
  };
}

function Shell({
  title,
  busy,
  canUndo,
  onUndo,
  onReset,
  onCancel,
  onDone,
  stage,
  tabs,
  tab,
  onTab,
  children,
}: {
  title: string;
  busy?: boolean;
  canUndo: boolean;
  onUndo: () => void;
  onReset: () => void;
  onCancel: () => void;
  onDone: () => void;
  stage: ReactNode;
  tabs: { id: string; label: string }[];
  tab: string;
  onTab: (id: string) => void;
  children: ReactNode;
}) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={busy ? () => undefined : onCancel}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
          <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={onCancel} disabled={busy} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
            {title}
          </Text>
          <Button label={t('m.common.done')} size="sm" onPress={onDone} disabled={busy} />
        </View>
        <View style={{ flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }}>
          {stage}
          {busy ? <ActivityIndicator color="#fff" style={{ position: 'absolute' }} accessibilityLabel={t('m.common.saving')} /> : null}
        </View>
        <View style={{ padding: space[3], gap: space[3], maxHeight: '45%' }}>
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button label={t('m.editor.undo')} variant="secondary" size="sm" onPress={onUndo} disabled={!canUndo || busy} />
            <Button label={t('m.editor.reset')} variant="secondary" size="sm" onPress={onReset} disabled={!canUndo || busy} />
          </View>
          <Segmented label={title} options={tabs} value={tab} onChange={onTab} />
          <ScrollView contentContainerStyle={{ gap: space[3], paddingBottom: space[2] }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.editor.previewNote')}</Text>
        </View>
      </View>
    </Modal>
  );
}

// ─── Photo ─────────────────────────────────────────────────────────────

const SHAPES = [
  { id: 'original', ratio: null },
  { id: '1:1', ratio: 1 },
  { id: '4:5', ratio: 4 / 5 },
  { id: '9:16', ratio: 9 / 16 },
  { id: '16:9', ratio: 16 / 9 },
] as const;
type Shape = (typeof SHAPES)[number]['id'];

interface PhotoState {
  rotate: 0 | 90 | 180 | 270;
  flip: boolean;
  shape: Shape;
  filter: FilterId;
  adjustments: Adjustments;
}

export interface EditedPhoto {
  uri: string;
  width: number;
  height: number;
  /** The look and adjustments for the server, or null when there are none. */
  edits: EditorParamsInput | null;
}

/** Turn, flip and crop to a shape (centred), in that order, from a picture of w × h. */
async function renderGeometry(uri: string, w: number, h: number, s: PhotoState, compress: number) {
  let ctx = ImageManipulator.manipulate(uri);
  if (s.rotate) ctx = ctx.rotate(s.rotate);
  if (s.flip) ctx = ctx.flip('horizontal');
  const turned = s.rotate === 90 || s.rotate === 270;
  const W = turned ? h : w;
  const H = turned ? w : h;
  const ratio = SHAPES.find((x) => x.id === s.shape)!.ratio;
  if (ratio) {
    const cw = ratio * H <= W ? Math.round(ratio * H) : W;
    const ch = ratio * H <= W ? H : Math.round(W / ratio);
    ctx = ctx.crop({ originX: Math.floor((W - cw) / 2), originY: Math.floor((H - ch) / 2), width: cw, height: ch });
  }
  const ref = await ctx.renderAsync();
  return ref.saveAsync({ format: SaveFormat.JPEG, compress });
}

const adjustmentsOnly = (a: Adjustments) => Object.fromEntries(ADJUSTMENT_KEYS.filter((k) => a[k]).map((k) => [k, a[k]])) as Partial<Adjustments>;

export function PhotoEditor({ asset, onDone, onCancel }: { asset: Picked; onDone: (p: EditedPhoto) => void; onCancel: () => void }) {
  const { t } = useT();
  const h = useHistory<PhotoState>({ rotate: 0, flip: false, shape: 'original', filter: 'original', adjustments: NEUTRAL_ADJUSTMENTS });
  const s = h.value;
  const [tab, setTab] = useState('crop');
  const [base, setBase] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [preview, setPreview] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // A smaller upright copy to preview turns and crops quickly.
  useEffect(() => {
    let live = true;
    ImageManipulator.manipulate(asset.uri)
      .resize(asset.width >= asset.height ? { width: Math.min(1080, asset.width || 1080) } : { height: Math.min(1080, asset.height || 1080) })
      .renderAsync()
      .then((ref) => ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 }))
      .then((r) => live && (setBase(r), setPreview(r)))
      .catch(() => live && setBase({ uri: asset.uri, width: asset.width, height: asset.height }));
    return () => {
      live = false;
    };
  }, [asset.uri, asset.width, asset.height]);

  const geometryKey = `${s.rotate}-${s.flip}-${s.shape}`;
  useEffect(() => {
    if (!base) return;
    let live = true;
    renderGeometry(base.uri, base.width, base.height, s, 0.85)
      .then((r) => live && setPreview(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, geometryKey]);

  async function done() {
    const edits =
      s.filter !== 'original' || Object.keys(adjustmentsOnly(s.adjustments)).length ? { filter: s.filter, adjustments: adjustmentsOnly(s.adjustments) } : null;
    if (!s.rotate && !s.flip && s.shape === 'original') return onDone({ uri: asset.uri, width: asset.width, height: asset.height, edits });
    setBusy(true);
    try {
      const r = await renderGeometry(asset.uri, asset.width, asset.height, s, 0.92);
      onDone({ uri: r.uri, width: r.width, height: r.height, edits });
    } catch {
      setBusy(false);
      onDone({ uri: asset.uri, width: asset.width, height: asset.height, edits });
    }
  }

  const fit = preview && box.width ? Math.min(box.width / preview.width, box.height / preview.height) : 0;
  return (
    <Shell
      title={t('m.editor.photoTitle')}
      busy={busy}
      canUndo={h.canUndo}
      onUndo={h.undo}
      onReset={h.reset}
      onCancel={onCancel}
      onDone={() => void done()}
      tab={tab}
      onTab={setTab}
      tabs={[
        { id: 'crop', label: t('m.editor.tab.crop') },
        { id: 'filters', label: t('m.editor.tab.filters') },
        { id: 'adjust', label: t('m.editor.tab.adjust') },
      ]}
      stage={
        <View
          style={{ alignSelf: 'stretch', flex: 1, alignItems: 'center', justifyContent: 'center', margin: space[3] }}
          onLayout={(e) => setBox(e.nativeEvent.layout)}
        >
          {preview && fit ? (
            <LookPreview filter={s.filter} adjustments={s.adjustments} style={{ width: preview.width * fit, height: preview.height * fit }}>
              <Image source={{ uri: preview.uri }} accessibilityLabel={t('m.editor.preview')} style={{ width: '100%', height: '100%' }} />
            </LookPreview>
          ) : (
            <ActivityIndicator color="#fff" />
          )}
        </View>
      }
    >
      {tab === 'crop' ? (
        <>
          <Segmented
            label={t('m.editor.shape')}
            value={s.shape}
            onChange={(shape) => h.set({ ...s, shape })}
            options={SHAPES.map((x) => ({
              id: x.id,
              label: x.id === 'original' ? t('m.editor.shape.original') : x.id === '1:1' ? t('m.editor.shape.square') : x.id,
            }))}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              label={t('m.editor.turnLeft')}
              variant="secondary"
              size="sm"
              icon="arrow-undo"
              onPress={() => h.set({ ...s, rotate: ((s.rotate + 270) % 360) as PhotoState['rotate'] })}
            />
            <Button
              label={t('m.editor.turnRight')}
              variant="secondary"
              size="sm"
              icon="arrow-redo"
              onPress={() => h.set({ ...s, rotate: ((s.rotate + 90) % 360) as PhotoState['rotate'] })}
            />
            <Button
              label={t('m.editor.flip')}
              variant={s.flip ? 'primary' : 'secondary'}
              size="sm"
              icon="swap-horizontal"
              onPress={() => h.set({ ...s, flip: !s.flip })}
            />
          </View>
        </>
      ) : tab === 'filters' ? (
        <FilterChips value={s.filter} onChange={(filter) => h.set({ ...s, filter })} thumb={preview?.uri} />
      ) : (
        <AdjustSliders value={s.adjustments} onChange={(k, v) => h.set({ ...s, adjustments: { ...s.adjustments, [k]: v } }, true)} />
      )}
    </Shell>
  );
}

// ─── Video ─────────────────────────────────────────────────────────────

interface VideoState {
  start: number;
  end: number;
  filter: FilterId;
  adjustments: Adjustments;
  muted: boolean;
  cover: number | null;
}

export function VideoEditor({
  asset,
  maxSeconds,
  mustFit,
  onDone,
  onCancel,
}: {
  asset: Picked;
  maxSeconds: number;
  /** A reel: a longer video must be trimmed to fit. */
  mustFit: boolean;
  onDone: (edits: EditorParamsInput | null) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const c = useColors();
  const duration = Math.max(0, (asset.duration ?? 0) / 1000);
  const tooLong = duration > maxSeconds + 0.05;
  const round = (n: number) => Math.round(n * 10) / 10;
  const h = useHistory<VideoState>({
    start: 0,
    end: round(Math.min(duration, maxSeconds)),
    filter: 'original',
    adjustments: NEUTRAL_ADJUSTMENTS,
    muted: false,
    cover: null,
  });
  const s = h.value;
  const [tab, setTab] = useState('trim');
  const [box, setBox] = useState({ width: 0, height: 0 });
  const range = useRef(s);
  range.current = s;
  const player = useVideoPlayer(asset.uri, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.25;
    p.play();
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    const r = range.current;
    if (currentTime >= r.end || currentTime < r.start - 0.3) player.currentTime = r.start;
  });
  useEffect(() => {
    player.muted = s.muted;
  }, [player, s.muted]);

  const seek = (v: number) => {
    player.currentTime = v;
  };
  const setStart = (v: number) => {
    const start = Math.min(v, s.end - 1);
    h.set({ ...s, start, end: Math.min(s.end, start + maxSeconds), cover: s.cover === null ? null : Math.max(s.cover, start) }, true);
    seek(start);
  };
  const setEnd = (v: number) => {
    const end = Math.max(v, s.start + 1);
    h.set({ ...s, end, start: Math.max(s.start, end - maxSeconds), cover: s.cover === null ? null : Math.min(s.cover, end) }, true);
    seek(Math.max(0, end - 0.5));
  };

  function done() {
    if (!duration || (!h.changed && !(mustFit && tooLong))) return onDone(null);
    const full = s.start <= 0.05 && s.end >= duration - 0.05;
    const adjustments = adjustmentsOnly(s.adjustments);
    if (full && s.filter === 'original' && !Object.keys(adjustments).length && !s.muted && s.cover === null) return onDone(null);
    onDone({
      filter: s.filter,
      adjustments,
      trim: full ? undefined : { startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000) },
      muted: s.muted || undefined,
      coverMs: s.cover === null ? undefined : Math.round(s.cover * 1000),
    });
  }

  const ratio = asset.width && asset.height ? asset.width / asset.height : 9 / 16;
  const fit = box.width ? Math.min(box.width / ratio, box.height) : 0;
  return (
    <Shell
      title={t('m.editor.videoTitle')}
      canUndo={h.canUndo}
      onUndo={h.undo}
      onReset={h.reset}
      onCancel={onCancel}
      onDone={done}
      tab={tab}
      onTab={(id) => {
        setTab(id);
        if (id === 'more' && s.cover !== null) {
          player.pause();
          seek(s.cover);
        }
      }}
      tabs={[
        { id: 'trim', label: t('m.editor.tab.trim') },
        { id: 'filters', label: t('m.editor.tab.filters') },
        { id: 'adjust', label: t('m.editor.tab.adjust') },
        { id: 'more', label: t('m.editor.tab.more') },
      ]}
      stage={
        <View
          style={{ alignSelf: 'stretch', flex: 1, alignItems: 'center', justifyContent: 'center', margin: space[3] }}
          onLayout={(e) => setBox(e.nativeEvent.layout)}
        >
          {fit ? (
            <LookPreview filter={s.filter} adjustments={s.adjustments} style={{ width: fit * ratio, height: fit }}>
              <VideoView
                player={player}
                style={{ width: '100%', height: '100%' }}
                contentFit="contain"
                nativeControls={false}
                accessibilityLabel={t('m.editor.preview')}
              />
            </LookPreview>
          ) : null}
        </View>
      }
    >
      {tab === 'trim' ? (
        <>
          <Slider label={t('m.editor.start')} value={s.start} min={0} max={duration} step={0.1} onChange={setStart} format={clock} />
          <Slider label={t('m.editor.end')} value={s.end} min={0} max={duration} step={0.1} onChange={setEnd} format={clock} />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {t('m.editor.keeping', { start: clock(s.start), end: clock(s.end), length: clock(s.end - s.start) })}
            {tooLong ? ` ${t(mustFit ? 'm.editor.tooLongReel' : 'm.editor.tooLongEdit', { minutes: Math.round(maxSeconds / 60) })}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button
              label={t('m.common.play')}
              variant="secondary"
              size="sm"
              icon="play"
              onPress={() => {
                seek(s.start);
                player.play();
              }}
            />
            <Button label={t('m.common.pause')} variant="secondary" size="sm" icon="pause" onPress={() => player.pause()} />
          </View>
        </>
      ) : tab === 'filters' ? (
        <FilterChips value={s.filter} onChange={(filter) => h.set({ ...s, filter })} />
      ) : tab === 'adjust' ? (
        <AdjustSliders value={s.adjustments} onChange={(k, v) => h.set({ ...s, adjustments: { ...s.adjustments, [k]: v } }, true)} />
      ) : (
        <>
          <Slider
            label={t('m.editor.cover')}
            value={s.cover ?? s.start}
            min={s.start}
            max={s.end}
            step={0.1}
            format={clock}
            onChange={(v) => {
              player.pause();
              seek(v);
              h.set({ ...s, cover: v }, true);
            }}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.editor.coverHint')}</Text>
          {s.cover !== null ? (
            <Button
              label={t('m.editor.defaultCover')}
              variant="ghost"
              size="sm"
              onPress={() => h.set({ ...s, cover: null })}
              style={{ alignSelf: 'flex-start' }}
            />
          ) : null}
          <SwitchRow label={t('m.editor.mute')} value={s.muted} onValueChange={(muted) => h.set({ ...s, muted })} />
        </>
      )}
    </Shell>
  );
}
