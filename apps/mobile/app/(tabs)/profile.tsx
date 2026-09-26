import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useT } from '../../lib/i18n';
import { registerForPush } from '../../lib/push';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { ProfileView } from '../../lib/profile';
import { Button, Loading, Notice, Screen, useTabBarSpace } from '../../lib/ui';

/** Your profile with counts, your posts, settings and sign out. */
export default function ProfileScreen() {
  const { t } = useT();
  const { me, signOut } = useSession();
  const bottom = useTabBarSpace();
  const [note, setNote] = useState<string | null>(null);

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.common.signedOut')}</Notice>
      </Screen>
    );
  if (!me) return <Loading />;
  return (
    <ProfileView
      username={me.username}
      bottom={bottom}
      actions={
        <View style={{ gap: space[3] }}>
          <Button label={t('m.real.capture')} icon="camera-outline" variant="secondary" onPress={() => router.push('/real')} />
          <Button label={t('m.title.settings')} icon="settings-outline" variant="secondary" onPress={() => router.push('/settings')} />
          <Button
            label={t('m.push.enable')}
            icon="notifications-outline"
            variant="secondary"
            onPress={async () => {
              const r = await registerForPush().catch(() => 'unavailable' as const);
              setNote(r === 'registered' ? t('m.push.on') : r === 'denied' ? t('m.push.blocked') : t('m.push.unavailable'));
            }}
          />
          {note ? <Notice>{note}</Notice> : null}
          <Button label={t('auth.logout')} variant="ghost" onPress={signOut} />
        </View>
      }
    />
  );
}
