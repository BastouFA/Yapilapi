# Yap on its own

Yap (chats) can be used on its own, like a messenger app, in two steps.

## Step 1: Yap mode (built)

- **Web:** `/yap` shows your chats with nothing around them. On a computer the list sits on the
  left and the open chat on the right. On a phone you see one at a time. Each chat is at `/yap/<id>`, and
  "Open YAPILAPI" goes back to the full app. The regular Yap page (`/inbox`) has an
  "Open Yap on its own" button.
- **Installs as its own app:** `/yap` has its own manifest (`public/yap.webmanifest`, scope
  `/yap`) and icon (`public/yap-icon*.png`). Chrome, Edge and Android offer "Add Yap to home
  screen". On iPhone and iPad, Yap mode explains how: Share, then Add to Home Screen. Once added,
  it opens straight into your chats under the name "Yap".
- **Same account, same chats:** it is the same site, so signing in, chats, calls, games and
  notifications are all shared with YAPILAPI.

Code: `apps/web/app/(app)/yap/`, `apps/web/components/YapShell.tsx`, `apps/web/lib/chat-base.ts`
(chat links stay in whichever mode you're in).

## Step 2: a separate Yap phone app (built; run on the iOS simulator, not yet on a phone)

`apps/yap` is a second Expo app, "Yap" (`com.yapilapi.yap`, scheme `yap`, the Yap icon), with the
same accounts, API and chats as YAPILAPI. Details and how to run it: `apps/yap/README.md`.

- **Tabs, like a messenger:** Chats (unread counts, search, New chat and New group), Calls (your
  recent calls from the new `GET /v1/calls`, call again, New call), Stories (yours, then new and seen
  ones from people you follow, in the phone app's viewer) and Settings (photo and name, who can
  message you and read receipts, blocked people, notifications and quiet hours, language,
  appearance, your data and deleting your account, log out, "More in YAPILAPI").
- **One copy of the code:** the chat, sign-in, new group, group info, edit profile and your data
  screens are the phone app's own (`apps/mobile/app/*`, re-exported), and so are the helpers in
  `apps/mobile/lib`. Metro and TypeScript take every package from Yap's own `node_modules`, so there
  is one React Native. Nothing moved: `apps/mobile` works as before.
- **Its own install:** `apps/yap` is outside the pnpm workspace like `apps/mobile`, with its own
  lockfile and exactly the phone app's package versions (fewer packages: no camera, contacts or
  phone-number libraries).
- **Links out:** anything that isn't a chat or a call (a shared post, a profile) opens YAPILAPI when
  it's installed (`yapilapi://…`), and the web otherwise. `yap://chat/<id>` and the web's `/yap/<id>`
  open a chat in Yap.
- **Push:** Yap registers its phone with `app: 'yap'`, and the API sends it only chats and calls
  (calls, Yaps, chat reminders, view-once screenshots, location, Market offers) and sign-in alerts,
  titled "Yap". YAPILAPI still gets everything. Plain text messages don't push in either app yet.
- **Store setup:** `apps/yap/eas.json` mirrors the phone app's (production and preview point at
  `https://api.yapilapi.com` and `https://yapilapi.com`). Yap needs its own `eas init` (EAS project id),
  App Store and Google Play listings, push credentials and `google-services.json`.

Not done yet:

- Signing in once for both apps (a shared keychain group on iOS, account manager on Android); each
  app signs in on its own today.
- Web links opening Yap (associated domains / Android app links for `/yap/*`), and "Open in Yap"
  from YAPILAPI's Yap tab when Yap is installed.
- An archive of chats (the API has none), and pushes for plain text messages.
