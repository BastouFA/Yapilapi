# YAPILAPI mobile (Expo)

React Native + Expo Router app for iOS and Android. It shares the API client, types and design tokens with the web app, and authenticates with a Bearer session token stored in the OS keychain (`expo-secure-store`).

**Status:** it type-checks and the iOS and Android bundles build (`npx expo export --platform ios` / `android`), but it has not been run on a device or simulator yet. Treat everything below as untested on hardware until someone does.

## What's in the app

- **Tabs** (floating tab bar with a raised Create button): Home (sign-in, then the For you / Following / Friends feed), Discover (universal search), Create (text posts with visibility, or a Real), Inbox (conversations, live over the realtime socket), Profile (counts, settings, notifications, log out).
- **Post** (`/p/[id]`): the post, likes, saves, comments and replies.
- **Community** (`/c/[slug]`): join or leave, and Posts, FAQ and Members tabs. Moderators can add and remove FAQ entries.
- **Chat** (`/chat/[id]`): messages arrive over the realtime socket; audio and video call buttons in the header.
- **Settings**: family supervision (accept or decline a link, invite a teen, and for guardians the message, daily reminder and quiet-hours controls with a week of minutes) and the advertising consent switch.
- **Usage heartbeat**: while the app is in the foreground it calls `POST /v1/me/usage/heartbeat` once a minute. A supervised teen past the daily reminder their family set sees a break prompt once a day.
- **Calls**: see below.

There is no live screen on mobile yet, so live video and live gifts are web only.

## Running it

```bash
cd apps/mobile
npm install
npx expo start
```

Set `expo.extra.apiUrl` in `app.json` to an address the device can reach (your machine's LAN IP, not `localhost`, when testing on a phone). The realtime socket uses the same host (`ws://…/v1/realtime`).

Everything except calls runs in Expo Go (`npx expo start --go`, since the dev client is installed and `expo start` now targets it by default).

## Calls need a development build

Audio and video calls use `react-native-webrtc` (with `@config-plugins/react-native-webrtc`) and `react-native-incall-manager` (earpiece or speaker, ringtone). These are native modules that Expo Go does not include, so calls only work in a development build:

```bash
npx expo run:ios        # needs Xcode
npx expo run:android    # needs Android Studio
# or an EAS build with the expo-dev-client installed
```

In Expo Go the app still runs; tapping a call button explains that calls need the full app, and an incoming call can only be declined.

How calls work, and why a phone can call a browser:

- The protocol is the web app's (`apps/web/components/Calls.tsx`): `POST /v1/conversations/:id/calls` rings everyone else with a realtime `call.incoming` event and a `call_incoming` push. Each person who answers triggers `call.answered`, and the caller sends them an offer. Offers, answers and ICE candidates go through `POST /v1/calls/:id/signal` and arrive as `call.signal`. `call.declined` and `call.left` end a 1:1 call. Media is peer to peer; ICE servers (STUN, plus TURN when `TURN_URLS` and `TURN_SECRET` are set on the API) come with each call.
- Ringing lasts 45 seconds, like the web and the API.
- The phone asks for the microphone (and camera for video) before it rings anyone or answers. If the microphone is blocked it says so and offers to open Settings; if only the camera is blocked a video call continues with audio.
- In a call: mute, camera on or off, switch camera, speaker or earpiece, hang up. Audio calls start on the earpiece and video calls on the speaker.
- Push: the API now sends `call_incoming` pushes with the call id, the `call_incoming` category (Answer and Decline buttons) and the `calls` Android channel. Both buttons open the app. Push needs `extra.eas.projectId` and a physical phone, and the person has to tap "Turn on notifications" on the Profile tab.

Known limits, stated plainly:

- `react-native-webrtc` 124 and `react-native-incall-manager` 4.3 are not marked as tested on the New Architecture (which React Native 0.86 always uses). They load through React Native's interop layer. `npx expo-doctor` flags this. This has not been verified on a device.
- No CallKit or ConnectionService yet: a call does not ring on the lock screen like a phone call, only as a notification. That needs VoIP push (PushKit) and a native call UI.
- Group calls use the same mesh as the web (the caller connects to each person). It is built for 1:1 calls first.
- iOS keeps call audio going in the background (`UIBackgroundModes: audio`), and the realtime socket stays open during a call.

Every screen calls the same endpoints as the web app through `lib/api.ts` and `packages/api-client`, and colors, spacing and radii come from `packages/design-system/tokens.json` via `lib/theme.ts`, in light and dark.
