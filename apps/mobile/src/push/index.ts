import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import type { MobileApi } from '../api';
import { kv } from '../lib/kv';

export type PushState = 'unsupported' | 'undetermined' | 'denied' | 'granted';
const TOKEN_KEY = 'yl.push.token.v1';

/** How notifications look while the app is open: banner + list entry, no sound, no badge (calm by default). */
export function configureForegroundNotifications(): void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    /* module unavailable (web preview, tests) */
  }
}

export async function pushState(): Promise<PushState> {
  if (Platform.OS === 'web' || !Device.isDevice) return 'unsupported';
  try {
    const p = await Notifications.getPermissionsAsync();
    return p.granted
      ? 'granted'
      : p.canAskAgain === false || p.status === 'denied'
        ? p.status === 'undetermined'
          ? 'undetermined'
          : 'denied'
        : 'undetermined';
  } catch {
    return 'unsupported';
  }
}

export type PushResult =
  | { ok: true; tokenTail: string }
  | { ok: false; reason: 'unsupported' | 'denied' | 'no_project' | 'failed' };

/**
 * Ask for permission (call ONLY after the explanation screen and an explicit tap), obtain an Expo push token and register
 * it with the API. Needs a physical device and an EAS project id (see docs/product/mobile.md, "What needs a device or an account").
 */
export async function enablePush(api: MobileApi): Promise<PushResult> {
  if (Platform.OS === 'web' || !Device.isDevice) return { ok: false, reason: 'unsupported' };
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'YAPILAPI',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'denied' };
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
        ?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return { ok: false, reason: 'no_project' };
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.notifications.registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
    await kv.set(TOKEN_KEY, token);
    return { ok: true, tokenTail: token.slice(-6) };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Sign-out / turn-off: tell the API to stop pushing to this install. Best effort. */
export async function disablePush(api: MobileApi): Promise<void> {
  const token = await kv.get<string>(TOKEN_KEY);
  if (!token) return;
  try {
    await api.notifications.unregisterPushToken(token);
  } catch {
    /* the server also drops invalid tokens itself */
  }
  await kv.remove(TOKEN_KEY);
}

export const hasStoredPushToken = async () => (await kv.get<string>(TOKEN_KEY)) !== null;
