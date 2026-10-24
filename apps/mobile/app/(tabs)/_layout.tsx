import { LinearGradient } from 'expo-linear-gradient';
import { router, Tabs } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Animated, I18nManager, Image, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { smallAvatarUrl } from '../../../../packages/shared/src/data-saver';
import { initialsOf } from '../../../../packages/shared/src/initials';
import type { MessageKey } from '../../../../packages/shared/src/i18n-core';
import type { NavGlyphName } from '../../../../packages/shared/src/nav-glyphs';
import { client, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useReducedMotion } from '../../lib/motion';
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
const TABS: Record<string, { id: 'near' | 'home' | 'discover' | 'create' | 'inbox' | 'profile'; glyph?: NavGlyphName }> = {
  index: { id: 'near', glyph: 'near' },
  home: { id: 'home', glyph: 'pulse' },
  create: { id: 'create', glyph: 'add' },
  inbox: { id: 'inbox', glyph: 'yap' },
  profile: { id: 'profile' },
};
/** Routes that stay reachable (from Near's Explore, and links) but have no place in the dock. */
const OFF_DOCK = new Set(['discover']);

const PAD = DOCK.pad;
const ROW = DOCK.row;

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
 * The floating dock: Near · Pulse · [+] · Chats · You (docs/product/your-city-alive.md). Icons only,
 * except the current tab, whose label sits under its icon in a squircle highlight that springs from
 * tab to tab. The + in the middle is a raised, slightly tilted brand-gradient squircle: a tap opens
 * the ways to create, hiding a stash first, then a post, reel, story, live or Yap. Every tab keeps
 * its name, hint and unread count for screen readers. Explore (Wander) is reached from Near.
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
  // The ways to create, behind the + (a stash first).
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
  const placedOnce = useRef(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => (show.remove(), hide.remove());
  }, []);

  const docked = state.routes.filter((r) => !OFF_DOCK.has(r.name));
  const count = docked.length;
  const slot = width / count;
  const current = state.routes[state.index]?.name;
  // Explore (off the dock) belongs to Near: its highlight stays there.
  const at = Math.max(
    0,
    docked.findIndex((r) => r.name === (current && OFF_DOCK.has(current) ? 'index' : current)),
  );
  // Rows run right to left in Arabic: the highlight then moves the other way from its start edge.
  const target = (I18nManager.isRTL ? -1 : 1) * at * slot;
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
          {docked.map((route) => {
            const focused = state.routes[state.index]?.key === route.key || (route.name === 'index' && !!current && OFF_DOCK.has(current));
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
                  // The ways to create: hide a stash, a post, reel, story, live or Yap.
                  onPress={openMore}
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
                      <NavGlyph name="add" size={27} color={c.onYapi} tone="solid" />
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

// Primary navigation: Near | Pulse | + | Chats | You (route files: index is Near, home is Pulse, then create,
// inbox, profile; discover, Explore, is reached from Near and has no place in the dock).
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
      <Tabs.Screen name="index" options={{ title: t('nav.near') }} />
      <Tabs.Screen name="home" options={{ title: t('nav.home') }} />
      {/* The + opens the ways to create; this screen is the composer they lead to (a post, a Yap). */}
      <Tabs.Screen name="create" options={{ title: t('create.title') }} />
      <Tabs.Screen name="inbox" options={{ title: t('nav.inbox') }} />
      <Tabs.Screen
        name="profile"
        options={{ title: t('nav.profile'), headerTitle: () => <YouHeaderTitle />, headerRight: () => <YouHeaderActions /> }}
        // Long-press You to switch accounts, as in other apps.
        listeners={{ tabLongPress: () => accountMenu.open() }}
      />
      {/* Explore (Wander): from Near's header and links, not the dock. */}
      <Tabs.Screen name="discover" options={{ title: t('near.explore'), href: null }} />
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
