import { ScrollView } from 'react-native';
import { FriendsFinder } from '../lib/friends';
import { space } from '../lib/theme';
import { useColors } from '../lib/ui';

/** Find friends: contacts already on YAPILAPI (Follow) and the others (Invite). Opened from Profile. */
export default function FindFriendsScreen() {
  const c = useColors();
  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], paddingBottom: space[8] }}>
      <FriendsFinder />
    </ScrollView>
  );
}
