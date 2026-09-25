import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { palette } from '../lib/theme';

// Primary navigation: Home | Discover | Create | Inbox | Profile.
export default function Layout() {
  const c = palette(useColorScheme() === 'dark' ? 'dark' : 'light');
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.ground },
        headerTintColor: c.ink,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.line },
        tabBarActiveTintColor: c.yapi,
        tabBarInactiveTintColor: c.inkMuted,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="discover" options={{ title: 'Discover' }} />
      <Tabs.Screen name="create" options={{ title: 'Create' }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      <Tabs.Screen name="chat/[id]" options={{ href: null, title: 'Conversation' }} />
    </Tabs>
  );
}
