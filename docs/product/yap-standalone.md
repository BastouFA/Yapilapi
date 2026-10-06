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

## Step 2: a separate Yap phone app (later)

When Yap has enough people who use it on its own, build `apps/yap`, a second Expo app:

- It reuses what the phone app's chats already use: `@yapilapi/api-client`, `@yapilapi/shared`
  (messages in eight languages, games, chat themes) and the chat screens in `apps/mobile`
  (`app/chat/[id].tsx` and `lib/`), moved into a shared package so both apps import them.
- Same API and same accounts. Signing in once can cover both apps through a shared keychain
  group (iOS) and account manager (Android).
- Its own bundle ID (for example `com.yapilapi.yap`), App Store and Google Play listings, and push
  notification channel. Your Apple developer membership covers a second app, and Google Play
  needs no new fee.
- The main app's Yap tab can then offer "Open in Yap" when Yap is installed, as Facebook does
  with Messenger.
