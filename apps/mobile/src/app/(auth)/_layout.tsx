import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';

export const unstable_settings = { initialRouteName: 'welcome' };

export default function AuthLayout() {
  const th = useTheme();
  const t = useT();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: th.colors.surface },
        headerTintColor: th.colors.text,
        contentStyle: { backgroundColor: th.colors.bg },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: t('login.title') }} />
      <Stack.Screen name="mfa" options={{ title: t('mfa.title') }} />
      <Stack.Screen name="signup" options={{ title: t('signup.title') }} />
      <Stack.Screen name="forgot" options={{ title: t('forgot.title') }} />
    </Stack>
  );
}
