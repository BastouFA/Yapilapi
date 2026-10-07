import { Redirect } from 'expo-router';

/** The phone app's chat code goes back to its Yap tab (/inbox) after leaving a group: in Yap, that's the chats. */
export default function Inbox() {
  return <Redirect href="/" />;
}
