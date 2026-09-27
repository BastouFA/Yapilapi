import { useEventListener } from 'expo';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewToken,
} from 'react-native';
import { FlatList, Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hls360 } from '../../../packages/shared/src/data-saver';
import type { MediaItem } from '../../../packages/shared/src/types';
import { mediaUrl } from './api';
import { CaptionOverlay, useCaptionCues } from './captions';
import { useDataSaver } from './data-saver';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Icon, userText } from './ui';

const WHITE = '#FFFFFF';
const SCRIM = 'rgba(5,6,11,0.55)';
const MAX_ZOOM = 4;
const TAP_ZOOM = 2.5;
/** Dragging a photo down this far (or flicking it) closes the viewer. */
const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 900;
const VIEWABILITY = { itemVisiblePercentThreshold: 60 };
const TOP_BAR = 56;

/** Whether the person asked for less motion: then nothing springs or slides. */
export function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

function useScreenReader() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setOn);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => sub.remove();
  }, []);
  return on;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Full screen photos and videos from a post: swipe sideways between them, pinch or double tap a
 * photo to zoom (drag to look around while zoomed), drag down to close. Videos fit the screen and
 * play with their controls and subtitles. The description (alt text) shows at the bottom; a tap
 * on a photo hides or shows it with the top bar.
 */
