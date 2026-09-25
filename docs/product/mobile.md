# Mobile app (`apps/mobile`)

YAPILAPI for iOS and Android: "Your social world. One place." Expo (React Native, TypeScript, expo-router). It talks to the same API as the web app, in **bearer-token mode**, and shares `@yapilapi/api-client` and the design tokens with the rest of the repo.

Status: first version, **verified only in Jest and by bundling**. It has not been run on a phone or a simulator. Read "Honest gaps" before promising anything.

## Run it

```bash
cd apps/mobile && npm install        # own install: the app is not an npm workspace (ADR 001)
EXPO_PUBLIC_API_URL=http://<your-machine>:4000 npm run mobile:start   # from the repo root; or `npm start` inside apps/mobile
npm run mobile:typecheck
npm run mobile:test
```

- API URL: `EXPO_PUBLIC_API_URL` (defaults to `http://10.0.2.2:4000` on the Android emulator and `http://localhost:4000` elsewhere). A real phone needs your machine's LAN address.
- Share links use `EXPO_PUBLIC_WEB_URL` (default `https://yapilapi.example`, a placeholder).
- Architecture decision for the repo layout: `docs/architecture/decisions/001-mobile-monorepo.md`.

## What is built

| Area           | What works                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign up        | Three steps: date of birth, account, profile. Age gate: under 13 is refused (and remembered on the device for 24 hours, and if the API refuses the age it shows the same blocked screen). 13 to 17 see a plain-language notice of the extra protections. Live username availability check.                                                                                                                                                   |
| Sign in        | Email and password, MFA challenge (authenticator code or recovery code), forgot-password request. Token stored in the platform secure store. Session restored on launch; if the server cannot be reached the cached profile is shown with an offline notice.                                                                                                                                                                                 |
| Onboarding     | Interests, people to follow (private accounts show "Requested"), then into the app. The router guard sends signed-in users with an unfinished profile here.                                                                                                                                                                                                                                                                                  |
| Home           | For You, Following, Friends. Pull to refresh, small pages (15), "why am I seeing this", more/less like this, mute or hide creator, mute topic. Like with a reaction picker (optimistic, rolls back on failure), save, share, delete own post.                                                                                                                                                                                                |
| Compose        | Text, photos and videos from the photo library (up to the API's limits; taking a new photo with the camera is not wired up), alt text per image, audience, community target, character counter. Sending goes through the outbox (see below).                                                                                                                                                                                                 |
| Post detail    | Full post, comments (newest first), replies, comment likes, post a comment or reply.                                                                                                                                                                                                                                                                                                                                                         |
| Profile        | Own and other people's. Follow / unfollow / cancel request, add friend / accept / remove friend, message, mute, block (with confirmation), edit profile with photo upload. Private accounts show what the API allows.                                                                                                                                                                                                                        |
| Inbox and chat | Conversation list, new direct message, chat with pending / failed rows, delete for everyone, typing indicator, read markers. Realtime over the WebSocket ticket flow (see below).                                                                                                                                                                                                                                                            |
| Communities    | Your communities, invitations (accept / decline), search and discover, community page with join / leave and its feed.                                                                                                                                                                                                                                                                                                                        |
| Notifications  | List with localised sentences, tap to open the target and mark read, mark all read. Push registration (see below).                                                                                                                                                                                                                                                                                                                           |
| Search         | People, communities and posts, plus suggested people and topics.                                                                                                                                                                                                                                                                                                                                                                             |
| Settings       | Privacy (private account, who can message me, default visibility, discoverability, personalisation, sensitive content, blocked accounts; teen accounts show locked values), sessions (list, revoke one, revoke all others), notification preferences and push on/off, language and display (language, theme, motion, data use), account (email verification, data export request and history, account deletion request and cancel), log out. |

### Cross-cutting

- **i18n.** English is complete. French, Arabic and Yoruba cover every key except the brand name, but they are **machine drafts** and need native review (same status as the web app, see `docs/product/i18n.md`). Missing keys fall back to English. No user-facing string is hardcoded: `t('key')` is typed from the English catalog, so a typo is a compile error. Plurals use `Intl.PluralRules` (Arabic has six forms). Dates and numbers use `Intl`.
- **RTL.** Selecting Arabic calls `I18nManager.forceRTL`. React Native only re-lays-out after a restart, so the app tells the user to restart. Until then the text is Arabic but the layout is still left-to-right.
- **Accessibility.** Every interactive element has a role and a label (icon-only buttons are labelled, counts are spoken: "Like, 2 likes"), 44 px minimum touch targets, live regions for errors and status, form errors tied to fields, reduced-motion preference respected, text scales with system font size. Colours are checked for WCAG AA contrast in a test.
- **Dark mode.** Light and dark palettes are generated from `packages/design-system/src/tokens.css` (`npm run tokens`); a test fails if the generated file is stale. The user can choose system, light or dark.
- **Offline and bad networks.** Every list and screen has loading, error with "Try again", empty and offline states. Recently viewed feed, posts, comments, conversations, messages, profiles and notifications are cached on the device and shown when the server cannot be reached (with a banner). Posts and chat messages you write while offline go to a durable outbox and are retried with exponential backoff (2 s, 4 s, 8 s ... 5 minutes, honouring `Retry-After`), in order, per account, surviving app restarts. Messages carry a `clientMessageId`, so the server drops duplicates; the API has no idempotency key for posts, so a post whose answer was lost is looked up in the author's recent posts before it is sent again.
- **Low bandwidth.** "Data use" is automatic (2G-class links), low or normal. In low mode images load on tap, avatars are initials only, lists use a "Load more" button instead of loading ahead, and uploads use smaller chunks. Nothing ever autoplays in any mode: video and audio are tiles that open in the system player.
- **Uploads.** Small files use one multipart request. Large files, or low-data mode, use the resumable chunked protocol: each chunk has a SHA-256, is retried with backoff, and an interrupted upload continues from the chunks the server already has.
- **Realtime.** Ticket from the API, socket, ready frame, heartbeat, resubscribe, reconnect with jittered backoff. The API socket has no replay, so after any gap the app refetches over REST. While the socket is down the chat shows "Live updates are paused. Messages will still send."
- **Push.** See below.
- **Security.** Bearer token in Keychain / Keystore (`expo-secure-store`), never in AsyncStorage or logs. The disk cache is keyed to the account and dropped on sign-out; the outbox and push token are cleared on sign-out too. Passwords are never stored.

## Push notifications

The API endpoints exist and are used: `POST /v1/notifications/push-tokens` (register an Expo push token), `DELETE /v1/notifications/push-tokens` (unregister), `GET /v1/notifications/push-tokens` (list, shown in settings). The app asks for permission only after an explanation screen and an explicit tap. Tapping a push while the app is running routes through the same function as the notifications list (`src/push/routing.ts`); an unknown payload opens the notifications list. A push tapped while the app is fully closed is **not** handled yet (no `getLastNotificationResponse` call), so it opens the app on the home tab.

### What needs a device or an account

- A **physical device**. Simulators cannot receive Expo push tokens; the app reports "not supported here" instead of failing.
- An **EAS project id** (`extra.eas.projectId` in `app.json`, from `eas init`). Without it the app says push is not configured. There is none in the repo.
- For iOS: an Apple developer account and APNs credentials. For Android: an FCM key uploaded to Expo. Neither is in the repo.
- The API must have push delivery switched on and reachable Expo push service (see `apps/api/src/lib/push-dispatch.ts`).

## Testing

`npm run mobile:test` (Jest with `jest-expo` and Testing Library): **16 suites, 148 tests**, plus `npm run mobile:typecheck` (strict, clean) and two bundling smoke tests done by hand (`expo export` for web and Android Hermes bytecode).

Covered: token storage; API wrapper (bearer mode, error mapping, every mobile-only endpoint exists in `docs/api/openapi.json`); auth session boot, offline boot, sign-out cleanup; i18n catalogs (same keys, same placeholders, plural forms, no empty strings); tokens and contrast; the outbox, its runner and the chat-row merge; the realtime client (ticket, reconnect with a new ticket, heartbeat, resubscribe); chunked and resumable upload; push routing and registration; screens for login, signup (age gate, teen notice), feed, post card, post detail, profile, chat, notifications, language and RTL, account (export, deletion).

Not covered: create/edit profile with photo, compose, communities, search, onboarding, privacy and sessions screens, MFA screen, forgot-password screen (they type-check and bundle, but have no component tests); anything that needs native modules (camera, image picker, location, real WebSocket, real push).

## Honest gaps

Things that are missing or that you should not assume:

1. **Never run on a real device or a simulator.** Rendering, gestures, keyboard behaviour, safe areas, the tab bar, permissions prompts, deep links and performance are unverified. Expect layout bugs on first run.
2. **Data export cannot be downloaded in the app.** You can request it and see its status, but saving the file needs the website.
3. **Two-step verification can only be turned on or off on the web** (QR code and recovery-code screens are not built). Signing in with MFA works.
4. **Communities are read and join only.** No members list, channels, moderation, admin, or creating a community. No events, places, commerce, live, creator, studio, ads, AI or business surfaces at all.
5. **No video or audio playback.** They open in the system browser or player. No voice or video calls.
6. **Chat has no attachments, reactions, replies UI or group management.** Text only. Group conversations can be read and written but not created or edited.
7. **Polls can be voted on but not created.** Compose has no poll, link preview, location or scheduling options.
8. **Friend requests cannot be cancelled** once sent: the API has no cancel endpoint, so the button shows "Request sent" and is disabled.
9. **Profile picture:** `PUT /v1/profile/avatar` needs the uploaded image to be `ready`. The app waits up to about 10 seconds for the server to finish resizing and then shows an error if it is still not ready. No cover photo editing.
10. **RTL needs a restart** to flip the layout (a React Native limitation). Direction-sensitive icons flip once the layout does.
11. **Translations are machine drafts** (French, Arabic, Yoruba). Do not ship without native review. API error messages that the app does not know are English only.
12. **API gap: `conversation.added` is not sent for a new direct conversation.** The app works around it by refetching the inbox when a generic notification arrives, so a brand new chat can appear late.
13. **Cached content is not encrypted at rest.** It lives in the app sandbox (AsyncStorage) while the person is signed in, including recent messages. Only the token is in the secure store. Decide whether that is acceptable, or shorten the persisted set (`PERSISTED_DOMAINS` in `src/data/keys.ts`).
14. **Placeholders that must change before a store build:** bundle id and package (`app.yapilapi.mobile`), the universal-link host (`yapilapi.example`; the site must also serve `apple-app-site-association` and `assetlinks.json`), icons and splash images (none provided), EAS project id, store metadata, privacy nutrition labels.
15. **No crash reporting or analytics** in the app.
16. **Cleartext HTTP** is only for local development; a release build must point at an HTTPS API.
17. Only three feed modes exist (For You, Following, Friends). The API's Communities and Local feeds are not in the app, so location is never requested even though the location plugin and permission text are declared in `app.json` (remove them or build Local before store review). The camera permission text is declared for the same reason. Per-conversation mute and pin are not exposed.
18. Deep links from the web (post, profile, community, inbox) are declared but untested; anything the app does not recognise opens the home tab.

## Where things are

```
apps/mobile/
  src/app/        routes (expo-router): (auth), (tabs), post, user, chat, community, settings, compose, ...
  src/api/        mobile API wrapper: shared client in bearer mode plus mobile-only endpoints
  src/auth/       AuthProvider, secure token store, pending MFA challenge
  src/data/       TanStack Query hooks per domain, cache patching, persisted domains
  src/offline/    outbox, outbox runner, provider
  src/realtime/   WebSocket client and provider
  src/media/      chunked / resumable upload
  src/push/       registration and tap routing
  src/i18n/       core (t, plurals, RTL) and messages/{en,fr,ar,yo}.ts
  src/theme/      tokens.generated.ts (generated) and theme provider
  src/ui/         Text, Button, TextField, Avatar, lists, states, controls
  src/features/   PostCard, media, comments, profile view, chat rows, notification text
  __tests__/      Jest tests and the fake fetch / socket harness
```
