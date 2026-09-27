import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { useT } from './i18n';
import { useReducedMotion } from './motion';
import { useSession } from './session';
import { elevation, radius, space } from './theme';
import { useColors } from './ui';

/** The floating dock's measurements, shared with app/(tabs)/_layout.tsx so the tour points at the right place. */
export const DOCK = { pad: 5, row: 54, maxWidth: 460, side: 12 } as const;
const DOCK_HEIGHT = DOCK.row + DOCK.pad * 2 + 2;
/** Spark rises this far above the dock. */
const SPARK_RISE = 30;

const DONE_KEY = 'ypl_nav_tour_v1';

/** The four marks: which tab (or tabs) each points at, and what it says. */
const MARKS: { slots: number[]; title: MessageKey; body: MessageKey }[] = [
  { slots: [0], title: 'nav.home', body: 'm.tour.pulse' },
  { slots: [1], title: 'nav.discover', body: 'm.tour.wander' },
  { slots: [2], title: 'nav.create', body: 'm.tour.spark' },
  { slots: [3, 4], title: 'm.tour.yapYou.title', body: 'm.tour.yapYou.body' },
];

/**
 * A short tour of the dock on first launch: four small marks, one at a time, pointing at Pulse,
 * Wander, Spark, then Yap and You. It never blocks the screen (nothing dims, every tab still
 * works), Skip ends it at once, and it is shown once per phone. Screen readers hear each mark
 * as it appears and can reach its buttons, but focus is never held inside it. With Reduce Motion
 * the marks appear without fading.
 */
export function NavTour({ tabCount, active }: { tabCount: number; active: boolean }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const { width: screen } = useWindowDimensions();
  const reduce = useReducedMotion();
  const [step, setStep] = useState<number | null>(null);
  const fade = useRef(new Animated.Value(0)).current;

  // Once signed in and past onboarding, on Pulse: start after a moment, unless already seen.
  useEffect(() => {
    if (!me?.onboarded || !active || step !== null) return;
    let live = true;
    const timer = setTimeout(() => {
      void SecureStore.getItemAsync(DONE_KEY)
        .catch(() => 'done')
        .then((v) => live && !v && setStep(0));
    }, 900);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [me?.onboarded, active, step]);

  useEffect(() => {
    if (step === null) return;
    const mark = MARKS[step]!;
    AccessibilityInfo.announceForAccessibility(`${t('m.tour.count', { step: step + 1, total: MARKS.length })}. ${t(mark.title)}. ${t(mark.body)}`);
    if (reduce) return fade.setValue(1);
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [step, reduce, fade, t]);

  if (step === null || step >= MARKS.length) return null;

  const end = () => {
    setStep(MARKS.length);
    void SecureStore.setItemAsync(DONE_KEY, 'done').catch(() => {});
  };
  const mark = MARKS[step]!;
  const last = step === MARKS.length - 1;

  // Where the dock is: centred, at most DOCK.maxWidth wide, DOCK.side from each edge.
  const barWidth = Math.min(screen - DOCK.side * 2, DOCK.maxWidth);
  const barStart = (screen - barWidth) / 2;
  const slot = (barWidth - DOCK.pad * 2 - 2) / tabCount;
  const centerOf = (i: number) => barStart + 1 + DOCK.pad + slot * (i + 0.5);
  // Measured from the start edge, so right-to-left layouts (where the dock is mirrored) line up too.
  const target = mark.slots.reduce((sum, i) => sum + centerOf(i), 0) / mark.slots.length;
  const bubbleWidth = Math.min(300, screen - space[4] * 2);
  const bubbleStart = Math.min(Math.max(space[4], target - bubbleWidth / 2), screen - space[4] - bubbleWidth);
  const lift = mark.slots.includes(2) ? SPARK_RISE : 0;
  const bottom = Math.max(insets.bottom, 12) + DOCK_HEIGHT + 14 + lift;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        start: bubbleStart,
        bottom,
        width: bubbleWidth,
        opacity: fade,
        transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
      <View style={[{ backgroundColor: c.ink, borderRadius: radius.lg, padding: space[4], gap: space[2] }, elevation(c, 'lg')]}>
        <View accessible style={{ gap: space[1] }}>
          <Text style={{ color: c.ground, opacity: 0.7, fontSize: 12, fontWeight: '700' }}>{t('m.tour.count', { step: step + 1, total: MARKS.length })}</Text>
          <Text accessibilityRole="header" style={{ color: c.ground, fontSize: 17, fontWeight: '800' }}>
            {t(mark.title)}
          </Text>
          <Text style={{ color: c.ground, fontSize: 14, lineHeight: 20 }}>{t(mark.body)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space[2], marginTop: space[1] }}>
          {last ? null : (
            <Pressable accessibilityRole="button" onPress={end} style={{ minHeight: 44, minWidth: 44, paddingHorizontal: space[3], justifyContent: 'center' }}>
              <Text style={{ color: c.ground, opacity: 0.8, fontWeight: '700' }}>{t('m.tour.skip')}</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => (last ? end() : setStep(step + 1))}
            style={({ pressed }) => ({
              minHeight: 44,
              paddingHorizontal: space[4],
              borderRadius: radius.full,
              backgroundColor: c.ground,
              justifyContent: 'center',
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: c.ink, fontWeight: '800' }}>{last ? t('m.tour.done') : t('m.tour.next')}</Text>
          </Pressable>
        </View>
      </View>
      {/* The arrow, pointing down at the tab. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          bottom: -7,
          start: Math.min(Math.max(space[4], target - bubbleStart - 7), bubbleWidth - space[4] - 14),
          width: 14,
          height: 14,
          backgroundColor: c.ink,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </Animated.View>
  );
}
