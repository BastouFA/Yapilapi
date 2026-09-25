import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { Profile } from '../../../../packages/shared/src/types';
import { client } from '../../lib/api';
import { registerForPush } from '../../lib/push';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, Loading, Notice, Screen, useColors, useTabBarSpace } from '../../lib/ui';

/** Your profile with counts, settings and sign out. */
export default function ProfileScreen() {
  const c = useColors();
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
        <Notice>Log in from the Home tab.</Notice>
      </Screen>
    );
  if (!profile) return <Loading />;
  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}>
      <Card style={{ alignItems: 'center', gap: space[2], paddingVertical: space[6] }}>
        <Avatar name={profile.displayName} url={profile.avatarUrl} size={84} />
        <Text style={{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }}>{profile.displayName}</Text>
        <Text style={{ color: c.inkMuted }}>@{profile.username}</Text>
        {profile.bio ? <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22, textAlign: 'center' }}>{profile.bio}</Text> : null}
        <View style={{ flexDirection: 'row', gap: space[4], marginTop: space[2] }}>
          {(
            [
              ['Posts', profile.counts.posts],
              ['Followers', profile.counts.followers],
              ['Following', profile.counts.following],
              ['Friends', profile.counts.friends],
            ] as const
          ).map(([label, n]) => (
            <View key={label} style={{ alignItems: 'center' }} accessible accessibilityLabel={`${n} ${label}`}>
              <Text style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>{n}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 12 }}>{label}</Text>
            </View>
          ))}
        </View>
      </Card>
      <Button label="Capture a Real" icon="camera-outline" variant="secondary" onPress={() => router.push('/real')} />
      <Button label="Settings" icon="settings-outline" variant="secondary" onPress={() => router.push('/settings')} />
      <Button
        label="Turn on notifications"
        icon="notifications-outline"
        variant="secondary"
        onPress={async () => {
          const r = await registerForPush().catch(() => 'unavailable' as const);
          setNote(
            r === 'registered'
              ? 'Notifications are on.'
              : r === 'denied'
                ? 'Notifications are blocked in Settings.'
                : 'Notifications need a real phone and an EAS project.',
          );
        }}
      />
      {note ? <Notice>{note}</Notice> : null}
      <Button label="Log out" variant="ghost" onPress={signOut} />
    </ScrollView>
  );
}
