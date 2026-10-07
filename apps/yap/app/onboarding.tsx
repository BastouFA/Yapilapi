import { Redirect } from 'expo-router';

/**
 * A new account's first steps (interests, people to follow) are YAPILAPI's, for its feed: Yap goes
 * straight to the chats, and YAPILAPI asks them the first time it opens.
 */
export default function Onboarding() {
  return <Redirect href="/" />;
}
