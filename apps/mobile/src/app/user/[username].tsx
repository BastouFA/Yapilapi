import React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useAuth } from '../../auth/AuthProvider';
import { ProfileView } from '../../features/ProfileView';

export default function UserProfile() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { user } = useAuth();
  return (
    <>
      <Stack.Screen options={{ title: `@${username}` }} />
      <ProfileView username={username} self={user?.profile.username === username} />
    </>
  );
}
