import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { CallsProvider } from '../lib/calls';
import { LocaleProvider, useT } from '../lib/i18n';
import { SessionProvider, useSession } from '../lib/session';
import { useColors } from '../lib/ui';
import { useUsageHeartbeat } from '../lib/usage';

function Heartbeat() {
  const { me } = useSession();
  useUsageHeartbeat(!!me);
  return null;
}

/** Tabs live in (tabs); detail screens (chat, post, community, settings, Real, Reels) push on top. */
function Screens() {
  const c = useColors();
  const { t } = useT();
  return (
    <>
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
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('nav.home') }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('m.title.conversation') }} />
        <Stack.Screen name="p/[id]" options={{ title: t('m.title.post') }} />
        <Stack.Screen name="c/[slug]" options={{ title: t('m.title.community') }} />
        <Stack.Screen name="settings" options={{ title: t('m.title.settings') }} />
        <Stack.Screen name="real" options={{ title: t('m.title.real') }} />
        <Stack.Screen name="assistant" options={{ title: t('m.title.assistant') }} />
        <Stack.Screen name="events" options={{ title: t('events.title') }} />
        <Stack.Screen name="reels" options={{ title: t('m.title.reels'), headerShown: false, contentStyle: { backgroundColor: '#000' } }} />
        <Stack.Screen name="new-group" options={{ title: t('m.inbox.newGroup'), presentation: 'modal' }} />
      </Stack>
    </>
  );
}

/** The language (and layout direction) depends on who is signed in, so it sits inside the session. */
export default function Root() {
  return (
    <SessionProvider>
      <LocaleProvider>
        <CallsProvider>
          <Heartbeat />
          <Screens />
        </CallsProvider>
      </LocaleProvider>
    </SessionProvider>
  );
}
