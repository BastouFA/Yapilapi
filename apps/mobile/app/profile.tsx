import { router, useFocusEffect } from 'expo-router';
import { registerForPush } from '../lib/push';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import type { Profile } from '../../../packages/shared/src/types';
import { client, signOut } from '../lib/api';
import { space } from '../lib/theme';
import { Button, Loading, Screen, useColors } from '../lib/ui';

/** Your profile with counts, and sign out. */
export default function ProfileScreen() {
  const c = useColors();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const api = await client();
        const { user } = await api.auth.me();
        setProfile((await api.users.get(user.username)).profile);
      })().catch(() => setProfile(null));
    }, []),
  );

  if (profile === undefined) return <Loading />;
  if (profile === null)
    return (
      <Screen>
        <Text style={{ color: c.ink }}>Log in from the Home tab.</Text>
      </Screen>
    );
  return (
    <Screen>
      <Text style={{ color: c.ink, fontSize: 26, fontWeight: '700' }}>{profile.displayName}</Text>
      <Text style={{ color: c.inkMuted }}>@{profile.username}</Text>
      {profile.bio ? <Text style={{ color: c.ink, fontSize: 15, lineHeight: 23 }}>{profile.bio}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space[4] }}>
        {(
          [
            ['Posts', profile.counts.posts],
            ['Followers', profile.counts.followers],
            ['Following', profile.counts.following],
            ['Friends', profile.counts.friends],
          ] as const
        ).map(([label, n]) => (
          <Text key={label} style={{ color: c.ink }}>
            <Text style={{ fontWeight: '700' }}>{n}</Text> {label}
          </Text>
        ))}
      </View>
      <Button label="Capture a Real" variant="secondary" onPress={() => router.push('/real')} />
      <Button
        label="Turn on notifications"
        variant="secondary"
        onPress={async () => {
          const r = await registerForPush();
          setNote(
            r === 'registered'
              ? 'Notifications are on.'
              : r === 'denied'
                ? 'Notifications are blocked in Settings.'
                : 'Notifications need a real phone and an EAS project.',
          );
        }}
      />
      {note ? <Text style={{ color: c.inkMuted }}>{note}</Text> : null}
      <Button
        label="Log out"
        variant="secondary"
        onPress={async () => {
          await signOut();
          setProfile(null);
        }}
      />
    </Screen>
  );
}
