# YAPILAPI mobile (Expo)

React Native + Expo Router app for iOS and Android. It shares the API client, types and design tokens with the web app, and authenticates with a Bearer session token stored in the OS keychain (`expo-secure-store`).

**Status:** foundation only. Tab navigation (Home, Discover, Create, Inbox, Profile), sign-in and the For You feed are written; Discover, Create, Inbox and Profile screens still need to be built. This app has not been installed or run yet — dependencies are kept out of the main pnpm workspace so the web and API installs stay light.

```bash
cd apps/mobile
npm install
npx expo start
```

Set `expo.extra.apiUrl` in `app.json` to an address the device can reach (your machine's LAN IP, not `localhost`, when testing on a phone).

Remaining screens (`discover`, `create`, `inbox`, `profile`) must be added under `app/` before the tab bar is complete; each should call the same endpoints the web pages use through `lib/api.ts`.
