# YAPILAPI mobile (Expo)

React Native + Expo Router app for iOS and Android. It shares the API client, types and design tokens with the web app, and authenticates with a Bearer session token stored in the OS keychain (`expo-secure-store`).

**Status:** all five tabs work against the API: Home (sign-in + For You feed), Discover (universal search), Create (text posts with visibility), Inbox (conversations and chat), Profile (counts, sign out). It type-checks and the iOS bundle builds (`npx expo export --platform ios`), but it has not been run on a device or simulator yet. Chat polls every few seconds; realtime, media upload, notifications and push are still to do. Dependencies are kept out of the main pnpm workspace so web and API installs stay light.

```bash
cd apps/mobile
npm install
npx expo start
```

Set `expo.extra.apiUrl` in `app.json` to an address the device can reach (your machine's LAN IP, not `localhost`, when testing on a phone).

Every screen calls the same endpoints as the web app through `lib/api.ts`, and colors come from `packages/design-system/tokens.json` via `lib/theme.ts`.
