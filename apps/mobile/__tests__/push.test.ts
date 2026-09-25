import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MobileApi } from '../src/api';
import { routeForNotification, routeForPushData } from '../src/push/routing';

let mockProject: string | undefined = 'proj-1';
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: { eas: { projectId: mockProject } } };
    },
    easConfig: undefined,
  },
}));
// eslint-disable-next-line import/first
import { enablePush, disablePush, hasStoredPushToken } from '../src/push';

const apiWith = () => {
  const registerPushToken = jest.fn(async () => ({ id: 'p1' }));
  const unregisterPushToken = jest.fn(async () => undefined);
  return {
    api: { notifications: { registerPushToken, unregisterPushToken } } as unknown as MobileApi,
    registerPushToken,
    unregisterPushToken,
  };
};

describe('push routing', () => {
  it('routes notifications to the thing they are about', () => {
    expect(routeForNotification({ targetType: 'post', targetId: 'p1' })).toBe('/post/p1');
    expect(routeForNotification({ targetType: 'comment', data: { postId: 'p9' } })).toBe(
      '/post/p9',
    );
    expect(routeForNotification({ targetType: 'conversation', targetId: 'c1' })).toBe('/chat/c1');
    expect(routeForNotification({ targetType: 'community', targetId: 'g1' })).toBe('/community/g1');
    expect(routeForNotification({ targetType: 'user', actorUsername: 'ada' })).toBe('/user/ada');
    expect(routeForNotification({ kind: 'friend_request', actorUsername: 'bo' })).toBe('/user/bo');
  });
  it('returns null when there is nowhere sensible to go', () => {
    expect(routeForNotification({ targetType: 'post' })).toBeNull();
    expect(routeForNotification({ targetType: 'comment', data: {} })).toBeNull();
    expect(routeForNotification({ kind: 'system' })).toBeNull();
  });
  it('push payloads fall back to the notifications list', () => {
    expect(routeForPushData({ targetType: 'conversation', targetId: 'c1' })).toBe('/chat/c1');
    expect(routeForPushData({ targetType: 'post', targetId: 5 })).toBe('/notifications');
    expect(routeForPushData(undefined)).toBe('/notifications');
  });
});

describe('push registration', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockProject = 'proj-1';
  });

  it('asks permission, registers the Expo token with the API and remembers it', async () => {
    const { api, registerPushToken } = apiWith();
    const r = await enablePush(api);
    expect(r).toEqual({ ok: true, tokenTail: '23456]' });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(registerPushToken).toHaveBeenCalledWith(
      'ExponentPushToken[test-token-123456]',
      expect.stringMatching(/ios|android/),
    );
    expect(await hasStoredPushToken()).toBe(true);
  });

  it('does not register when the user says no', async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
      status: 'denied',
    });
    const { api, registerPushToken } = apiWith();
    expect(await enablePush(api)).toEqual({ ok: false, reason: 'denied' });
    expect(registerPushToken).not.toHaveBeenCalled();
  });

  it('says so plainly when the build has no EAS project id', async () => {
    mockProject = undefined;
    const { api } = apiWith();
    expect(await enablePush(api)).toEqual({ ok: false, reason: 'no_project' });
  });

  it('reports failure instead of throwing when the API rejects the token', async () => {
    const { api, registerPushToken } = apiWith();
    registerPushToken.mockRejectedValueOnce(new Error('boom'));
    expect(await enablePush(api)).toEqual({ ok: false, reason: 'failed' });
    expect(await hasStoredPushToken()).toBe(false);
  });

  it('disablePush unregisters the stored token and forgets it; a failing API does not block sign-out', async () => {
    const a = apiWith();
    await enablePush(a.api);
    a.unregisterPushToken.mockRejectedValueOnce(new Error('offline'));
    await expect(disablePush(a.api)).resolves.toBeUndefined();
    expect(a.unregisterPushToken).toHaveBeenCalledWith('ExponentPushToken[test-token-123456]');
    expect(await hasStoredPushToken()).toBe(false);
  });
});
