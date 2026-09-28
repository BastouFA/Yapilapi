import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  COVER_MAX_STRAIGHTEN,
  COVER_MAX_ZOOM,
  COVER_RATIO,
  coverLayout,
  coverRatioOk,
  coverZoom,
  defaultCoverRecipe,
  fitCoverCrop,
  flipCoverCrop,
  moveCoverCrop,
  straightenScale,
  turnCoverRecipe,
  turnedSize,
  zoomCoverCrop,
  type CoverCrop,
  type CoverRecipe,
} from '../../../packages/shared/src/cover';
import { NEUTRAL_ADJUSTMENTS, type Adjustments } from '../../../packages/shared/src/filters';
import { profileAccentColors, THEME_SURFACES, type ThemeName } from '../../../packages/shared/src/profile-style';
import type { CoverPhoto, Profile } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { AdjustSliders, FilterChips, LookPreview, Slider } from './editor';
import { SuggestAltText } from './ai-helpers';
import { useT } from './i18n';
import { useReducedMotion } from './motion';
import { radius, space } from './theme';
import { Avatar, Button, Field, Icon, KeyboardAvoid, Notice, Segmented, useColors, userText } from './ui';

/**
 * The cover editor on the phone: frame the photo in the cover's 8:3 band (drag, pinch, or the
 * zoom slider; screen readers get move and zoom actions), turn, flip and straighten it, pick a
 * look and how strongly, adjust it, describe it, and see it behind the profile header in light
 * and dark. The phone only previews (the look with translucent layers, as in the post editor);
 * the server renders the cover from the original photo with the recipe.
 */

export type CoverEditorTab = 'frame' | 'look' | 'adjust' | 'preview';
type Size = { width: number; height: number };

/** The saved recipe when it still fits this photo, otherwise the widest centred crop. */
function startRecipe(saved: CoverRecipe | null | undefined, size: Size): CoverRecipe {
  if (!saved) return defaultCoverRecipe(size.width, size.height);
  const { W, H } = turnedSize(size.width, size.height, saved.rotate);
  return coverRatioOk(saved.crop, W, H) ? saved : { ...saved, crop: fitCoverCrop(W, H) };
}

const adjustmentsOf = (r: CoverRecipe): Adjustments => ({ ...NEUTRAL_ADJUSTMENTS, ...r.adjustments });
const cleanRecipe = (r: CoverRecipe): CoverRecipe => ({
  ...r,
  adjustments: Object.fromEntries(Object.entries(r.adjustments).filter(([, v]) => v)) as Partial<Adjustments>,
});

/** Undo history, like the post editor's: changes marked `merge` within a moment of each other are one step. */
function useRecipeHistory() {
  const [s, setS] = useState<{ list: CoverRecipe[]; index: number }>({ list: [], index: 0 });
  const lastMerge = useRef(0);
  return {
    value: s.list[s.index] ?? null,
    canUndo: s.index > 0,
    start: (r: CoverRecipe) => setS({ list: [r], index: 0 }),
    set: (next: CoverRecipe, merge = false) => {
      const now = Date.now();
      const join = merge && now - lastMerge.current < 800;
      lastMerge.current = merge ? now : 0;
      setS((cur) => {
        const base = cur.list.slice(0, join && cur.index > 0 ? cur.index : cur.index + 1);
        return { list: [...base, next].slice(-60), index: Math.min(base.length, 59) };
      });
    },
    undo: () => setS((cur) => ({ ...cur, index: Math.max(0, cur.index - 1) })),
    reset: () => setS((cur) => (cur.list.length ? { list: [...cur.list.slice(0, cur.index + 1), cur.list[0]!], index: cur.index + 1 } : cur)),
  };
}

