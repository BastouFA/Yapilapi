import { LinearGradient } from 'expo-linear-gradient';
import { router, Tabs } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Animated, Easing, I18nManager, Image, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { smallAvatarUrl } from '../../../../packages/shared/src/data-saver';
import { initialsOf } from '../../../../packages/shared/src/initials';
import type { MessageKey } from '../../../../packages/shared/src/i18n-core';
import type { NavGlyphName } from '../../../../packages/shared/src/nav-glyphs';
import { client, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { curve, useReducedMotion } from '../../lib/motion';
import { NavGlyph } from '../../lib/nav-glyphs';
import { RadioMiniBar } from '../../lib/radio';
import { useRealtime, useSession } from '../../lib/session';
import { elevation, gradient, type Palette } from '../../lib/theme';
import { DOCK, NavTour } from '../../lib/tour';
import { useActionSheet, useColors } from '../../lib/ui';
import { useFlag } from '../../lib/flags';
import { useAccountMenu, YouHeaderActions, YouHeaderTitle } from '../../lib/account-menu';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

/** Route name → the key its label, hint and glyph use (the web app's NavEntry ids). */
const TABS: Record<string, { id: 'home' | 'discover' | 'create' | 'inbox' | 'profile'; glyph?: NavGlyphName }> = {
  index: { id: 'home', glyph: 'pulse' },
  discover: { id: 'discover', glyph: 'wander' },
  create: { id: 'create', glyph: 'spark' },
  inbox: { id: 'inbox', glyph: 'yap' },
  profile: { id: 'profile' },
};

const PAD = DOCK.pad;
const ROW = DOCK.row;
/** How long Spark's menu waits after a tap, so its sheet doesn't cover the tap effect as it starts. */
const SPARK_MENU_DELAY_MS = 180;
/** The six specks of Spark's burst: 60° apart, every other one a little nearer. */
const BITS = [-60, 0, 60, 120, 180, 240].map((deg, i) => {
  const reach = i % 2 ? 0.82 : 1;
  return { x: Math.cos((deg * Math.PI) / 180) * reach, y: Math.sin((deg * Math.PI) / 180) * reach };
});
const burstEase = Easing.out(Easing.cubic);

/** Unread messages across your chats, for the dot-number on Chats. Refreshed when tabs change and on new messages. */
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
  const initials = initialsOf(name);
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
 * The floating dock: Pulse · Wander · [+] · Chats · You (docs/product/your-city-alive.md). Icons only,
 * except the current tab, whose label sits under its icon in a squircle highlight that springs from
 * tab to tab. The + in the middle is a raised, slightly tilted brand-gradient squircle: a tap opens
 * the ways to create, hiding a stash first, then a post, reel, story, live or Yap. Every tab keeps
 * its name, hint and unread count for screen readers. Wander holds the city map and what's on now.
 */
function FloatingTabBar({ state, descriptors, navigation }: TabBarProps) {
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const unread = useUnreadChats(!!me, state.index);
  const yaps = useFlag('YAPS') !== false;
  const stash = useFlag('STASH') !== false;
  const live = useFlag('LIVE') === true;
  const more = useActionSheet();
  // The ways to create, behind Spark (a stash first).
  const openMore = () =>
    more.show({
      title: t('create.title'),
      actions: [
        ...(stash ? [{ label: t('stash.hide'), icon: 'gift-outline' as const, onPress: () => router.push('/stash/new') }] : []),
        { label: t('m.create.mode.post'), icon: 'image-outline', onPress: () => router.push('/camera') },
        { label: t('m.create.mode.reel'), icon: 'videocam-outline', onPress: () => router.push({ pathname: '/camera', params: { mode: 'reel' } }) },
        { label: t('m.create.mode.story'), icon: 'sparkles-outline', onPress: () => router.push({ pathname: '/camera', params: { mode: 'story' } }) },
        ...(live ? [{ label: t('m.live.title'), icon: 'radio-outline' as const, onPress: () => router.push('/live') }] : []),
        ...(yaps ? [{ label: t('m.create.mode.yap'), icon: 'mic-outline' as const, onPress: () => navigation.navigate('create', { mode: 'yap' }) }] : []),
      ],
    });
  const [keyboard, setKeyboard] = useState(false);
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  const spark = useRef(new Animated.Value(0)).current;
  const squish = useRef(new Animated.Value(1)).current;
  const tap = useRef(new Animated.Value(0)).current;
  const popping = useRef(false);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placedOnce = useRef(false);
  useEffect(
    () => () => {
      if (later.current) clearTimeout(later.current);
    },
    [],
  );

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

  // Pressed, Spark straightens and squishes down at once; let go without a tap, it springs back.
  const press = (to: number) => {
    if (reduce) return spark.setValue(to);
    Animated.spring(spark, { toValue: to, useNativeDriver: true, damping: 12, stiffness: 260 }).start();
    if (to) Animated.timing(squish, { toValue: 0.9, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    else if (!popping.current) Animated.spring(squish, { toValue: 1, useNativeDriver: true, damping: 12, stiffness: 260 }).start();
  };
  // A tap plays Spark's tap effect, from the start and to the end: the button pops back with a little
  // overshoot and brightens for a moment, its spark makes a quarter turn, its light circles it once,
  // and a soft ring and six specks burst out from behind it. Its menu opens a moment later.
  // With reduce motion: only a brief dimming, and the menu at once.
  const tapSpark = () => {
    tap.stopAnimation();
    tap.setValue(0);
    Animated.timing(tap, { toValue: 1, duration: reduce ? 280 : 620, easing: Easing.linear, useNativeDriver: true }).start(({ finished }) => {
      if (finished) tap.setValue(0);
    });
    if (later.current) clearTimeout(later.current);
    later.current = null;
    if (reduce) return openMore();
    later.current = setTimeout(() => ((later.current = null), openMore()), SPARK_MENU_DELAY_MS);
    // Stopped first: an earlier pop's end would otherwise clear the flag for this one.
    squish.stopAnimation();
    popping.current = true;
    Animated.sequence([
      Animated.timing(squish, { toValue: 1.12, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(squish, { toValue: 1, useNativeDriver: true, damping: 12, stiffness: 260, mass: 0.8 }),
    ]).start(() => (popping.current = false));
  };

  if (keyboard) return null;

  return (
    <>
      {/* Yap Radio, while it has a Yap: just above the dock and its raised middle button. */}
      <RadioMiniBar bottom={Math.max(insets.bottom, 12) + ROW + PAD * 2 + 2 + 38} />
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
                { width: slot - 6, start: PAD + 3, backgroundColor: c.yapiSoft, borderColor: c.theme === 'dark' ? '#FF5C7A33' : '#B42A4E26' },
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
                  // Spark (its screen, the composer, is titled Create).
                  accessibilityLabel={t('nav.create')}
                  accessibilityHint={hint}
                  // The ways to create: hide a stash, a post, reel, story, live or Yap.
                  onPress={tapSpark}
                  onPressIn={() => press(1)}
                  onPressOut={() => press(0)}
                  style={s.sparkHit}
                >
                  {reduce ? null : <SparkBurst tap={tap} c={c} />}
                  <Animated.View
                    style={[
                      s.sparkLift,
                      // A coral glow under it in light mode; dark mode has no shadows (and no border here).
                      c.theme === 'light' && { ...elevation(c, 'lg'), shadowColor: c.yapi, shadowOpacity: 0.35 },
                      {
                        opacity: reduce ? tap.interpolate({ inputRange: [0, 0.4, 1], outputRange: [1, 0.72, 1] }) : 1,
                        transform: [{ rotate: spark.interpolate({ inputRange: [0, 1], outputRange: ['-8deg', '0deg'] }) }, { scale: squish }],
                      },
                    ]}
                  >
                    <LinearGradient {...gradient(c)} style={s.spark}>
                      {reduce ? null : (
                        <Animated.View
                          pointerEvents="none"
                          style={[
                            StyleSheet.absoluteFill,
                            { backgroundColor: '#FFFFFF', opacity: tap.interpolate({ inputRange: [0, 0.25, 0.6, 1], outputRange: [0, 0.2, 0, 0] }) },
                          ]}
                        />
                      )}
                      <NavGlyph name="spark" size={28} color={c.onYapi} tone="solid" tap={reduce ? undefined : tap} />
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
                // Screen readers reach the long press on You (the account menu) as a named action.
                accessibilityActions={tab?.id === 'profile' ? [{ name: 'longpress', label: t('acct.menu') }] : undefined}
                onAccessibilityAction={(e) => {
                  if (e.nativeEvent.actionName === 'longpress') navigation.emit({ type: 'tabLongPress', target: route.key });
                }}
                style={s.item}
              >
                <View style={focused ? s.lifted : undefined}>
                  {tab?.glyph ? <NavGlyph name={tab.glyph} color={color} tone={focused ? 'duo' : 'line'} /> : <YouAvatar c={c} focused={focused} />}
                  {badge ? (
                    <View style={[s.badge, { borderColor: c.surface }]}>
                      <LinearGradient {...gradient(c)} style={StyleSheet.absoluteFill} />
                      <Text style={{ color: c.onYapi, fontSize: 10, fontWeight: '800' }}>
                        {badge > 99 ? '99+' : new Intl.NumberFormat(locale).format(badge)}
                      </Text>
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
      {/* First launch: four small marks pointing at the tabs (shown once). */}
      <NavTour tabCount={count} active={current === 'index'} />
      {more.sheet}
    </>
  );
}

/** Behind Spark, on a tap: a soft ring of the brand colour grows and fades, and six specks fly out and fade. */
function SparkBurst({ tap, c }: { tap: Animated.Value; c: Palette }) {
  return (
    <View pointerEvents="none" style={s.burst}>
      <Animated.View
        style={[
          s.ring,
          {
            borderColor: c.yapi,
            shadowColor: c.yapi,
            // Hidden at rest (0), then from full to nothing as it grows.
            opacity: tap.interpolate(curve([0, 0.001, 1], [0, 0.85, 0], burstEase)),
            transform: [{ scale: tap.interpolate(curve([0, 1], [0.95, 1.8], burstEase)) }],
          },
        ]}
      />
      {BITS.map((b, i) => (
        <Animated.View
          key={i}
          style={[
            s.bit,
            {
              backgroundColor: i % 2 ? c.saffron : c.yapi,
              opacity: tap.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
              transform: [
                { translateX: tap.interpolate(curve([0, 0.2, 1], [b.x * 20, b.x * 34, b.x * 44], burstEase)) },
                { translateY: tap.interpolate(curve([0, 0.2, 1], [b.y * 20, b.y * 34, b.y * 44], burstEase)) },
                { scale: tap.interpolate({ inputRange: [0, 0.2, 1], outputRange: [1, 1.3, 0] }) },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

// Primary navigation: Pulse | Wander | Spark | Chats | You (route files keep their names: index is Pulse,
// discover is Wander, then create, inbox, profile).
export default function TabsLayout() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const accountMenu = useAccountMenu();
  return (
    <Tabs
      // Another account in use: every tab starts over with that account's feed, chats and profile.
      key={me?.id ?? 'signed-out'}
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
      {/* Spark opens the ways to create; this screen is the composer they lead to (a post, a Yap). */}
      <Tabs.Screen name="create" options={{ title: t('create.title') }} />
      <Tabs.Screen name="inbox" options={{ title: t('nav.inbox') }} />
      <Tabs.Screen
        name="profile"
        options={{ title: t('nav.profile'), headerTitle: () => <YouHeaderTitle />, headerRight: () => <YouHeaderActions /> }}
        // Long-press You to switch accounts, as in other apps.
        listeners={{ tabLongPress: () => accountMenu.open() }}
      />
    </Tabs>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', start: DOCK.side, end: DOCK.side, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW + PAD * 2 + 2,
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: PAD,
    width: '100%',
    maxWidth: DOCK.maxWidth,
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
  // Spark's burst: centred on the button, drawn behind it, never in the way of a touch.
  burst: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: 54,
    height: 54,
    borderRadius: 19,
    borderWidth: 2,
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  bit: { position: 'absolute', width: 6, height: 6, borderRadius: 3 },
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
