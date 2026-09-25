/* Global test setup: in-memory stand-ins for native storage modules. Nothing here touches a network or a device. */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock.js'),
);

const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  getItemAsync: jest.fn(async (k: string) => mockSecure.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecure.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockSecure.delete(k);
  }),
  __store: mockSecure,
}));

/* expo-router: screens are tested in isolation, so navigation is a recorded stub (read it through `globalThis.__mockRouter`). */
jest.mock('expo-router', () => {
  const React = require('react');
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
    canGoBack: () => true,
  };
  (globalThis as Record<string, unknown>).__mockRouter = router;
  (globalThis as Record<string, unknown>).__mockParams = {};
  const Pass = ({ children }: { children?: unknown }) =>
    React.createElement(React.Fragment, null, children ?? null);
  const Stack = Object.assign(Pass, { Screen: () => null, Protected: Pass });
  return {
    useRouter: () => router,
    useLocalSearchParams: () => (globalThis as Record<string, unknown>).__mockParams,
    useNavigation: () => ({ addListener: () => () => undefined }),
    Stack,
    Tabs: Object.assign(Pass, { Screen: () => null }),
    Redirect: () => null,
  };
});

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: (p: Record<string, unknown>) =>
      React.createElement(View, {
        testID: 'expo-image',
        accessibilityLabel: p['accessibilityLabel'],
        accessibilityRole: 'image',
      }),
  };
});

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({
    granted: false,
    status: 'undetermined',
    canAskAgain: true,
  })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[test-token-123456]' })),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: { DEFAULT: 3 },
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('expo-device', () => ({ manufacturer: 'Test', modelName: 'Jest Phone', isDevice: true }));

/* expo-crypto: the jest-expo stub returns zeros/undefined; back it with Node's crypto so hashes and ids are real in tests. */
jest.mock('expo-crypto', () => {
  const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    randomUUID: () => nodeCrypto.randomUUID(),
    digest: async (_alg: string, data: Uint8Array) => {
      const b = nodeCrypto.createHash('sha256').update(data).digest();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
});