/** The cover as it will look: the photo turned, flipped and straightened, the crop filling a band `width` wide. */
export function CoverBand({ uri, size, recipe, width, children }: { uri: string; size: Size; recipe: CoverRecipe; width: number; children?: ReactNode }) {
  const { W, H } = turnedSize(size.width, size.height, recipe.rotate);
  const l = coverLayout(recipe.crop, width);
  const quarter = recipe.rotate === 90 || recipe.rotate === 270;
  const iw = quarter ? l.height : l.width;
  const ih = quarter ? l.width : l.height;
  const s = straightenScale(W, H, recipe.straighten);
  return (
    <LookPreview
      filter={recipe.filter}
      adjustments={adjustmentsOf(recipe)}
      strength={recipe.filterStrength / 100}
      style={{ width, height: width / COVER_RATIO, backgroundColor: '#000' }}
    >
      <View pointerEvents="none" style={{ position: 'absolute', left: l.left, top: l.top, width: l.width, height: l.height }}>
        <Image
          source={{ uri }}
          accessibilityIgnoresInvertColors
          style={{
            position: 'absolute',
            left: (l.width - iw) / 2,
            top: (l.height - ih) / 2,
            width: iw,
            height: ih,
            transform: [
              { rotate: `${recipe.straighten}deg` },
              { scale: s },
              { scaleX: recipe.flipH ? -1 : 1 },
              { scaleY: recipe.flipV ? -1 : 1 },
              { rotate: `${recipe.rotate}deg` },
            ],
          }}
        />
      </View>
      {children}
    </LookPreview>
  );
}

