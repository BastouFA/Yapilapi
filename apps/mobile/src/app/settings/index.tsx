import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useAuth } from '../../auth/AuthProvider';
import { AppText, Button, ConfirmDialog, Icon, Screen } from '../../ui';

export function SettingsLink({ label, onPress }: { label: string; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: th.targetMin + 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
      }}
    >
      <AppText variant="body">{label}</AppText>
      <Icon name="chevron" color={th.colors.textMuted} size={20} />
    </Pressable>
  );
}

export default function Settings() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Screen scroll>
      <AppText variant="caption" tone="muted" style={{ marginBottom: th.space[3] }}>
        {t('settings.signedInAs', { email: user?.email ?? '' })}
      </AppText>
      <View>
        <SettingsLink
          label={t('settings.account')}
          onPress={() => router.push('/settings/account')}
        />
        <SettingsLink
          label={t('settings.privacy')}
          onPress={() => router.push('/settings/privacy')}
        />
        <SettingsLink
          label={t('settings.language')}
          onPress={() => router.push('/settings/language')}
        />
        <SettingsLink
          label={t('settings.notifications')}
          onPress={() => router.push('/settings/notifications')}
        />
        <SettingsLink
          label={t('settings.sessions')}
          onPress={() => router.push('/settings/sessions')}
        />
      </View>
      <View style={{ marginTop: th.space[8] }}>
        <Button
          label={t('settings.signOut')}
          variant="danger"
          block
          onPress={() => setConfirm(true)}
        />
      </View>
      <AppText
        variant="caption"
        tone="subtle"
        style={{ marginTop: th.space[6], textAlign: 'center' }}
      >{`${t('app.name')} · ${t('settings.version', { version: Constants.expoConfig?.version ?? '0' })}`}</AppText>
      <ConfirmDialog
        visible={confirm}
        title={t('settings.signOutTitle')}
        body={t('settings.signOutBody')}
        confirmLabel={t('settings.signOut')}
        destructive
        loading={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setBusy(true);
          void logout().finally(() => {
            setBusy(false);
            setConfirm(false);
          });
        }}
      />
    </Screen>
  );
}
