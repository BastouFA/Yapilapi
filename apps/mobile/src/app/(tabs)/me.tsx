import React from 'react';
import { useMe } from '../../auth/AuthProvider';
import { ProfileView } from '../../features/ProfileView';

export default function Me() {
  const me = useMe();
  return <ProfileView username={me.profile.username} self />;
}
