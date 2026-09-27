import { LinearGradient } from 'expo-linear-gradient';
import { router, Tabs } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { AccessibilityInfo, Animated, I18nManager, Image, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { smallAvatarUrl } from '../../../../packages/shared/src/data-saver';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import type { NavGlyphName } from '../../../../packages/shared/src/nav-glyphs';
import { client, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { NavGlyph } from '../../lib/nav-glyphs';
import { useRealtime, useSession } from '../../lib/session';
import { elevation, gradient, type Palette } from '../../lib/theme';
import { useColors } from '../../lib/ui';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

/** Route name → the key its label, hint and glyph use (the web app's NavEntry ids). */
const TABS: Record<string, { id: 'home' | 'discover' | 'create' | 'inbox' | 'profile'; glyph?: NavGlyphName }> = {
  index: { id: 'home', glyph: 'pulse' },
  discover: { id: 'discover', glyph: 'wander' },
  create: { id: 'create', glyph: 'spark' },
  inbox: { id: 'inbox', glyph: 'yap' },
  profile: { id: 'profile' },
};

const PAD = 5;
const ROW = 54;

function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/** Unread messages across your chats, for the dot-number on Yap. Refreshed when tabs change and on new messages. */
function useUnreadChats(signedIn: boolean, tab: number) {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    if (!signedIn) return setCount(0);
    void client()
      .then((api) => api.conversations.list())
      .then(
        (r) => setCount(r.items.reduce((sum, c) => sum + c.unreadCount, 0)),
        () => {},
      );
  }, [signedIn]);
  useEffect(load, [load, tab]);
  useRealtime((e) => {
    if (e.type === 'message.created' || e.type === 'conversation.created' || e.type === 'app.foreground') load();
  });
  return count;
}

/** You: the person's own avatar in a soft squircle (initials without a photo); a thin gradient ring when current. */
function YouAvatar({ c, focused }: { c: Palette; focused: boolean }) {
  const { me } = useSession();
  const [failed, setFailed] = useState(false);
  const url = me?.avatarUrl ? mediaUrl(me.avatarUrl) : null;
  const small = url ? smallAvatarUrl(url) : null;
  const name = me?.displayName ?? '';
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  const face = (
    <View style={[s.you, { backgroundColor: c.surfaceSunken }, !focused && { borderWidth: 1.5, borderColor: c.lineStrong }]}>
      {url ? (
        <Image
          source={{ uri: !failed && small ? small : url }}
          onError={small && small !== url ? () => setFailed(true) : undefined}
          accessibilityIgnoresInvertColors
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <Text style={{ color: c.ink, fontSize: 10, fontWeight: '800' }}>{initials}</Text>
      )}
    </View>
  );
  if (!focused) return face;
  return (
    <LinearGradient colors={[c.yapi, c.saffron]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.youRing}>
      <View style={[s.youGap, { backgroundColor: c.yapiSoft }]}>{face}</View>
    </LinearGradient>
  );
}

/**
 * The floating dock: Pulse · Wander · [Spark] · Yap · You. Icons only, except the current tab,
 * whose label sits under its icon in a squircle highlight that springs from tab to tab. Spark is a
 * raised brand-gradient squircle, tilted like a spark, that straightens while pressed and opens
 * the camera. Every tab keeps its name, hint and unread count for screen readers.
 */