export function MediaViewer({ media, index, onClose }: { media: MediaItem[]; index: number; onClose: () => void }) {
  const { t, number } = useT();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduce = useReducedMotion();
  const reader = useScreenReader();
  const [current, setCurrent] = useState(Math.min(index, media.length - 1));
  const [zoomed, setZoomed] = useState(false);
  const [chromeOn, setChromeOn] = useState(true);
  // With a screen reader on, the close button and the description always stay.
  const chrome = chromeOn || reader;
  const list = useRef<FlatList<MediaItem>>(null);
  const drag = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    onClose();
  }, [onClose]);

  const toggleChrome = useCallback(() => setChromeOn((v) => !v), []);
  const onDrag = useCallback((dy: number) => drag.setValue(dy), [drag]);
  const onDragEnd = useCallback(
    (dy: number, vy: number) => {
      if (dy > CLOSE_DISTANCE || (dy > 24 && vy > CLOSE_VELOCITY)) {
        if (reduce) return close();
        Animated.timing(drag, { toValue: height, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(close);
      } else if (reduce) drag.setValue(0);
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    },
    [drag, height, reduce, close],
  );
  const backdrop = drag.interpolate({ inputRange: [-height, 0, height * 0.6], outputRange: [0.5, 1, 0.15], extrapolate: 'clamp' });

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<MediaItem>[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setCurrent(first.index);
  }).current;

  // Moving to another photo leaves the zoom behind; screen readers hear where they are.
  const first = useRef(true);
  useEffect(() => {
    setZoomed(false);
    if (first.current) {
      first.current = false;
      return;
    }
    if (media.length > 1) AccessibilityInfo.announceForAccessibility(t('m.boards.position', { index: number(current + 1), total: number(media.length) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const go = (d: number) => {
    const to = clamp(current + d, 0, media.length - 1);
    if (to === current) return;
    list.current?.scrollToIndex({ index: to, animated: !reduce });
    setCurrent(to);
  };

  const item = media[current];
  const labelOf = (m: MediaItem, i: number) =>
    m.altText ||
    t(m.kind === 'video' ? 'm.viewer.videoOf' : 'ds.media.photoOf', {
      index: number(i + 1),
      total: number(media.length),
    });

  return (
    <Modal
      visible
      transparent
      animationType={reduce ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={close}
      supportedOrientations={['portrait', 'landscape']}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="light" hidden={!chrome} />
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdrop }]} />
        <Animated.View style={{ flex: 1, transform: [{ translateY: drag }] }}>
          <FlatList
            ref={list}
            data={media}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed && media.length > 1}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={Math.min(index, media.length - 1)}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            keyExtractor={(m) => m.id}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            viewabilityConfig={VIEWABILITY}
            onViewableItemsChanged={onViewable}
            extraData={current}
            renderItem={({ item: m, index: i }) =>
              m.kind === 'video' ? (
                <VideoPage
                  item={m}
                  label={labelOf(m, i)}
                  width={width}
                  height={height}
                  top={insets.top + TOP_BAR}
                  bottom={insets.bottom}
                  active={i === current}
                  onDrag={onDrag}
                  onDragEnd={onDragEnd}
                />
              ) : (
                <PhotoPage
                  item={m}
                  label={labelOf(m, i)}
                  width={width}
                  height={height}
                  active={i === current}
                  reduce={reduce}
                  onZoom={setZoomed}
                  onDrag={onDrag}
                  onDragEnd={onDragEnd}
                  onTap={toggleChrome}
                />
              )
            }
          />
        </Animated.View>

        {chrome ? (
          <View style={[s.top, { top: insets.top + space[2] }]} pointerEvents="box-none">
            {media.length > 1 ? (
              <View style={s.pill}>
                <Text style={{ color: WHITE, fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'] }}>
                  {t('m.boards.position', { index: number(current + 1), total: number(media.length) })}
                </Text>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={6} onPress={close} style={s.round}>
              <Icon name="close" size={24} color={WHITE} />
            </Pressable>
          </View>
        ) : null}
        {/* Previous and next, for screen readers (everyone else swipes). */}
        {media.length > 1 && reader ? (
          <View style={[s.top, { top: insets.top + space[2] + 52 }]} pointerEvents="box-none">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ds.previous')}
              accessibilityState={{ disabled: current === 0 }}
              onPress={() => go(-1)}
              style={s.round}
            >
              <Icon name="chevron-back" size={22} color={WHITE} directional />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ds.next')}
              accessibilityState={{ disabled: current === media.length - 1 }}
              onPress={() => go(1)}
              style={s.round}
            >
              <Icon name="chevron-forward" size={22} color={WHITE} directional />
            </Pressable>
          </View>
        ) : null}
        {chrome && item?.kind !== 'video' && item?.altText ? <AltText text={item.altText} bottom={insets.bottom + space[3]} /> : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

function AltText({ text, bottom }: { text: string; bottom?: number }) {
  const { t } = useT();
  return (
    <View style={[s.alt, bottom !== undefined ? { position: 'absolute', start: space[3], end: space[3], bottom } : null]}>
      <ScrollView style={{ maxHeight: 132 }} contentContainerStyle={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-start' }}>
        <View style={s.altBadge} accessibilityElementsHidden importantForAccessibility="no">
          <Text style={{ color: '#0B0C14', fontWeight: '800', fontSize: 11 }}>{t('ds.media.alt')}</Text>
        </View>
        <Text style={[{ color: WHITE, fontSize: 14, lineHeight: 20, flex: 1 }, userText]}>{text}</Text>
      </ScrollView>
    </View>
  );
}

/** A photo that zooms: pinch around your fingers, double tap to zoom in or out, drag while zoomed. */
function PhotoPage({
  item,
  label,
  width,
  height,
  active,
  reduce,
  onZoom,
  onDrag,
  onDragEnd,
  onTap,
}: {
  item: MediaItem;
  label: string;
  width: number;
  height: number;
  active: boolean;
  reduce: boolean;
  onZoom: (zoomed: boolean) => void;
  onDrag: (dy: number) => void;
  onDragEnd: (dy: number, vy: number) => void;
  onTap: () => void;
}) {
  const { t } = useT();
  const saver = useDataSaver().active;
  const uri = mediaUrl(saver ? (item.variants?.medium ?? item.url) : (item.variants?.large ?? item.variants?.medium ?? item.url));
  const [natural, setNatural] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const ratio = item.width && item.height ? item.width / item.height : (natural ?? width / height);
  // The photo's size at 1×: as large as fits.
  const fitW = Math.min(width, height * ratio);
  const fitH = fitW / ratio;

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const st = useRef({ s: 1, baseS: 1, x: 0, y: 0, baseX: 0, baseY: 0, fx: 0, fy: 0, pinching: false }).current;
  const [zoomed, setZoomed] = useState(false);
  const size = useRef({ width, height, fitW, fitH });
  size.current = { width, height, fitW, fitH };

  const bounds = (sc: number) => ({
    x: Math.max(0, (size.current.fitW * sc - size.current.width) / 2),
    y: Math.max(0, (size.current.fitH * sc - size.current.height) / 2),
  });
  const setZoom = (z: boolean) => {
    setZoomed(z);
    onZoom(z);
  };
  const place = (sc: number, x: number, y: number, animate: boolean) => {
    st.s = sc;
    st.x = x;
    st.y = y;
    if (!animate || reduce) {
      scale.setValue(sc);
      tx.setValue(x);
      ty.setValue(y);
    } else {
      const spring = (v: Animated.Value, to: number) => Animated.spring(v, { toValue: to, useNativeDriver: true, bounciness: 2, speed: 18 });
      Animated.parallel([spring(scale, sc), spring(tx, x), spring(ty, y)]).start();
    }
  };
  /** Keep the zoomed photo covering the screen where it can, and snap back to 1× below it. */
  const settle = () => {
    const sc = clamp(st.s, 1, MAX_ZOOM);
    if (sc <= 1.01) {
      place(1, 0, 0, true);
      setZoom(false);
      return;
    }
    const b = bounds(sc);
    place(sc, clamp(st.x, -b.x, b.x), clamp(st.y, -b.y, b.y), true);
    setZoom(true);
  };

  // Swiping to another photo leaves this one at 1×.
  useEffect(() => {
    if (active || st.s === 1) return;
    place(1, 0, 0, false);
    setZoomed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart((e) => {
        st.pinching = true;
        st.baseS = st.s;
        st.baseX = st.x;
        st.baseY = st.y;
        // The focal point, from the photo's centre.
        st.fx = e.focalX - size.current.width / 2;
        st.fy = e.focalY - size.current.height / 2;
      })
      .onUpdate((e) => {
        const sc = clamp(st.baseS * e.scale, 0.8, MAX_ZOOM + 1);
        const k = sc / st.baseS;
        st.s = sc;
        st.x = st.fx - (st.fx - st.baseX) * k;
        st.y = st.fy - (st.fy - st.baseY) * k;
        scale.setValue(sc);
        tx.setValue(st.x);
        ty.setValue(st.y);
      })
      .onEnd(() => {
        st.pinching = false;
        settle();
      });
    const pan = Gesture.Pan().runOnJS(true).averageTouches(true);
    // At 1× the drag is up or down only (sideways belongs to the swipe between photos).
    if (!zoomed) pan.activeOffsetY([-12, 12]).failOffsetX([-12, 12]);
    else pan.minDistance(2);
    pan
      .onStart(() => {
        st.baseX = st.x;
        st.baseY = st.y;
      })
      .onUpdate((e) => {
        if (st.pinching) return;
        if (st.s > 1.01) {
          st.x = st.baseX + e.translationX;
          st.y = st.baseY + e.translationY;
          tx.setValue(st.x);
          ty.setValue(st.y);
        } else onDrag(e.translationY);
      })
      .onEnd((e) => {
        if (st.pinching) return;
        if (st.s > 1.01) settle();
        else onDragEnd(e.translationY, e.velocityY);
      });
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((e, ok) => {
        if (!ok) return;
        if (st.s > 1.01) {
          place(1, 0, 0, true);
          setZoom(false);
          return;
        }
        const fx = e.x - size.current.width / 2;
        const fy = e.y - size.current.height / 2;
        const b = bounds(TAP_ZOOM);
        place(TAP_ZOOM, clamp(fx - fx * TAP_ZOOM, -b.x, b.x), clamp(fy - fy * TAP_ZOOM, -b.y, b.y), true);
        setZoom(true);
      });
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((_e, ok) => {
        if (ok) onTap();
      });
    return Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, tap));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, onDrag, onDragEnd, onTap, reduce]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={{ width, height, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        accessibilityHint={t('m.viewer.zoomHint')}
        accessibilityActions={[{ name: 'activate', label: zoomed ? t('m.viewer.zoomOut') : t('m.viewer.zoomIn') }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName !== 'activate') return;
          if (zoomed) {
            place(1, 0, 0, true);
            setZoom(false);
          } else {
            place(TAP_ZOOM, 0, 0, true);
            setZoom(true);
          }
        }}
      >
        {item.placeholder && !ready ? (
          <Image source={{ uri: item.placeholder }} blurRadius={16} style={{ position: 'absolute', width: fitW, height: fitH }} resizeMode="cover" />
        ) : null}
        {!ready ? <ActivityIndicator color={WHITE} style={{ position: 'absolute' }} /> : null}
        <Animated.Image
          source={{ uri }}
          accessibilityIgnoresInvertColors
          onLoad={(e) => {
            const src = e.nativeEvent.source;
            if (src?.width && src?.height) setNatural(src.width / src.height);
            setReady(true);
          }}
          style={{ width: fitW, height: fitH, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}
          resizeMode="contain"
        />
      </View>
    </GestureDetector>
  );
}

/** A video from a post: fitted to the screen (never cropped), with the player's controls and subtitles. */
function VideoPage({
  item,
  label,
  width,
  height,
  top,
  bottom,
  active,
  onDrag,
  onDragEnd,
}: {
  item: MediaItem;
  label: string;
  width: number;
  height: number;
  top: number;
  bottom: number;
  active: boolean;
  onDrag: (dy: number) => void;
  onDragEnd: (dy: number, vy: number) => void;
}) {
  const saver = useDataSaver().active;
  const src = mediaUrl(saver ? (item.variants?.mp4_360 ?? hls360(item) ?? item.variants?.mp4 ?? item.url) : (item.variants?.mp4 ?? item.url));
  const player = useVideoPlayer(src, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.25;
  });
  const [seconds, setSeconds] = useState(0);
  useEventListener(player, 'timeUpdate', ({ currentTime }) => setSeconds(currentTime));
  // The video on screen plays (on Data saver it waits for play); the others pause.
  useEffect(() => {
    if (active && !saver) player.play();
    else if (!active) player.pause();
  }, [active, saver, player]);
  const cues = useCaptionCues(item, active);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY([-12, 12])
        .failOffsetX([-12, 12])
        .onUpdate((e) => onDrag(e.translationY))
        .onEnd((e) => onDragEnd(e.translationY, e.velocityY)),
    [onDrag, onDragEnd],
  );

  return (
    <View style={{ width, height, paddingTop: top, paddingBottom: bottom + space[2], gap: space[2] }}>
      <GestureDetector gesture={pan}>
        <View collapsable={false} style={{ flex: 1 }}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            nativeControls
            allowsPictureInPicture={false}
            accessibilityLabel={label}
          />
          <CaptionOverlay cues={cues} seconds={seconds} bottom={64} />
        </View>
      </GestureDetector>
      {item.altText ? (
        <View style={{ paddingHorizontal: space[3] }}>
          <AltText text={item.altText} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  top: { position: 'absolute', start: space[3], end: space[3], flexDirection: 'row', alignItems: 'center', gap: space[2] },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: SCRIM },
  pill: { minHeight: 32, paddingHorizontal: space[3], borderRadius: radius.full, justifyContent: 'center', backgroundColor: SCRIM },
  alt: { padding: space[3], borderRadius: radius.md, backgroundColor: 'rgba(5,6,11,0.72)' },
  altBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: WHITE, marginTop: 2 },
});
