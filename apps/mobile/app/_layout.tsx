import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { CallsProvider } from '../lib/calls';
import { SessionProvider, useSession } from '../lib/session';
import { useColors } from '../lib/ui';
import { useUsageHeartbeat } from '../lib/usage';

function Heartbeat() {
  const { me } = useSession();
  useUsageHeartbeat(!!me);
  return null;
}

/** Tabs live in (tabs); detail screens (chat, post, community, settings, Real) push on top. */
export default function Root() {
  const c = useColors();
  return (
    <SessionProvider>
      <CallsProvider>
        <Heartbeat />
        <StatusBar style={c.theme === 'dark' ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: c.ground },
            headerTintColor: c.ink,
            headerTitleStyle: { fontWeight: '700' },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: c.ground },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Home' }} />
          <Stack.Screen name="chat/[id]" options={{ title: 'Conversation' }} />
          <Stack.Screen name="p/[id]" options={{ title: 'Post' }} />
          <Stack.Screen name="c/[slug]" options={{ title: 'Community' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          <Stack.Screen name="real" options={{ title: 'Real' }} />
        </Stack>
      </CallsProvider>
    </SessionProvider>
  );
}
