# Yap (Expo)

Yap is YAPILAPI's messaging as a phone app of its own, like a messenger: chats, calls and stories, with the same accounts, API and chats as YAPILAPI. Bundle id `com.yapilapi.yap` (iOS and Android), scheme `yap`, app name "Yap", and the Yap icon (drawn by `apps/api/scripts/build-icons.ts`, like YAPILAPI's).

**Status:** it type-checks, the iOS and Android bundles build (`npx expo export`), and touch targets pass. See "What has been run" below.

## What's in the app

- **Chats** (`app/(tabs)/index.tsx`): every conversation with its last message, time and unread count (also on the tab), search by name, username or last message, pull to refresh, live over the realtime socket. New chat (header) picks a person or starts a new group (`app/new-chat.tsx`). With no chats yet, the phone app's "Start a chat" panel. There is no archive: the API has no archived chats.
- **Chat** (`app/chat/[id].tsx`): the YAPILAPI phone app's chat screen, as it is: messages, voice notes, photos and videos, view once, replies, reactions, pins, search, games, polls and lists, location, Hold to Yap, translation, send later, wallpapers, audio and video calls, group info.
- **Calls** (`app/(tabs)/calls.tsx`): your recent calls in every chat you're in (`GET /v1/calls`), made or received, how each went ("Missed video call", "Audio call, 3 minutes"), when, and a button to call again. New call (`app/new-call.tsx`) picks a chat. Calls ring and connect through the phone app's `CallsProvider` (react-native-webrtc), so they need a development build, as in YAPILAPI.
- **Stories** (`app/(tabs)/stories.tsx`): yours, then new ones from people you follow, then the ones you've seen, played in the phone app's story viewer (like, reply into the chat). Adding a story opens YAPILAPI's camera.
- **Settings** (`app/(tabs)/settings.tsx`): your photo and name (Edit profile is the phone app's screen), who can message you and read receipts, blocked people, notifications on this phone and quiet hours, language and translation ("Languages I understand", "Translate automatically"), appearance, Your data (download, delete account; the stores ask this of any app you can sign up in), legal pages, log out, and "More in YAPILAPI" for everything else.
- **Welcome, log in, sign up, forgot password**: Yap's own welcome screen, then the phone app's sign-in screens (it's a YAPILAPI account). A new account skips YAPILAPI's interests and follows (`app/onboarding.tsx`); YAPILAPI asks them when it first opens.
- **Anything that isn't messaging** (a shared post, a profile, a community, a notification about a post): the shared code pushes a YAPILAPI path, which Yap has no screen for, so `app/+not-found.tsx` opens it in YAPILAPI (`yapilapi://…`) when it's installed, and on the web (`<web>/web/…`) otherwise, then goes back (`lib/elsewhere.ts`).
- **Links into Yap** (`app/+native-intent.tsx`, `lib/links.ts`): `yap://chat/<id>` and the web's `/yap/<id>` and `/inbox/<id>` open the chat; `yap://calls`, `yap://stories`, `yap://settings` open the tabs. Web links don't open Yap on their own yet (no associated domains: the web's `.well-known` files name YAPILAPI only).

## How the code is shared

There is one copy of the phone code. Yap's own files are in `apps/yap` (the tabs, welcome, new chat and new call, the link-out screen); everything else is imported from `apps/mobile` with relative paths, the way the phone app already imports `packages/*`:

- Screens are re-exported: `app/chat/[id].tsx` is `export { default } from '../../../mobile/app/chat/[id]'`, and the same for `login`, `signup`, `forgot-password`, `new-group`, `group-info`, `profile-edit` and `your-data`.
- Helpers and components come from `apps/mobile/lib` (`api`, `session`, `calls`, `push`, `i18n`, `ui`, `theme`, `stories`, `settings-extra`, …), and through them everything the chat uses.
- **Metro** (`metro.config.js`) watches `apps/mobile/app`, `apps/mobile/lib` and `packages`, and resolves every package imported from an `apps/mobile` file as if Yap had imported it, so the bundle has one React and one React Native from `apps/yap/node_modules`, whether or not `apps/mobile/node_modules` is installed. `app.json` turns off Expo's `tsconfigPaths` so Metro doesn't read the TypeScript mapping below.
- **TypeScript** (`tsconfig.json`) maps every package to `apps/yap/node_modules` (`paths`), for the same reason: one set of React Native types.
- **The scene life cycle plugin** is `apps/mobile/plugins/with-scene-lifecycle.js`, loaded by `plugins/with-scene-lifecycle.js` so it finds `expo/config-plugins` in Yap's node_modules.
- **Push**: `apps/mobile/lib/push.ts` reads `extra.app` from the app config; Yap's is `"yap"`, so it registers with `app: 'yap'`, and the API sends that phone only pushes about chats and calls (and sign-in alerts), titled "Yap" (`YAP_APP_PUSH_TYPES` in `apps/api/src/lib/push.ts`). New messages push in both apps, one per chat while it's unread (`apps/api/src/lib/message-push.ts`); tapping one opens the chat.
- **Strings**: all through the shared catalogs. Yap's few own ones start with `yapApp.` (in all eight languages); the rest are the phone app's.

When you change a shared file in `apps/mobile`, check both apps: `npx tsc --noEmit` in each, and `node scripts/check-targets.mjs` in `apps/mobile` plus `npm run check-targets` here (the same script, pointed at Yap).

Signing in is per app: each keeps its session in its own keychain. A shared keychain group (iOS) and account manager (Android) would sign in once for both; not done yet.

## Running it

```bash
cd apps/yap
npm install          # its own lockfile; the same package versions as apps/mobile (excluded from the pnpm workspace)
npx expo start --port 8083
```

As with the phone app, the API must be reachable from the phone: `YAPILAPI_API_URL=http://<LAN IP>:4000 YAPILAPI_WEB_URL=http://<LAN IP>:3000 npx expo start`. `app.config.js` reads `YAPILAPI_API_URL`, `YAPILAPI_WEB_URL` and `YAPILAPI_WS_URL`; `eas.json` sets `https://api.yapilapi.com` and `https://yapilapi.com` for preview and production builds, and a production build refuses local addresses or a missing `EAS_PROJECT_ID` (run `eas init` here: Yap is its own EAS project, App Store and Play listing).

Calls need a development build (`npx expo run:ios`, `npx expo run:android`, or EAS with the dev client): see "Calls need a development build" in `apps/mobile/README.md`; the same applies. `ios/` and `android/` are generated and git-ignored.

## What has been run

- `npx tsc --noEmit` here and in `apps/mobile`, touch targets in both, `npx expo export` for iOS and Android. With `apps/mobile/node_modules` installed too, the bundle's source map has one `react` and one `react-native`, both from `apps/yap/node_modules`.
- A Debug build on the iOS simulator (`npx expo prebuild -p ios`, `pod install`, `xcodebuild`), against a local API: the welcome screen, logging in (the phone app's screen), Chats with the unread count, Calls with a declined video call, Stories (empty, with Add to your story), Settings, and `yap://chat/<id>` opening the shared chat screen with Hold to Yap and suggested replies.
- Not run: a real call, push on a device, Android on a device or emulator, and the link out to YAPILAPI.
