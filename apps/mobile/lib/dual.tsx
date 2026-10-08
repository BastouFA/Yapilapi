import { Directory, File, Paths } from 'expo-file-system';
import { useRef, useState } from 'react';
import { Animated, Image, PanResponder, Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dualInsetBox, nearestDualCorner, type DualCorner } from '../../../packages/shared/src/dual';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import { client, mediaUrl } from './api';
import { useT } from './i18n';
import { uploadFile, type Picked } from './media';
import { radius, space } from './theme';

export interface Shot {
  uri: string;
  width: number;
  height: number;
}

const WHITE = '#FFFFFF';
const CORNER_LABEL: Record<DualCorner, MessageKey> = {
  'top-left': 'm.camera.corner.topLeft',
  'top-right': 'm.camera.corner.topRight',
  'bottom-left': 'm.camera.corner.bottomLeft',
  'bottom-right': 'm.camera.corner.bottomRight',
};
const ACTIONS: { name: string; corner: DualCorner }[] = [
  { name: 'topLeft', corner: 'top-left' },
  { name: 'topRight', corner: 'top-right' },
  { name: 'bottomLeft', corner: 'bottom-left' },
  { name: 'bottomRight', corner: 'bottom-right' },
];

/**
 * Put the two photos together on the server (POST /v1/media/dual), then bring the result back to
 * the phone so Create can open it in the photo editor like any other photo.
 */
export async function composeOnServer(back: Shot, front: Shot, corner: DualCorner): Promise<Picked> {
  const [b, f] = await Promise.all([uploadFile(back.uri, 'back.jpg', 'image/jpeg'), uploadFile(front.uri, 'front.jpg', 'image/jpeg')]);
  const api = await client();
  const started = await api.media.dual({ backId: b.id, frontId: f.id, corner });
  const done = await api.media.waitUntilReady(started.media.id);
  const dir = new Directory(Paths.cache, 'both-sides');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = await File.downloadFileAsync(mediaUrl(done.url), new File(dir, `${done.id}.jpg`));
  return {
    uri: file.uri,
    type: 'image',
    mimeType: 'image/jpeg',
    fileName: 'both-sides.jpg',
    width: done.width ?? back.width,
    height: done.height ?? back.height,
    fileSize: file.size || undefined,
  };
}

/**
 * Check a "Both sides" photo before using it: the back camera photo with the front one in a
 * corner. Drag the small photo to another corner (screen readers: actions for each corner).
 */
export function DualReview({
  back,
  front,
  corner,
  onCorner,
  onRetake,
  onUse,
  busy,
}: {
  back: Shot;
  front: Shot;
  corner: DualCorner;
  onCorner: (c: DualCorner) => void;
  onRetake: () => void;
  onUse: () => void;
  busy: boolean;
}) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [area, setArea] = useState({ w: 0, h: 0 });
  const drag = useRef(new Animated.ValueXY()).current;
  const scale = area.w && area.h ? Math.min(area.w / back.width, area.h / back.height) : 0;
  const shown = { w: back.width * scale, h: back.height * scale };
  const box = dualInsetBox(back.width, back.height, front.width, front.height, corner);
  const latest = useRef({ box, back, shown, onCorner });
  latest.current = { box, back, shown, onCorner };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: Animated.event([null, { dx: drag.x, dy: drag.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        const l = latest.current;
        if (l.shown.w && l.shown.h) {
          const cx = (l.box.left + l.box.width / 2) / l.back.width + g.dx / l.shown.w;
          const cy = (l.box.top + l.box.height / 2) / l.back.height + g.dy / l.shown.h;
          l.onCorner(nearestDualCorner(cx, cy));
        }
        drag.setValue({ x: 0, y: 0 });
      },
      onPanResponderTerminate: () => drag.setValue({ x: 0, y: 0 }),
    }),
  ).current;

  const onAction = (e: AccessibilityActionEvent) => {
    const a = ACTIONS.find((x) => x.name === e.nativeEvent.actionName);
    if (a) onCorner(a.corner);
  };

  return (
    <View style={[StyleSheet.absoluteFill, s.root, { paddingTop: insets.top + space[3], paddingBottom: insets.bottom + space[4] }]} accessibilityViewIsModal>
      <View style={{ gap: 4, paddingHorizontal: space[4] }}>
        <Text accessibilityRole="header" style={s.title}>
          {t('m.camera.dual')}
        </Text>
        <Text style={s.hint}>{t('m.camera.dualDrag')}</Text>
      </View>
      <View style={s.stage} onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        {scale ? (
          <View style={{ width: shown.w, height: shown.h }}>
            <Image source={{ uri: back.uri }} style={{ width: shown.w, height: shown.h }} resizeMode="cover" accessibilityIgnoresInvertColors />
            <Animated.View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={t('m.camera.dualInset', { corner: t(CORNER_LABEL[corner]) })}
              accessibilityActions={ACTIONS.map((a) => ({ name: a.name, label: t(CORNER_LABEL[a.corner]) }))}
              onAccessibilityAction={onAction}
              {...pan.panHandlers}
              style={{
                position: 'absolute',
                left: box.left * scale,
                top: box.top * scale,
                width: box.width * scale,
                height: box.height * scale,
                borderRadius: box.radius * scale,
                borderWidth: Math.max(1, box.border * scale),
                borderColor: WHITE,
                backgroundColor: WHITE,
                overflow: 'hidden',
                transform: drag.getTranslateTransform(),
              }}
            >
              <Image source={{ uri: front.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            </Animated.View>
          </View>
        ) : null}
      </View>
      <View style={s.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onRetake}
          style={({ pressed }) => [s.pill, s.ghost, (pressed || busy) && { opacity: 0.6 }]}
        >
          <Text style={[s.pillText, { color: WHITE }]}>{t('m.camera.dualRetake')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={onUse}
          style={({ pressed }) => [s.pill, (pressed || busy) && { opacity: 0.7 }]}
        >
          <Text style={s.pillText}>{busy ? t('m.camera.dualWorking') : t('m.camera.dualUse')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { backgroundColor: '#000', gap: space[3] },
  title: { color: WHITE, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  hint: { color: 'rgba(255,255,255,0.8)', fontSize: 14, textAlign: 'center' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', marginHorizontal: space[4] },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: space[3] },
  pill: { minHeight: 44, paddingHorizontal: 20, borderRadius: radius.full, backgroundColor: WHITE, alignItems: 'center', justifyContent: 'center' },
  ghost: { backgroundColor: 'rgba(255,255,255,0.15)' },
  pillText: { color: '#0B0C14', fontWeight: '700', fontSize: 15 },
});
