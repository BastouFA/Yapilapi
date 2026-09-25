import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { AppProviders } from '../providers';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { usePrefs } from '../prefs';
import { configureForegroundNotifications } from '../push';
import { routeForPushData } from '../push/routing';
import { ErrorView, LoadingView, Screen } from '../ui';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
configureForegroundNotifications();

function Gate() {
  const { status, user, retryBoot } = useAuth();
  const { ready } = usePrefs();
  const th = useTheme();
  const t = useT();
  const router = useRouter();

  useEffect(() => {
    if (ready && status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready, status]);

  // A tapped push notification opens the screen it is about (only when signed in; otherwise the sign-in gate wins).
  useEffect(() => {
    if (status !== 'signedIn') return;
    let sub: { remove: () => void } | undefined;
    try {
      sub = Notifications.addNotificationResponseReceivedListener((r) => {
        router.push(
          routeForPushData(
            r.notification.request.content.data as Record<string, unknown> | undefined,
          ) as never,
        );
      });
    } catch {
      /* not available (web preview) */
    }
    return () => sub?.remove();
  }, [status, router]);

  if (status === 'loading' || !ready)
    return (
      <Screen>
        <LoadingView label={t('boot.checking')} />
      </Screen>
    );
  if (status === 'error')
    return (
      <Screen>
        <ErrorView message={t('boot.failed')} onRetry={retryBoot} />
      </Screen>
    );

  const signedIn = status === 'signedIn';
  const onboarded = user?.profile.onboardingCompleted ?? false;
  const header = {
    headerStyle: { backgroundColor: th.colors.surface },
    headerTintColor: th.colors.text,
    headerTitleStyle: { color: th.colors.text },
    contentStyle: { backgroundColor: th.colors.bg },
    headerBackButtonDisplayMode: 'minimal' as const,
  };
  return (
    <Stack screenOptions={header}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !onboarded}>
        <Stack.Screen
          name="onboarding"
          options={{
            title: t('onboarding.title'),
            headerBackVisible: false,
            gestureEnabled: false,
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && onboarded}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="post/[id]" options={{ title: t('post.comments') }} />
        <Stack.Screen name="user/[username]" options={{ title: t('profile.title') }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('chat.title') }} />
        <Stack.Screen name="community/[id]" options={{ title: t('communities.title') }} />
        <Stack.Screen
          name="compose"
          options={{ title: t('compose.title'), presentation: 'modal' }}
        />
        <Stack.Screen
          name="new-message"
          options={{ title: t('inbox.newTitle'), presentation: 'modal' }}
        />
        <Stack.Screen name="search" options={{ title: t('search.title') }} />
        <Stack.Screen name="edit-profile" options={{ title: t('profile.editTitle') }} />
        <Stack.Screen name="settings/index" options={{ title: t('settings.title') }} />
        <Stack.Screen name="settings/privacy" options={{ title: t('privacy.title') }} />
        <Stack.Screen name="settings/sessions" options={{ title: t('sessions.title') }} />
        <Stack.Screen name="settings/language" options={{ title: t('language.title') }} />
        <Stack.Screen name="settings/notifications" options={{ title: t('push.title') }} />
        <Stack.Screen name="settings/account" options={{ title: t('account.title') }} />
      </Stack.Protected>
    </Stack>
  );
}

function ThemedStatusBar() {
  const th = useTheme();
  return <StatusBar style={th.scheme === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  return (
    <AppProviders>
      <ThemedStatusBar />
      <Gate />
    </AppProviders>
  );
}
