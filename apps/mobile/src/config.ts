import { Platform } from 'react-native';

/**
 * API base URL. Set `EXPO_PUBLIC_API_URL` (inlined by Metro at build time). Defaults suit local development:
 * the Android emulator reaches the host machine at 10.0.2.2, everything else at localhost.
 */
const fromEnv = process.env.EXPO_PUBLIC_API_URL;
export const API_URL: string =
  (fromEnv && fromEnv.trim()) ||
  (Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000');

/** Public web origin used to build shareable links (matches the universal-link host in app.json). */
export const WEB_URL: string =
  process.env.EXPO_PUBLIC_WEB_URL?.trim() || 'https://yapilapi.example';
