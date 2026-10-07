import { router, Stack } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BirthDateGate } from '../../mobile/lib/birth-date-gate';
import { BoardsProvider } from '../../mobile/lib/boards';
import { CallsProvider } from '../../mobile/lib/calls';
import { DataSaverProvider } from '../../mobile/lib/data-saver';
import { LocaleProvider, useT } from '../../mobile/lib/i18n';
import { TranslationProvider } from '../../mobile/lib/translation';
import { SessionProvider, useSession } from '../../mobile/lib/session';
import { useColors } from '../../mobile/lib/ui';
import { useUsageHeartbeat } from '../../mobile/lib/usage';
import { YapPlayer } from '../../mobile/lib/yaps';
import { useNotificationLinks } from '../../mobile/lib/links';
import { OfflineBanner } from '../../mobile/lib/offline';
import { loadAppearance } from '../../mobile/lib/appearance';

// A chosen Light or Dark appearance applies before the first screen draws.
void loadAppearance();

/**
 * Minutes count for family supervision in Yap too, and push taps open their chat (the API only
 * sends Yap pushes about chats and calls; incoming calls are CallsProvider's).
 */
function Background() {
  const { me } = useSession();
  useUsageHeartbeat(!!me);
  useNotificationLinks();
  useWelcomeAfterSignOut();
  return null;
}

/** Signing out (from Settings, or a session that ended) goes back to the welcome screen. */
function useWelcomeAfterSignOut() {
  const { me } = useSession();
  const was = useRef(me);
  useEffect(() => {
    const before = was.current;
    was.current = me;
    if (!before || me !== null) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace('/welcome');
  }, [me]);
}

/**
 * Yap's tabs (Chats, Calls, Stories, Settings) live in (tabs); a chat, a new chat or group, group
 * info, editing your profile and signing in push on top. The chat and sign-in screens are the
 * YAPILAPI phone app's own (see README.md). Anything else opens in YAPILAPI (+not-found.tsx).
 */
function Screens() {
  const c = useColors();
  const { t } = useT();
  // A chat opened straight from a link or a notification has nothing behind it: give it a way to the chats.
  const chatsWhenAlone = ({ canGoBack }: { canGoBack?: boolean }) =>
    canGoBack ? null : (
      <Pressable accessibilityRole="button" accessibilityLabel={t('yapApp.tab.chats')} hitSlop={12} onPress={() => router.replace('/')}>
        <Text style={{ color: c.yapi, fontSize: 17, fontWeight: '600' }}>{t('yapApp.tab.chats')}</Text>
      </Pressable>
    );
  const closeButton = () => (
    <Pressable accessibilityRole="button" hitSlop={12} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
      <Text style={{ color: c.yapi, fontSize: 17, fontWeight: '600' }}>{t('common.cancel')}</Text>
    </Pressable>
  );
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
          headerLeft: chatsWhenAlone,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('yapApp.tab.chats') }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('m.title.conversation') }} />
        <Stack.Screen name="new-chat" options={{ title: t('yapApp.chats.new'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="new-group" options={{ title: t('m.inbox.newGroup'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="new-call" options={{ title: t('yapApp.calls.new'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="your-data" options={{ title: t('settings.data.title') }} />
        <Stack.Screen name="inbox" options={{ headerShown: false, animation: 'none' }} />
        <Stack.Screen name="group-info" options={{ title: t('chat.group.info') }} />
        <Stack.Screen name="profile-edit" options={{ title: t('profile.edit'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="welcome" options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, animation: 'none' }} />
        <Stack.Screen name="signup" options={{ title: '' }} />
        <Stack.Screen name="login" options={{ title: '' }} />
        <Stack.Screen name="forgot-password" options={{ title: '' }} />
        <Stack.Screen name="+not-found" options={{ title: '', animation: 'none' }} />
      </Stack>
    </>
  );
}

/** The same providers as the YAPILAPI phone app, less the ones only its other screens use. */
export default function Root() {
  return (
    <SessionProvider>
      <DataSaverProvider>
        <LocaleProvider>
          <TranslationProvider>
            <CallsProvider>
              <BoardsProvider>
                <Background />
                <Screens />
                <BirthDateGate />
                <YapPlayer />
                <OfflineBanner />
              </BoardsProvider>
            </CallsProvider>
          </TranslationProvider>
        </LocaleProvider>
      </DataSaverProvider>
    </SessionProvider>
  );
}