export function CoverEditor({
  uri,
  width: givenWidth,
  height: givenHeight,
  profile,
  initial,
  initialTab = 'frame',
  title,
  altText,
  onAltText,
  describeMediaId,
  busy,
  error,
  onDone,
  onCancel,
}: {
  /** The original photo: a local file, or an upload's processed size. */
  uri: string;
  width?: number | null;
  height?: number | null;
  profile: Profile;
  initial?: CoverRecipe | null;
  initialTab?: CoverEditorTab;
  title: string;
  altText: string;
  onAltText: (text: string) => void;
  /** The upload to suggest a description for, once there is one. */
  describeMediaId?: string | null;
  busy?: boolean;
  error?: string | null;
  onDone: (recipe: CoverRecipe) => void;
  onCancel: () => void;
}) {
  const c = useColors();
  const { t, number } = useT();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [size, setSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<CoverEditorTab>(initialTab);
  const [stageWidth, setStageWidth] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const h = useRecipeHistory();
  const r = h.value;

  // The shown size, upright: what the picture's crop fractions refer to.
  useEffect(() => {
    let live = true;
    const use = (s: Size) => {
      if (!live) return;
      setSize(s);
      h.start(startRecipe(initial, s));
    };
    Image.getSize(
      uri,
      (width, height) => use({ width, height }),
      () => (givenWidth && givenHeight ? use({ width: givenWidth, height: givenHeight }) : live && setFailed(true)),
    );
    return () => {
      live = false;
    };
    // The saved recipe only matters when the photo first opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  const dims = size && r ? turnedSize(size.width, size.height, r.rotate) : null;
  const bandWidth = Math.max(0, stageWidth);
  const layout = r && bandWidth ? coverLayout(r.crop, bandWidth) : null;

  // Drag with one finger, pinch with two. The latest values live in a ref: the responder is made once.
  const latest = useRef({ r, dims, layout, set: h.set });
  latest.current = { r, dims, layout, set: h.set };
  const gesture = useRef<{ crop: CoverCrop; zoom: number; x: number; y: number; dist: number; touches: number } | null>(null);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => (gesture.current = null),
      onPanResponderMove: (e) => {
        const { r: cur, dims: d, layout: l, set } = latest.current;
        const touches = e.nativeEvent.touches;
        if (!cur || !d || !l || !touches.length) return;
        const x = touches.reduce((a, p) => a + p.pageX, 0) / touches.length;
        const y = touches.reduce((a, p) => a + p.pageY, 0) / touches.length;
        const dist = touches.length > 1 ? Math.hypot(touches[0]!.pageX - touches[1]!.pageX, touches[0]!.pageY - touches[1]!.pageY) : 0;
        const g = gesture.current;
        // A finger added or lifted starts the gesture again from here.
        if (!g || g.touches !== touches.length) {
          gesture.current = { crop: cur.crop, zoom: coverZoom(cur.crop, d.W, d.H), x, y, dist, touches: touches.length };
          return;
        }
        let crop = g.crop;
        if (g.touches > 1 && g.dist > 0) crop = zoomCoverCrop(crop, d.W, d.H, g.zoom * (dist / g.dist));
        // Moving the photo right shows more of its left side.
        crop = moveCoverCrop(crop, -(x - g.x) / l.width, -(y - g.y) / l.height);
        set({ ...cur, crop }, true);
      },
      onPanResponderRelease: () => (gesture.current = null),
      onPanResponderTerminate: () => (gesture.current = null),
    }),
  ).current;

  if (!r || !size || !dims) {
    return (
      <Modal animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={onCancel}>
        <View style={{ flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: space[3], padding: space[4] }}>
          {failed ? (
            <>
              <Text style={{ color: '#fff', textAlign: 'center' }}>{t('coverEditor.cantOpen')}</Text>
              <Button label={t('common.cancel')} variant="secondary" onPress={onCancel} />
            </>
          ) : (
            <ActivityIndicator color="#fff" accessibilityLabel={t('photoEditor.opening')} />
          )}
        </View>
      </Modal>
    );
  }

  const zoom = coverZoom(r.crop, dims.W, dims.H);
  const set = (next: CoverRecipe, merge = false) => h.set(next, merge);
  const step = 0.05;
  const zoomText = `${number(Math.round(zoom * 10) / 10)}×`;
  const move = (dx: number, dy: number) => set({ ...r, crop: moveCoverCrop(r.crop, dx * r.crop.w, dy * r.crop.h) });

  return (
    <Modal animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={busy ? () => undefined : onCancel}>
      {/* The description field is at the bottom of the tools: the keyboard makes room instead of covering it. */}
      <KeyboardAvoid offset={0} style={{ backgroundColor: c.ground, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
          <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={onCancel} disabled={busy} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
            {title}
          </Text>
          <Button label={t('common.save')} size="sm" onPress={() => onDone(cleanRecipe(r))} disabled={busy} />
        </View>
        <View
          style={{ backgroundColor: '#111', paddingVertical: space[4], paddingHorizontal: space[3] }}
          onLayout={(e) => setStageWidth(e.nativeEvent.layout.width - space[3] * 2)}
        >
          {bandWidth ? (
            <View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={t('coverEditor.frameRole')}
              accessibilityValue={{ text: t('coverEditor.frameValue', { zoom: zoomText }) }}
              accessibilityHint={t('coverEditor.frameHintPhone')}
              accessibilityActions={[
                { name: 'increment', label: t('coverEditor.zoomIn') },
                { name: 'decrement', label: t('coverEditor.zoomOut') },
                { name: 'left', label: t('coverEditor.move.left') },
                { name: 'right', label: t('coverEditor.move.right') },
                { name: 'up', label: t('coverEditor.move.up') },
                { name: 'down', label: t('coverEditor.move.down') },
              ]}
              onAccessibilityAction={(e) => {
                const a = e.nativeEvent.actionName;
                if (a === 'increment' || a === 'decrement')
                  set({ ...r, crop: zoomCoverCrop(r.crop, dims.W, dims.H, zoom + (a === 'increment' ? 0.25 : -0.25)) });
                if (a === 'left') move(-step, 0);
                if (a === 'right') move(step, 0);
                if (a === 'up') move(0, -step);
                if (a === 'down') move(0, step);
              }}
              style={{ alignSelf: 'center' }}
              {...pan.panHandlers}
            >
              <CoverBand uri={uri} size={size} recipe={r} width={bandWidth}>
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' }]} />
              </CoverBand>
            </View>
          ) : null}
          {busy ? (
            <ActivityIndicator color="#fff" style={{ position: 'absolute', alignSelf: 'center', top: '45%' }} accessibilityLabel={t('m.common.saving')} />
          ) : null}
        </View>
        <View style={{ flex: 1, padding: space[3], gap: space[3] }}>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button label={t('m.editor.undo')} variant="secondary" size="sm" onPress={h.undo} disabled={!h.canUndo || busy} />
            <Button label={t('m.editor.reset')} variant="secondary" size="sm" onPress={h.reset} disabled={!h.canUndo || busy} />
          </View>
          <Segmented
            label={title}
            value={tab}
            onChange={setTab}
            options={[
              { id: 'frame', label: t('coverEditor.tab.frame') },
              { id: 'look', label: t('m.editor.tab.filters') },
              { id: 'adjust', label: t('m.editor.tab.adjust') },
              { id: 'preview', label: t('coverEditor.tab.preview') },
            ]}
          />
          <ScrollView contentContainerStyle={{ gap: space[3], paddingBottom: space[4] }} keyboardShouldPersistTaps="handled">
            {tab === 'frame' ? (
              <>
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('coverEditor.frameHintPhone')}</Text>
                <Slider
                  label={t('coverEditor.zoom')}
                  value={Math.round(zoom * 100) / 100}
                  min={1}
                  max={COVER_MAX_ZOOM}
                  step={0.05}
                  format={(v) => `${number(Math.round(v * 10) / 10)}×`}
                  onChange={(v) => set({ ...r, crop: zoomCoverCrop(r.crop, dims.W, dims.H, v) }, true)}
                />
                <Slider
                  label={t('coverEditor.straighten')}
                  value={r.straighten}
                  min={-COVER_MAX_STRAIGHTEN}
                  max={COVER_MAX_STRAIGHTEN}
                  step={0.5}
                  format={(v) => `${v > 0 ? '+' : ''}${number(v)}°`}
                  onChange={(v) => set({ ...r, straighten: v }, true)}
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  <Button
                    label={t('m.editor.turnLeft')}
                    variant="secondary"
                    size="sm"
                    icon="arrow-undo"
                    onPress={() => set(turnCoverRecipe(r, size.width, size.height, -1))}
                  />
                  <Button
                    label={t('m.editor.turnRight')}
                    variant="secondary"
                    size="sm"
                    icon="arrow-redo"
                    onPress={() => set(turnCoverRecipe(r, size.width, size.height, 1))}
                  />
                  <Button
                    label={t('m.editor.flip')}
                    variant={r.flipH ? 'primary' : 'secondary'}
                    size="sm"
                    icon="swap-horizontal"
                    onPress={() => set({ ...r, flipH: !r.flipH, crop: flipCoverCrop(r.crop, 'h') })}
                  />
                  <Button
                    label={t('coverEditor.centre')}
                    variant="ghost"
                    size="sm"
                    onPress={() => set({ ...r, crop: zoomCoverCrop({ ...r.crop, x: 0.5 - r.crop.w / 2, y: 0.5 - r.crop.h / 2 }, dims.W, dims.H, zoom) })}
                  />
                  {r.straighten ? (
                    <Button label={t('coverEditor.straightenReset')} variant="ghost" size="sm" onPress={() => set({ ...r, straighten: 0 })} />
                  ) : null}
                </View>
              </>
            ) : tab === 'look' ? (
              <>
                <FilterChips value={r.filter} onChange={(filter) => set({ ...r, filter })} thumb={uri} />
                {r.filter !== 'original' ? (
                  <Slider
                    label={t('coverEditor.strength')}
                    value={r.filterStrength}
                    min={0}
                    max={100}
                    onChange={(v) => set({ ...r, filterStrength: v }, true)}
                    format={(v) => number(v)}
                  />
                ) : null}
              </>
            ) : tab === 'adjust' ? (
              <AdjustSliders value={adjustmentsOf(r)} onChange={(k, v) => set({ ...r, adjustments: { ...r.adjustments, [k]: v } }, true)} />
            ) : (
              <>
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('coverEditor.previewNote')}</Text>
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  {(['light', 'dark'] as const).map((theme) => (
                    <HeaderPreview key={theme} theme={theme} profile={profile} uri={uri} size={size} recipe={r} />
                  ))}
                </View>
                <Field
                  label={t('profilePlus.describe')}
                  hint={t('profilePlus.describeHint')}
                  value={altText}
                  onChangeText={onAltText}
                  maxLength={300}
                  multiline
                />
                {describeMediaId ? <SuggestAltText mediaId={describeMediaId} onSuggested={(text) => onAltText(text.slice(0, 300))} onError={setNote} /> : null}
                {note ? <Notice tone="danger">{note}</Notice> : null}
              </>
            )}
          </ScrollView>
          <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('coverEditor.saveNote')}</Text>
        </View>
      </KeyboardAvoid>
    </Modal>
  );
}

