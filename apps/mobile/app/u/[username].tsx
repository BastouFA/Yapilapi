import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { ProfileView } from '../../lib/profile';

/**
 * Someone's profile (link target for authors, mentions, followers and notifications). A username
 * changed in the last 14 days still finds the person; the screen then moves to the new one.
 */
export default function UserScreen() {
  const { username, tab } = useLocalSearchParams<{ username: string; tab?: string }>();
  const onMoved = useCallback((next: string) => router.setParams({ username: next }), []);
  return <ProfileView username={username} onMoved={onMoved} initialTab={tab === 'answers' || tab === 'market' ? tab : undefined} />;
}