function FloatingTabBar({ state, descriptors, navigation }: TabBarProps) {
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const unread = useUnreadChats(!!me, state.index);
  const [keyboard, setKeyboard] = useState(false);
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  const spark = useRef(new Animated.Value(0)).current;
  const placedOnce = useRef(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => (show.remove(), hide.remove());
  }, []);

  const count = state.routes.length;
  const slot = width / count;
  const current = state.routes[state.index]?.name;
  // Rows run right to left in Arabic: the highlight then moves the other way from its start edge.
  const target = (I18nManager.isRTL ? -1 : 1) * state.index * slot;
  useEffect(() => {
    if (!width) return;
    if (reduce || !placedOnce.current) slide.setValue(target);
    else Animated.spring(slide, { toValue: target, useNativeDriver: true, damping: 16, stiffness: 190, mass: 0.9 }).start();
    placedOnce.current = true;
  }, [target, width, reduce, slide]);

  const press = (to: number) => {
    if (reduce) spark.setValue(to);
    else Animated.spring(spark, { toValue: to, useNativeDriver: true, damping: 12, stiffness: 260 }).start();
  };

  if (keyboard) return null;

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: Math.max(insets.bottom, 12) }]}>
      <View
        accessibilityRole="tablist"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width - PAD * 2 - 2)}
        style={[s.bar, { backgroundColor: c.surface, borderColor: c.line }, elevation(c, 'lg')]}
      >
        {width && current !== 'create' ? (
          <Animated.View
            pointerEvents="none"
            style={[
              s.glow,
              { width: slot - 6, start: PAD + 3, backgroundColor: c.yapiSoft, borderColor: c.theme === 'dark' ? '#FF5C7A33' : '#D21D4A26' },
              { transform: [{ translateX: slide }] },
            ]}
          />
        ) : null}
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const tab = TABS[route.name];
          const label = descriptors[route.key]?.options.title ?? route.name;
          const hint = tab ? t(`nav.hint.${tab.id}` as MessageKey) : undefined;

          if (route.name === 'create')
            return (
              <Pressable
                key={route.key}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={hint}
                // Straight to the camera; what is taken there opens in Create.
                onPress={() => router.push('/camera')}
                onPressIn={() => press(1)}
                onPressOut={() => press(0)}
                style={s.sparkHit}
              >
                <Animated.View
                  style={[
                    s.sparkLift,
                    // A coral glow under it in light mode; dark mode has no shadows (and no border here).
                    c.theme === 'light' && { ...elevation(c, 'lg'), shadowColor: c.yapi, shadowOpacity: 0.35 },
                    {
                      transform: [
                        { rotate: spark.interpolate({ inputRange: [0, 1], outputRange: ['-8deg', '0deg'] }) },
                        { scale: spark.interpolate({ inputRange: [0, 1], outputRange: [1, 0.93] }) },
                      ],
                    },
                  ]}
                >
                  <LinearGradient {...gradient(c)} style={s.spark}>
                    <NavGlyph name="spark" size={27} color={c.onYapi} tone="solid" />
                  </LinearGradient>
                </Animated.View>
              </Pressable>
            );

          const onPress = () => {
            const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          const badge = tab?.id === 'inbox' && unread > 0 ? unread : 0;
          const color = focused ? c.yapi : c.inkMuted;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={
                badge ? `${label}${t('m.collab.joinSep')}${t('m.inbox.unread', { count: new Intl.NumberFormat(locale).format(badge) })}` : label
              }
              accessibilityHint={hint}
              accessibilityState={{ selected: focused }}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={s.item}
            >
              <View style={focused ? s.lifted : undefined}>
                {tab?.glyph ? <NavGlyph name={tab.glyph} color={color} tone={focused ? 'duo' : 'line'} /> : <YouAvatar c={c} focused={focused} />}
                {badge ? (
                  <View style={[s.badge, { borderColor: c.surface }]}>
                    <LinearGradient {...gradient(c)} style={StyleSheet.absoluteFill} />
                    <Text style={{ color: c.onYapi, fontSize: 10, fontWeight: '800' }}>{badge > 99 ? '99+' : new Intl.NumberFormat(locale).format(badge)}</Text>
                  </View>
                ) : null}
              </View>
              {focused ? (
                <Text style={[s.label, { color: c.ink }]} numberOfLines={1}>
                  {label}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Primary navigation: Pulse | Wander | Spark | Yap | You (route files keep their names: index, discover, create, inbox, profile).
export default function TabsLayout() {
  const c = useColors();
  const { t } = useT();
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: c.ground },
        headerTintColor: c.ink,
        headerTitleStyle: { fontWeight: '800', fontSize: 18 },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: c.ground },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('nav.home') }} />
      <Tabs.Screen name="discover" options={{ title: t('nav.discover') }} />
      <Tabs.Screen name="create" options={{ title: t('nav.create') }} />
      <Tabs.Screen name="inbox" options={{ title: t('nav.inbox') }} />
      <Tabs.Screen name="profile" options={{ title: t('nav.profile') }} />
    </Tabs>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', start: 12, end: 12, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW + PAD * 2 + 2,
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: PAD,
    width: '100%',
    maxWidth: 460,
  },
  glow: { position: 'absolute', top: PAD, height: ROW, borderRadius: 18, borderWidth: 1 },
  // At least 44x44 everywhere: each tab is a full slot, 54 high.
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', height: ROW },
  lifted: { transform: [{ translateY: -9 }] },
  label: { position: 'absolute', bottom: 5, start: 2, end: 2, textAlign: 'center', fontSize: 11, lineHeight: 14, fontWeight: '700' },
  // The squircle rises above the bar; the touch area rises with it, so a tap anywhere on it counts.
  sparkHit: { flex: 1, alignItems: 'center', justifyContent: 'center', height: ROW + 30, marginTop: -30 },
  sparkLift: { borderRadius: 19 },
  spark: { width: 54, height: 54, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  badge: {
    position: 'absolute',
    top: -7,
    start: 16,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 6,
    borderWidth: 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  you: { width: 24, height: 24, borderRadius: 8.5, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  youRing: { padding: 1.75, borderRadius: 11 },
  youGap: { padding: 1.75, borderRadius: 9.5 },
});