/** The cover behind a small copy of the profile header in one theme: the fade, the avatar over it, the name. */
function HeaderPreview({ theme, profile, uri, size, recipe }: { theme: ThemeName; profile: Profile; uri: string; size: Size; recipe: CoverRecipe }) {
  const { t } = useT();
  const [width, setWidth] = useState(0);
  const s = THEME_SURFACES[theme];
  const accent = profileAccentColors(profile.style?.accent ?? null, theme);
  const muted = theme === 'dark' ? '#9AA0BC' : '#555B75';
  return (
    <View
      accessible
      accessibilityLabel={t('coverEditor.previewIn', { theme: t(theme === 'dark' ? 'st.appearance.dark' : 'st.appearance.light') })}
      style={{
        flex: 1,
        backgroundColor: s.ground,
        borderRadius: radius.md,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme === 'dark' ? '#262A40' : '#E3E5EF',
      }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width ? (
        <CoverBand uri={uri} size={size} recipe={recipe} width={width}>
          <LinearGradient pointerEvents="none" colors={[`${s.ground}00`, `${s.ground}00`, s.ground]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
        </CoverBand>
      ) : null}
      <View style={{ alignItems: 'center', marginTop: -22, paddingHorizontal: 6, paddingBottom: 8, gap: 2 }}>
        <View style={{ borderRadius: 999, borderWidth: 3, borderColor: s.ground }}>
          <Avatar name={profile.displayName} url={profile.avatarUrl} size={40} />
        </View>
        <Text numberOfLines={1} style={[{ color: s.ink, fontWeight: '800', fontSize: 13 }, userText]}>
          {profile.displayName}
        </Text>
        <Text numberOfLines={1} style={{ color: muted, fontSize: 11 }}>
          @{profile.username}
        </Text>
        <View style={{ marginTop: 4, backgroundColor: accent.accent, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
          <Text style={{ color: accent.onAccent, fontWeight: '700', fontSize: 11 }}>{t('profile.follow')}</Text>
        </View>
        <Text style={{ color: muted, fontSize: 11, marginTop: 2 }}>{t(theme === 'dark' ? 'st.appearance.dark' : 'st.appearance.light')}</Text>
      </View>
    </View>
  );
}

/** Your recent photos that can be a cover, with a way to pick a new one from the phone. */
export function CoverPhotoPicker({
  visible,
  onPick,
  onUpload,
  onClose,
}: {
  visible: boolean;
  onPick: (p: CoverPhoto) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const c = useColors();
  const { t, date } = useT();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [items, setItems] = useState<CoverPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    setError(null);
    client()
      .then((api) => api.me.coverPhotos())
      .then((r) => live && setItems(r.items))
      .catch((e) => live && (setItems([]), setError(errorMessage(e))));
    return () => {
      live = false;
    };
  }, [visible]);
  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: space[3], paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[3], gap: space[2] }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 18, fontWeight: '800' }}>
            {t('coverEditor.choose')}
          </Text>
          <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={onClose} />
        </View>
        <View style={{ padding: space[3], gap: space[3] }}>
          <Button label={t('coverEditor.upload')} icon="image-outline" variant="secondary" onPress={onUpload} />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Text style={{ color: c.ink, fontWeight: '700' }}>{t('coverEditor.recent')}</Text>
        </View>
        {items === null ? (
          <ActivityIndicator color={c.yapi} />
        ) : items.length ? (
          <FlatList
            data={items}
            numColumns={3}
            keyExtractor={(p) => p.id}
            contentContainerStyle={{ paddingHorizontal: space[3], gap: space[2] }}
            columnWrapperStyle={{ gap: space[2] }}
            renderItem={({ item }) => {
              const when = t('coverEditor.photoFrom', { date: date(item.createdAt) });
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={item.altText ? `${item.altText}. ${when}` : when}
                  onPress={() => onPick(item)}
                  style={({ pressed }) => ({
                    flex: 1 / 3,
                    aspectRatio: 1,
                    borderRadius: radius.sm,
                    overflow: 'hidden',
                    opacity: pressed ? 0.8 : 1,
                    backgroundColor: c.surfaceSunken,
                  })}
                >
                  <Image source={{ uri: mediaUrl(item.thumbUrl) }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
                </Pressable>
              );
            }}
          />
        ) : (
          <View style={{ padding: space[4], alignItems: 'center', gap: space[2] }}>
            <Icon name="images-outline" size={28} color={c.inkMuted} />
            <Text style={{ color: c.inkMuted, textAlign: 'center' }}>{t('coverEditor.noRecent')}</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
