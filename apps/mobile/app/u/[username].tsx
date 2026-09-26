import { useLocalSearchParams } from 'expo-router';
import { ProfileView } from '../../lib/profile';

/** Someone's profile (link target for authors, mentions, followers and notifications). */
export default function UserScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  return <ProfileView username={username} />;
}
