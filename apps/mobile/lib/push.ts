import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { client } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/**
 * Ask for permission and register this phone with the API. Needs a physical
 * device and an EAS project id (app.json → extra.eas.projectId) for Expo push tokens.
 */
export async function registerForPush(): Promise<'registered' | 'denied' | 'unavailable'> {
  if (!Device.isDevice) return 'unavailable';
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: Notifications.AndroidImportance.DEFAULT });
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'denied';
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return 'unavailable';
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await (await client()).push.subscribe({ kind: 'expo', endpoint: token });
  return 'registered';
}
