import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { ProfileView } from '../../lib/profile';
import { RadioButton } from '../../lib/radio';

/**
 * Someone's profile (link target for authors, mentions, followers and notifications). A username
 * changed in the last 14 days still finds the person; the screen then moves to the new one.
 * "Play as radio" in the header plays their Yaps one after another.
 */
export default function UserScreen() {
  const { username, tab } = useLocalSearchParams<{ username: string; tab?: string }>();
  const onMoved = useCallback((next: string) => router.setParams({ username: next }), []);
  return (
    <>
      <Stack.Screen options={{ headerRight: () => (username ? <RadioButton compact station={{ kind: 'person', key: username }} /> : null) }} />
      <ProfileView username={username} onMoved={onMoved} initialTab={tab === 'answers' || tab === 'market' ? tab : undefined} />
    </>
  );
}
