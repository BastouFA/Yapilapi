import { NativeModules } from 'react-native';
import type * as WebRTC from 'react-native-webrtc';
import type InCallManagerType from 'react-native-incall-manager';

/**
 * react-native-webrtc and react-native-incall-manager are native modules: they exist in a
 * development build (`npx expo run:ios`, `npx expo run:android` or an EAS build), not in
 * Expo Go. Load them lazily so the rest of the app still runs in Expo Go, and let the call
 * UI say plainly that calls need a development build.
 */
export const callsSupported = !!NativeModules.WebRTCModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const rtc: typeof WebRTC | null = callsSupported ? (require('react-native-webrtc') as typeof WebRTC) : null;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const incall: typeof InCallManagerType | null = NativeModules.InCallManager
  ? (require('react-native-incall-manager').default as typeof InCallManagerType)
  : null;

/** Audio routing, ringing and the proximity sensor. Every call is a no-op without the native module. */
export const audio = {
  available: !!incall,
  start(kind: 'audio' | 'video') {
    try {
      incall?.start({ media: kind });
      incall?.setKeepScreenOn(true);
    } catch {}
  },
  stop() {
    try {
      incall?.stop();
      incall?.setKeepScreenOn(false);
    } catch {}
  },
  speaker(on: boolean) {
    try {
      incall?.setForceSpeakerphoneOn(on);
    } catch {}
  },
  ring() {
    try {
      incall?.startRingtone('_DEFAULT_', [0, 800, 600], 'playback', 45);
    } catch {}
  },
  stopRing() {
    try {
      incall?.stopRingtone();
    } catch {}
  },
};
