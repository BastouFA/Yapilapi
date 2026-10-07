import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { client } from './api';
import { tr } from './locale';

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
 * notification, and a high-importance Android channel so the call rings. Button and channel
 * names are in the app's language; CallsProvider registers them again when it changes.
 */
export async function configureCallNotifications() {
  try {
    await Notifications.setNotificationCategoryAsync('call_incoming', [
      { identifier: 'answer', buttonTitle: tr('m.calls.answer'), options: { opensAppToForeground: true } },
      { identifier: 'decline', buttonTitle: tr('m.common.decline'), options: { opensAppToForeground: true, isDestructive: true } },
    ]);
    if (Platform.OS === 'android')
      await Notifications.setNotificationChannelAsync('calls', {
        name: tr('m.push.channel.calls'),
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
    await Notifications.setNotificationChannelAsync('default', { name: tr('m.push.channel.default'), importance: Notifications.AndroidImportance.DEFAULT });
  await configureCallNotifications();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'denied';
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return 'unavailable';
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await (await client()).push.subscribe({ kind: 'expo', endpoint: token, ...appTag() });
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token).catch(() => {});
  return 'registered';
}

const PUSH_TOKEN_KEY = 'ypl_push_token';

/**
 * Which app registers: the Yap phone app (apps/yap, `extra.app` in its app.json) shares this file
 * and says so, and the API then sends it only pushes about chats and calls. YAPILAPI says nothing.
 */
const appTag = (): { app?: 'yap' } => ((Constants.expoConfig?.extra as { app?: string } | undefined)?.app === 'yap' ? { app: 'yap' } : {});

/**
 * Notifications follow the account in use: after switching accounts (or logging in to another),
 * this phone's push address moves to that account (the API moves an address to whoever registers
 * it last). Only when notifications were already allowed; this never asks.
 */
export async function followActiveAccount() {
  try {
    if (!Device.isDevice) return;
    if ((await Notifications.getPermissionsAsync()).status !== 'granted') return;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    const token = (await SecureStore.getItemAsync(PUSH_TOKEN_KEY)) ?? (projectId ? (await Notifications.getExpoPushTokenAsync({ projectId })).data : null);
    if (!token) return;
    await (await client()).push.subscribe({ kind: 'expo', endpoint: token, ...appTag() });
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  } catch {
    // Offline or no push service: tried again at the next switch or sign-in.
  }
}

/** Before logging out of an account on this phone: it stops sending notifications here. */
export async function stopPushForThisAccount() {
  try {
    const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
    if (token) await (await client()).push.unsubscribe(token);
  } catch {
    // The API also forgets addresses that stop working.
  }
}

/**
 * Opening a chat: the notifications about its new messages already on this phone go (the API
 * clears its own when the chat is read). Calls are left alone.
 */
export async function dismissChatNotifications(conversationId: string) {
  try {
    for (const n of await Notifications.getPresentedNotificationsAsync()) {
      const data = (n.request.content.data ?? {}) as { type?: string; entityType?: string; entityId?: string };
      if ((data.type === 'message' || data.type === 'yap_received') && data.entityType === 'conversation' && data.entityId === conversationId)
        await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch {
    // Not available in this environment (for example a web preview).
  }
}
