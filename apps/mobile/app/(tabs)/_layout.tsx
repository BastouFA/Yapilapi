import { LinearGradient } from 'expo-linear-gradient';
import { Tabs } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { elevation, gradient, radius } from '../../lib/theme';
import { Icon, useColors, type IconName } from '../../lib/ui';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ICONS: Record<string, [IconName, IconName]> = {
  index: ['home-outline', 'home'],
  discover: ['compass-outline', 'compass'],
  inbox: ['chatbubbles-outline', 'chatbubbles'],
  profile: ['person-circle-outline', 'person-circle'],
};

/** Floating, rounded tab bar with a raised gradient Create button, like the web app's mobile nav. */
function FloatingTabBar({ state, descriptors, navigation }: TabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => (show.remove(), hide.remove());
  }, []);
  if (keyboard) return null;

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: Math.max(insets.bottom, 12) }]}>
      <View style={[s.bar, { backgroundColor: c.surface }, elevation(c, 'lg')]}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const label = descriptors[route.key]?.options.title ?? route.name;
          const onPress = () => {
            const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          if (route.name === 'create')
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: focused }}
                onPress={onPress}
                style={({ pressed }) => [s.createHit, pressed && { transform: [{ scale: 0.96 }] }]}
              >
                <LinearGradient {...gradient(c)} style={[s.create, elevation(c, 'lg'), c.theme === 'dark' && { borderWidth: 0 }]}>
                  <Icon name="add" size={30} color={c.onYapi} />
                </LinearGradient>
              </Pressable>
            );
          const icons = ICONS[route.name] ?? (['ellipse-outline', 'ellipse'] as [IconName, IconName]);
          const color = focused ? c.yapi : c.inkMuted;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: focused }}
              onPress={onPress}
              style={s.item}
            >
              <Icon name={focused ? icons[1] : icons[0]} size={23} color={color} />
              <Text style={{ color, fontSize: 11, fontWeight: focused ? '700' : '600' }} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Primary navigation: Home | Discover | Create | Inbox | Profile.
export default function TabsLayout() {
  const c = useColors();
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
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="discover" options={{ title: 'Discover' }} />
      <Tabs.Screen name="create" options={{ title: 'Create' }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', height: 64, borderRadius: radius.full, paddingHorizontal: 8, width: '100%', maxWidth: 480 },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, height: 64 },
  createHit: { flex: 1, alignItems: 'center', height: 64 },
  create: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginTop: -20 },
});
