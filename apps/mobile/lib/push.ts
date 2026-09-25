import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { client } from './api';

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    // While the app is open, incoming calls ring on the in-app call screen (realtime
    // `call.incoming`), so the push banner would only duplicate it.
    const isCall = (n.request.content.data as { type?: string } | undefined)?.type === 'call_incoming';
    return { shouldShowBanner: !isCall, shouldShowList: !isCall, shouldPlaySound: false, shouldSetBadge: false };
  },
});

/**
 * The API sends `call_incoming` pushes with categoryId "call_incoming" and channelId "calls"
 * (apps/api/src/lib/push.ts). Register both here: Answer and Decline buttons on the
 * notification, and a high-importance Android channel so the call rings.
 */
export async function configureCallNotifications() {
  try {
    await Notifications.setNotificationCategoryAsync('call_incoming', [
      { identifier: 'answer', buttonTitle: 'Answer', options: { opensAppToForeground: true } },
      { identifier: 'decline', buttonTitle: 'Decline', options: { opensAppToForeground: true, isDestructive: true } },
    ]);
    if (Platform.OS === 'android')
      await Notifications.setNotificationChannelAsync('calls', {
        name: 'Calls',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 800, 600, 800],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
  } catch {
    // Not available in this environment (for example a web preview).
  }
}

/**
 * Ask for permission and register this phone with the API. Needs a physical
 * device and an EAS project id (app.json → extra.eas.projectId) for Expo push tokens.
 */
export async function registerForPush(): Promise<'registered' | 'denied' | 'unavailable'> {
  if (!Device.isDevice) return 'unavailable';
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: Notifications.AndroidImportance.DEFAULT });
  await configureCallNotifications();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'denied';
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return 'unavailable';
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await (await client()).push.subscribe({ kind: 'expo', endpoint: token });
  return 'registered';
}
