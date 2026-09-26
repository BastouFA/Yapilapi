import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { Profile } from '../../../../packages/shared/src/types';
import { client } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { registerForPush } from '../../lib/push';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, Loading, Notice, Screen, useColors, userText, useTabBarSpace } from '../../lib/ui';

/** Your profile with counts, settings and sign out. */
export default function ProfileScreen() {
  const c = useColors();
  const { t, number } = useT();
  const { me, signOut } = useSession();
  const bottom = useTabBarSpace();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!me) return setProfile(me === null ? null : undefined);
      void (async () => setProfile((await (await client()).users.get(me.username)).profile))().catch(() => setProfile(null));
    }, [me]),
  );

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.common.signedOut')}</Notice>
      </Screen>
    );
  if (!profile) return <Loading />;
  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}>
      <Card style={{ alignItems: 'center', gap: space[2], paddingVertical: space[6] }}>
        <Avatar name={profile.displayName} url={profile.avatarUrl} size={84} />
        <Text style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>{profile.displayName}</Text>
        <Text style={[{ color: c.inkMuted }, userText]}>@{profile.username}</Text>
        {profile.bio ? <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 22, textAlign: 'center' }, userText]}>{profile.bio}</Text> : null}
        <View style={{ flexDirection: 'row', gap: space[4], marginTop: space[2] }}>
          {(
            [
              ['profile.posts', profile.counts.posts],
              ['profile.followers', profile.counts.followers],
              ['profile.following', profile.counts.following],
              ['profile.friends', profile.counts.friends],
            ] as const
          ).map(([key, n]) => (
            <View key={key} style={{ alignItems: 'center' }} accessible accessibilityLabel={t('m.common.stat', { label: t(key), count: n })}>
              <Text style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>{number(n)}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t(key)}</Text>
            </View>
          ))}
        </View>
      </Card>
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
    </ScrollView>
  );
}
