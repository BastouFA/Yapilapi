# Publishing the phone app: App Store and Google Play

This is the owner's checklist for getting the YAPILAPI phone app (`apps/mobile`, Expo) into the Apple App Store and Google Play, and for the legal pages both stores ask for. Nothing here has been submitted. No accounts exist yet, and no keys are in the repository.

Order of work:

1. [Before you submit](#1-before-you-submit): lawyer review, contact addresses, blockers in the code.
2. [Accounts](#2-developer-accounts).
3. [Build configuration](#3-build-configuration-eas) (EAS).
4. [Apple App Store](#4-apple-app-store).
5. [Google Play](#5-google-play).
6. [Store answers](#6-store-answers): privacy label, data safety, content rating, review notes.

Store listing text (English and French) is in [store-listing.md](store-listing.md).

How the phone apps sell digital goods (Plus, creator subscriptions, tips, boosts, downloads, tickets to lives) is a decision for you. The options, the fees, the risks and our recommendation are in [in-app-purchases.md](in-app-purchases.md). Whatever you choose is a setting on the API, so no new app build is needed to change it.

## 1. Before you submit

### The legal pages are templates

The web app has these public pages. They need no sign-in and are linked from the landing page footer, sign-in and sign-up, the signed-out bar on shared links, the sidebar, and Settings (Privacy tab) on the web. In the phone app they are linked from sign-up and Settings, and open in the browser.

| Page | Path | Short link |
| --- | --- | --- |
| Index | `/legal` | |
| Terms of service | `/legal/terms` | `/terms` |
| Privacy policy | `/legal/privacy` | `/privacy` |
| Community guidelines | `/legal/guidelines` | `/guidelines` |
| Safety and minors | `/legal/safety` | |
| Creator and seller terms | `/legal/creators` | |
| Copyright and takedowns | `/legal/copyright` | `/copyright`, `/dmca` |
| Cookie notice | `/legal/cookies` | `/cookies` |

**They are templates written from what the code does. They are not legal advice.** The pages were brought up to date with the product on 2026-09-27. For the lawyer, the [legal review pack](../legal/review-pack.md) has:

- the full data inventory and the processors;
- minors, moderation, payments, AI and music;
- where the code and the texts don't match yet;
- a numbered list of open questions.

Every placeholder to fill in is in [placeholders.md](../legal/placeholders.md).

Before launch:

- [ ] Have a lawyer in your main market review every page and adapt it to your company, your countries (for example Nigeria's NDPA, Kenya's Data Protection Act, South Africa's POPIA, the GDPR and UK GDPR if you serve Europe, COPPA and state laws in the United States) and your payment set-up.
- [ ] Replace every `[bracketed note]` in the page source (`apps/web/app/legal/*/page.tsx`). Each one is listed, with what to decide, in [placeholders.md](../legal/placeholders.md). These notes are for decisions only you can make: hosting and other providers, the server region, retention periods, refunds, payout method and timing, fee details, helplines, and the U.S. copyright agent.
- [ ] Set these environment variables on the web service (`render.yaml` lists them). The pages read them on each request, so no rebuild is needed.
  - `LEGAL_ENTITY_NAME`: the company that runs YAPILAPI.
  - `LEGAL_ADDRESS`: its registered address.
  - `LEGAL_JURISDICTION`: whose law governs the terms, written as a phrase, for example "the laws of Nigeria".
  - `SUPPORT_EMAIL`, `PRIVACY_EMAIL`, `COPYRIGHT_EMAIL`, `SAFETY_EMAIL`: addresses that people actually read.
  - Until these are set, the pages show bracketed placeholders.
- [ ] If you serve people in the United States, register a DMCA designated agent with the U.S. Copyright Office (dmca.copyright.gov) and put its details on the copyright page.
- [ ] When the pages change, update `LEGAL_UPDATED` in `packages/shared/src/legal.ts`. That date is the "Last updated" line on every page.
- [ ] Translations. The page text is English only. The page frame (titles, navigation and the "this page is in English" note) is translated into every app language (24). If a lawyer approves translated versions, add them per language.

In development builds, a yellow banner on every legal page says they are templates. It never shows in production builds (`NODE_ENV=production`).

### Fix or accept these before launch

These come from checking the code against the store rules and the privacy policy. Each one is either a store-review risk or a statement the privacy policy has to make.

| Issue | Where | Why it matters |
| --- | --- | --- |
| **Digital products after a seller deletes their account.** Their private files are kept so buyers keep their downloads. | `apps/api/src/lib/media-files.ts` (`collectAccountFiles`) | Decide whether buyers keep access, and say so in the creator terms. |
| **Files uploaded before 2026-09-27 still carry their metadata.** Stripping happens at upload, and nothing rewrites the files stored before then. | `apps/api/src/lib/media-formats.ts` | Only matters if real people uploaded before this change. If they did, run a one-off job that rewrites those originals. |
| **Periods to confirm.** The retention periods are in `RETENTION` (`apps/api/src/lib/retention.ts`) and in section 5 of the privacy policy. Payment records, and reports with their moderation decisions, have no period yet. | `apps/web/app/legal/privacy/page.tsx` | This is a legal decision. Change the code and the policy together. |

#### Closed on 2026-09-28

- **Digital purchases in the phone apps.** Before, Plus, creator subscriptions, tips, boosts, downloads and live tickets all opened the web checkout from the app, which Apple guideline 3.1.1 and Google Play's Payments policy don't allow for digital goods outside the US. Now a server setting decides (`IOS_DIGITAL_PURCHASES`, `ANDROID_DIGITAL_PURCHASES`). By default the apps show no buy buttons or prices for digital goods, only a plain line such as "You can manage Plus on the web", and the API refuses to start a digital checkout from a phone. Physical products, drops of physical products, services and event tickets keep their checkout. The decision memo is [in-app-purchases.md](in-app-purchases.md). Tests: `apps/api/test/store-purchases.test.ts`, `packages/shared/src/store-purchases.test.ts`.

#### Closed on 2026-09-27

Migration 0039. Tests: `apps/api/test/launch-gaps.test.ts`.

- **Reporting in the phone app.** One shared sheet in `apps/mobile/lib/report.tsx`:
  - It asks for a reason, optional details and whether to block the person too, then confirms. It says so if you already reported the thing.
  - It opens from posts, comments, chat messages, stories, communities, audio rooms, lives and their chat lines, events, products, board posts, reels and profiles.
  - The API also takes stories, rooms and lives, and a copyright reason ("Uses my work without permission").
- **Metadata.** Everything is stripped before it is stored, originals included:
  - Photos lose EXIF, GPS, XMP and IPTC, using sharp.
  - Videos and voice notes are remuxed with ffmpeg `-map_metadata -1`.
  - The web MP4, HLS files, editor renders, recaps, clips and live recordings are written without tags.
  - Section 1 of the privacy policy is updated.
- **Email.** SMTP goes through nodemailer (`EMAIL_TRANSPORT=smtp`, `SMTP_URL`). Production refuses to start with `log`.
  - Verification and password reset emails are sent.
  - Security notices go out for password changes, two-step verification, recovery codes, passkeys and phone numbers, and when an account is deleted.
- **Privacy switches.**
  - **Analytics off:** no events are recorded for that person, and past events are unlinked from them.
  - **Personalization off:** For you is ranked the same for everyone. Reels, people suggestions and community discovery ignore interests and follows.
- **Retention.** A daily clean-up (`apps/api/src/lib/retention.ts`) runs once across all instances. It deletes sessions, security events, audit logs, analytics, daily minutes, the AI call log, notifications, phone checks, one-time data, finished jobs, unsent view-once files, deleted content after its grace period (with the files only it used), and raw live recordings. The periods are in the privacy policy.
- **Age gate.**
  - A birth date is required at sign-up on the web and the phone, and under 13 is refused.
  - Existing accounts without a birth date are asked once, and under 13 closes the account.
  - Selling, paid plans, payouts and receiving tips need someone 18 or older. The API enforces this.
- **Fonts.** The web fonts are self-hosted with `next/font` and fetched at build time. Visitors never contact Google.
- **Files on deletion.** Deleting an account removes every size, MP4, HLS folder, caption file, view-once file, live recording (stored and raw), recap video and shared-reel video. A recap's deletion removes its HLS folder.

### Account deletion (Apple guideline 5.1.1(v))

- **Web:** Settings > Privacy > "Delete my account".
- **Phone:** Settings > "Your data" (`apps/mobile/app/your-data.tsx`), which also has "Download my data".
- Both ask for the password and call `DELETE /v1/me`. Deletion is immediate:
  - Removed: profile, posts, reels, stories, comments, messages sent, media files (every size, MP4, HLS segment, caption file, view-once file, live recording and recap video), connections, circles, interests, assistant memory, push tokens and passkeys.
  - The person is signed out everywhere.
  - Payment records, reports and moderation decisions are kept. Security logs are kept for 12 months (daily clean-up, `apps/api/src/lib/retention.ts`). A last email goes to the old address.
  - Backups roll over in 30 days.
- The screen explains all of this before the person confirms.

## 2. Developer accounts

| | Apple Developer Program | Google Play Console |
| --- | --- | --- |
| Sign up | developer.apple.com/programs/enroll | play.google.com/console/signup |
| Cost | 99 USD a year | 25 USD once |
| As a company | Needs a D-U-N-S number (free, takes a few days) | Needs a D-U-N-S number for an organisation account |
| Also needed | Two-factor authentication on the Apple Account, a bank account and tax forms for paid features | Identity verification. New personal accounts must run a closed test with at least 12 testers for 14 days before production; organisation accounts are exempt. |

Also create an **Expo account** (expo.dev), and install the command-line tool: `npm install -g eas-cli`.

## 3. Build configuration (EAS)

The files:

- **`apps/mobile/eas.json`**: three build profiles.
  - `development`: a development client for testing on devices, distributed internally. There is also `development-simulator`.
  - `preview`: an internal build for testers (Android APK, iOS ad hoc).
  - `production`: store builds (Android App Bundle, iOS App Store), with build numbers counted up automatically on EAS (`appVersionSource: remote`).
  - There's also a `submit.production` profile.
- **`apps/mobile/app.config.js`**: reads settings from the environment at build time. A production build stops with a clear error if the API or web address is missing, isn't https, or points at a local machine, if there is no EAS project id, or (Android) if there is no `google-services.json`.
- **`apps/mobile/app.json`**:
  - Bundle ids: `com.yapilapi.app` on both platforms.
  - Version `1.0.0`, iOS `buildNumber` 1 and Android `versionCode` 1. These are the starting values; EAS takes over the counting after that.
  - iOS permission texts and the iOS privacy manifest.
  - The Android permission list.

### One-time setup

```bash
cd apps/mobile
eas login
eas init                      # creates the EAS project; note the project id it prints
eas build:version:set -p ios  # start the remote build numbers at 1
eas build:version:set -p android
```

### Environment variables

The server addresses are in `eas.json`, in each profile's `env`, because they aren't secret and belong with the code:

| Profile | `YAPILAPI_API_URL` | `YAPILAPI_WEB_URL` |
| --- | --- | --- |
| `development` | not set: the app uses `extra.apiUrl` and `extra.webUrl` from `app.json` (this computer), or what you set when starting Metro | |
| `preview`, `production` | `https://yapilapi-api.onrender.com` | `https://yapilapi-web.onrender.com` |

When the services move to your own domain, change both lines in `eas.json` and build again ([deploy-render.md](deploy-render.md#your-own-domain)). Don't also create these two on EAS, so there is one place to look. `YAPILAPI_WS_URL` can name the realtime socket if it ever leaves the API's address; by default it is the API address with `wss://` and `/v1/realtime`.

The rest go on EAS, in the preview and production environments (and development, if you build it):

```bash
eas env:create --environment production --name EAS_PROJECT_ID --value <project id> --visibility plaintext
eas env:create --environment production --name GOOGLE_SERVICES_JSON --type file --value <path to google-services.json> --visibility sensitive
# repeat with --environment preview
```

- The legal pages, checkout and shared links open at `YAPILAPI_WEB_URL`. Its links (posts, reels, profiles, events and the others in `packages/shared/src/app-links.json`) open the app once the web service knows the app's signing details: see [real-device-testing.md](real-device-testing.md#links-that-open-the-app).
- Push notifications need `EAS_PROJECT_ID`, and on Android also `GOOGLE_SERVICES_JSON` (below).

### Keys EAS keeps for you

- **Apple:** distribution certificate and provisioning profile. Let `eas build` create and store them; it asks you to sign in to your Apple Developer account the first time.
- **Push to iPhones:** EAS creates the APNs key during `eas credentials`. Expo's push service then uses it.
- **Android:** EAS creates and keeps the upload keystore on the first build. Download a backup with `eas credentials`. Turn on Play App Signing in the Play Console, which is the default for new apps.
- **Push to Android phones:** needs Firebase Cloud Messaging. Create a Firebase project and add the Android app `com.yapilapi.app`. Download its `google-services.json` (the phone needs it to get a push address) and store it on EAS as the file variable `GOOGLE_SERVICES_JSON` (above); for a local build, put it in `apps/mobile/secrets/`. Then, in Firebase **Project settings > Service accounts**, create a key and upload it with `eas credentials` (Android > Push Notifications: FCM V1), which lets Expo's push service send.
- **Google Play submission:** needs a service account JSON with "Release manager" access in the Play Console. Save it as `apps/mobile/secrets/google-play-service-account.json`. That folder is git-ignored; never commit it. Or upload it to EAS with `eas credentials`.

### Build and submit

```bash
cd apps/mobile
eas build --profile preview --platform all             # testers and your own phones: docs/operations/real-device-testing.md
eas build --profile production --platform ios
eas build --profile production --platform android
eas submit --profile production --platform ios --latest      # asks for your Apple ID, or set submit.production.ios.ascAppId in eas.json
eas submit --profile production --platform android --latest  # goes to the internal testing track as a draft
```

### Monorepo note

EAS uploads the whole repository but installs only `apps/mobile` (npm, `package-lock.json`). The app imports source from `packages/shared` and `packages/api-client`. That code needs `zod`, which currently resolves to the copy Expo already installs in `apps/mobile/node_modules`.

If a cloud build fails to bundle because of a missing module under `packages/`, add this script to `apps/mobile/package.json` and build again:

```json
"eas-build-post-install": "cd ../.. && corepack enable && pnpm install --frozen-lockfile --filter @yapilapi/shared --filter @yapilapi/api-client"
```

The app has only been type-checked and bundled locally (`npx expo export`). The first EAS build is also the first real native build, so budget time for native issues. `react-native-webrtc` and `react-native-incall-manager` run through the interop layer on the New Architecture (see `apps/mobile/README.md`).

### iOS privacy manifest (required-reason APIs)

`app.json` declares `ios.privacyManifests`, which Expo writes into `PrivacyInfo.xcprivacy`:

- `NSPrivacyTracking`: `false`. There is no tracking, no advertising identifier and no App Tracking Transparency prompt.
- Required-reason APIs used by React Native, Expo modules and `expo-secure-store` / `expo-file-system`:
  - `UserDefaults`: `CA92.1`.
  - `FileTimestamp`: `C617.1`, `0A2A.1`, `3B52.1`.
  - `SystemBootTime`: `35F9.1`.
  - `DiskSpace`: `E174.1`, `85F4.1`.

The app itself calls none of these directly; they come from its libraries. After the first build, run Xcode's **Product > Generate Privacy Report** on the archive and add anything it lists that is missing. Third-party pods ship their own manifests. The data-collection part of the privacy label is filled in App Store Connect ([section 6](#6-store-answers)), not in this file.

### Export compliance

The app uses HTTPS (the system's own encryption) and WebRTC calls, which are encrypted with DTLS-SRTP by the bundled WebRTC library. Both use standard encryption, which usually qualifies for the mass-market exemption. App Store Connect asks about encryption on every build. Once you or your lawyer have confirmed the answer, you can add `"ITSAppUsesNonExemptEncryption": false` to `ios.infoPlist` in `app.json` to stop the question. It is deliberately not set.

### Android permissions

**Declared:** `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `ACCESS_NETWORK_STATE`, `BLUETOOTH_CONNECT` (headsets in calls), `WAKE_LOCK` (calls) and `READ_CONTACTS` (find friends, only when asked). Expo adds `INTERNET`, and notification permissions (`POST_NOTIFICATIONS`, `VIBRATE`, `RECEIVE_BOOT_COMPLETED`).

**Blocked:** `WRITE_CONTACTS`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` and `ACCESS_BACKGROUND_LOCATION`. `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` are requested only when someone taps "Share where I am" in a chat or "Nearby" in Market, and are used only while the app is open (expo-location, no background location).

- The app picks photos with the system photo picker, which needs no permission.
- Blocking the media permissions keeps you out of Google Play's photo and video permissions declaration.

After the first build, check the final list: `bundletool dump manifest --bundle app.aab | grep uses-permission`. Remove anything unexpected with `blockedPermissions`.

## 4. Apple App Store

1. **Create the app** in App Store Connect (My Apps > +):
   - name "YAPILAPI"; if the name is taken, use the subtitle to differentiate, or "YAPILAPI: social";
   - bundle id `com.yapilapi.app`;
   - SKU `yapilapi-ios`;
   - primary language English (U.K. or U.S.).
2. **App information:**
   - category Social Networking;
   - secondary category Photo & Video or Lifestyle;
   - content rights: "Contains third-party content": yes (people's posts, licensed music).
3. **Age rating questionnaire** (answers below). The result should be 13+ under Apple's age rating system.
4. **App Privacy:**
   - privacy policy URL `https://<your site>/legal/privacy`;
   - data types as listed in [section 6](#6-store-answers).
5. **Pricing and availability:** free. Choose countries. Start with those your lawyer reviewed.
6. **Version page:**
   - screenshots (below), description, keywords, support URL and marketing URL (from store-listing.md);
   - copyright line: "2026 <legal entity>";
   - review notes and the demo account (below).
7. **TestFlight:**
   - After `eas submit`, the build appears under TestFlight after processing (about 15 to 30 minutes).
   - **Internal testers** are up to 100 people on your team, with no review.
   - **External testers** are up to 10,000 people and need a short Beta App Review. Fill in "What to test" and the same demo account.
8. **Submit for review** from the version page. Typical review time is one to two days.

### Screenshots

Upload PNG or JPEG files with no transparency.

| Device | Size (portrait) | Required |
| --- | --- | --- |
| iPhone 6.9" (16 Pro Max, 15 Pro Max) | 1320 × 2868 (or 1290 × 2796) | Yes: 3 to 10 |
| iPhone 6.5" | 1284 × 2778 (or 1242 × 2688) | Only if you don't give 6.9" |
| iPad 13" | 2064 × 2752 (or 2048 × 2732) | Yes, because `supportsTablet` is true |

Suggested set (the same for Google Play):

1. The Yap recorder: holding the big button, the live waveform and the countdown.
2. Pulse on Yaps, with a transcript open and "Listen in …".
3. Pulse, with stories on top.
4. Wander.
5. A chat in Chats with a voice message.
6. A profile with its voice intro and Chapters.
7. A Squad.
8. Settings > Data saver.

Use the seeded demo data and a clean status bar (in the Simulator: `xcrun simctl status_bar booted override --time 9:41`).

If you'd rather not design iPad layouts yet, set `supportsTablet` to false in `app.json` before the first submission. The app then runs in iPhone mode on iPads and you don't need iPad screenshots.

## 5. Google Play

1. **Create the app** (All apps > Create app):
   - name "YAPILAPI", default language English, App, Free;
   - accept the declarations. You do this in the Console; nothing in this repo accepts them for you.
2. **Set up your app** (Dashboard). Each item has its answer in [section 6](#6-store-answers):
   - privacy policy URL;
   - app access (demo account);
   - ads: "No, my app does not contain ads" is **wrong**. Sponsored posts exist, so answer **Yes**;
   - content rating (IARC questionnaire);
   - target audience: 13 and over. Don't include under 13;
   - news app: No;
   - data safety;
   - government app: No;
   - financial features: none of the listed ones;
   - health: No.
3. **Store listing:**
   - short description (80 characters) and full description (4,000), from store-listing.md;
   - app icon 512 × 512 PNG;
   - feature graphic 1024 × 500;
   - phone screenshots: 2 to 8, 1080 × 1920 or larger (16:9 or 9:16, each side 320 to 3840 px);
   - 7" and 10" tablet screenshots: optional, but needed to be featured on tablets.
4. **Testing:**
   - **Internal testing** is up to 100 testers, available in minutes. `eas submit` puts builds here as a draft; roll it out from the Console.
   - **Closed testing** is needed for 14 days with 12 or more testers if the developer account is a new personal account.
   - Then promote to **Production**, with a staged rollout starting at 10 to 20%.
5. **Release:** Production > Create release > choose the build from the testing track > release notes (store-listing.md) > review. First reviews can take up to 7 days.

## 6. Store answers

These answers come from the code as it is today (see "Privacy inventory" below). If you change what the app collects, change them too, along with the privacy policy.

### Review notes and demo account (both stores)

Create a demo account on the production server before submitting. Don't reuse a real person's account.

- Sign up on the web with an address you control, for example `review@<your domain>`, and a strong password.
- Confirm its email. Give it a birth date over 18. Follow a few seeded accounts so Pulse isn't empty.
- Put the email and password only in App Store Connect (App Review Information > Sign-in required) and Play Console (App access). Never put them in the repository.

Review notes to paste. Replace the placeholders.

> YAPILAPI is a social app you speak: voice posts called Yaps (the button in the middle records one; holding it offers posts, reels, stories and live), the feed (Pulse), discovery (Wander), chats and calls (Chats), and your profile (You). Every Yap is transcribed and its words go through the same checks as written posts.
> Demo account: see the sign-in fields. It is an adult account with sample content.
> User-generated content safeguards:
> Report: the "..." menu on reels and profiles (Report), and on the web on posts, messages and profiles. Reports open a moderation case reviewed by our team in the admin console (/admin on the web).
> Block: profile menu > Block. Blocked people can't see or contact you; manage them in Settings > Blocked accounts.
> Hidden words: Settings. Mute: "Show less" and "Mute this person" on posts.
> Community guidelines: https://<site>/legal/guidelines (linked from sign-up and Settings).
> Account deletion: Settings > Your data > Delete account (asks for the password; deletion is immediate).
> Minimum age 13. Under-18 accounts are private and can only be messaged by friends.
> Calls need the microphone (and camera for video). Contacts are only read when you tap "Find friends", and only coded email addresses leave the phone.
> Purchases: [match what `IOS_DIGITAL_PURCHASES` is set to; see in-app-purchases.md. With the default (hidden): "Plus, creator subscriptions, tips, boosts, digital downloads and tickets to live streams are not sold in the iOS app; the app shows no prices or links for them. Physical products, in-person event tickets and real-world services are paid with Stripe or Paystack under 3.1.3(e)."].

### Content rating (Apple age rating and Google's IARC questionnaire)

| Question (short) | Answer | Why |
| --- | --- | --- |
| User-generated content / users can interact | Yes | Posts, comments, chats, calls, live, rooms |
| Users can share their location | Yes | In a chat, for 15 minutes to 8 hours or once, only when they choose; precise or about 1 km; stops when they stop or leave the chat |
| Unrestricted web access | No | Links open in the system browser |
| Digital purchases | Depends on the setting | Plus, subscriptions, tips, boosts, digital downloads, live tickets. Not offered in the app with the default setting (see [in-app-purchases.md](in-app-purchases.md)) |
| Gambling, simulated gambling | No | |
| Violence, sexual content, profanity, drugs, horror (made by you) | None | Only what users post, which the guidelines limit |
| Mature or suggestive themes (Apple): Infrequent or mild | Choose "Infrequent/Mild" for user-generated content | Apple wants UGC apps to reflect what users could see |
| Medical or treatment information | No | |
| Contests | No | |
| Messaging with people you don't know | Yes, with limits | Adults can't message minors unless they are friends |

**Expected result:** 13+ on the App Store, Teen or PEGI 12 / USK 12 on Google Play. Set **target age 13+** in Play's target audience section, and don't claim the app is designed for children.

### Apple privacy label (App Privacy)

**Tracking:** No. Nothing is shared with data brokers or used for advertising on other companies' apps.

For every type below, check "Linked to the user". "Used for tracking" is No for all of them.

| Data type | Collected | Purposes |
| --- | --- | --- |
| Contact info: Name | Yes | App functionality |
| Contact info: Email address | Yes | App functionality, account management (also sent to Paystack at checkout) |
| Contact info: Phone number | Yes (optional) | App functionality (verification) |
| Contacts | Yes (optional, coded email addresses, not kept) | App functionality |
| User content: Photos or videos | Yes | App functionality |
| User content: Audio data | Yes (voice messages, videos) | App functionality |
| User content: Emails or text messages (chats) | Yes | App functionality |
| User content: Other (posts, comments, stories) | Yes | App functionality |
| User content: Customer support | Yes, if they write to you | App functionality |
| Identifiers: User ID | Yes | App functionality |
| Identifiers: Device ID | No (push tokens aren't a device ID in Apple's sense; answer No unless your lawyer says otherwise) | |
| Purchases: Purchase history | Yes | App functionality |
| Financial info: Payment info | No (card details go to Stripe or Paystack directly) | |
| Location: Coarse location | Yes (country from the network, not GPS) | App functionality, Developer's advertising or marketing (sponsored posts are first-party) |
| Usage data: Product interaction | Yes | Analytics, product personalisation, app functionality |
| Usage data: Advertising data | Yes (sponsored post impressions and clicks) | Developer's advertising or marketing |
| Diagnostics | No (no crash reporter is installed) | |
| Other data: Date of birth | Yes (optional) | App functionality (age protections) |
| Sensitive info | No | |
| Browsing history, search history | Search history is kept only on the phone (recent searches), so No | |

### Google Play data safety form

- **Does your app collect or share any of the required user data types?** Yes.
- **Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS).
- **Do you provide a way for users to request that their data is deleted?** Yes. In the app (Settings > Your data > Delete account), and on the web for people without the app: `https://<site>/settings`, or email `PRIVACY_EMAIL`. Play asks for a deletion URL that works without the app: give `https://<site>/legal/privacy#your-rights`, which explains how to delete in the app and on the web and gives the privacy email.

"Shared" means sent to a third party that is not your service provider. Service providers acting for you (Stripe, Paystack, Twilio, AWS, Anthropic, Expo) count as **not shared** under Google's definitions.

| Category / type | Collected | Shared | Optional? | Purposes |
| --- | --- | --- | --- | --- |
| Personal info: Name | Yes | No | Required | App functionality, Account management |
| Personal info: Email address | Yes | No | Required | App functionality, Account management, Communications |
| Personal info: User IDs | Yes | No | Required | App functionality, Account management |
| Personal info: Phone number | Yes | No | Optional | Account management (verification) |
| Personal info: Other info (date of birth) | Yes | No | Optional | App functionality (age protections), Fraud prevention |
| Financial info: Purchase history | Yes | No | Optional | App functionality |
| Financial info: Payment info | No (handled by Stripe or Paystack) | | | |
| Location: Approximate location | Yes (country from the network) | No | Required | App functionality, Advertising or marketing |
| Messages: Other in-app messages | Yes | No | Optional | App functionality |
| Photos and videos | Yes | No | Optional | App functionality |
| Audio: Voice or sound recordings | Yes | No | Optional | App functionality |
| Contacts | Yes (coded emails, processed once, not stored) | No | Optional | App functionality |
| App activity: App interactions | Yes | No | Required | Analytics, App functionality, Personalization |
| App activity: In-app search history | No (kept on the phone) | | | |
| App activity: Other user-generated content | Yes | No | Optional | App functionality |
| App info and performance: Crash logs, Diagnostics | No | | | |
| Device or other IDs | Yes (push token) | No | Optional | App functionality (notifications) |

Answer "Processed ephemerally" only for Contacts.

### User-generated content requirements

Both stores require the following. Here is where each one is today.

| Requirement | Where | Status |
| --- | --- | --- |
| Terms users must accept, with zero tolerance for objectionable content | `/legal/terms`, `/legal/guidelines`. Sign-up says continuing means accepting them (web `apps/web/app/(auth)/signup/page.tsx`, phone `apps/mobile/app/signup.tsx`) | Done |
| A way to report content and users | API `POST /v1/reports` (`apps/api/src/modules/safety.ts`). Web: `ReportSheet` in `apps/web/components/PostList.tsx`, reels, messages, profiles. Phone: one sheet (`lib/report.tsx`) from posts, comments, messages, stories, communities, rooms, lives, events, products, reels and profiles | Done |
| A way to block abusive users | API `POST /v1/users/:id/block`. Web profile menu, Settings. Phone: `lib/profile-menu.tsx`, and Settings > Blocked accounts | Done |
| Timely moderation (Apple asks for action within 24 hours) | Moderation queue and cases in `/admin` (`apps/web/app/(app)/admin/page.tsx`), appeals, automated checks (`apps/api/src/lib/moderation.ts`), and photo and video checks (`apps/api/src/lib/media-moderation.ts`, AWS Rekognition when configured) | Staff the queue. Turn on Rekognition (`MEDIA_MODERATION_PROVIDER=rekognition`) before opening sign-ups. |
| Contact information for users | Legal pages, via the `*_EMAIL` settings | Set the addresses |
| Filtering | Hidden words, mute, "Show less", sensitive media blurred and hidden from minors | Done |

## Privacy inventory (what the code collects)

This is the basis for the privacy policy and the two forms above. It was checked against the code on 2026-09-27.

The fuller, table-by-table inventory, with retention periods and processors, is in the [legal review pack](../legal/review-pack.md#4-data-inventory).

- **Account:**
  - email, scrypt password hash, username, display name;
  - birth date (required; under 13 refused), locale and optional invite code;
  - optional phone number, verified through Twilio Verify (`phone_verifications` keeps the number, IP and time).
- **Profile and content:**
  - profile, posts, reels, stories, comments, chats (not end-to-end encrypted; edit history kept), voice messages, media, boards, chapters, recaps, events, communities, rooms and products;
  - live videos are recorded when `LIVE_RECORDINGS_DIR` is set.
- **Sessions and security:**
  - IP address and user agent per session and security event;
  - a failed sign-in keeps the email address that was typed.
- **Usage:**
  - `analytics_events` (event name and properties, no IP; none when Analytics is off; deleted after 13 months);
  - post and story views, reel resume position, feed feedback, ad events;
  - daily minutes (`usage_days`).
- **Country:** from the CDN header, used for regional rules and ads. The app never asks for GPS location.
- **Location shared in chats, and Market nearby:** asked for only when someone taps "Share where I am" or "Nearby", on web and phone. Phone permissions are foreground only (`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`; iOS `NSLocationWhenInUseUsageDescription`, never "Always"). A live share keeps only its latest point, deleted when it ends; Market sends the position snapped to about 1 km and keeps nothing. Privacy label and data safety form: add "Precise location" (App functionality, linked to the person, not used for tracking).
- **Push:** Expo push tokens and web push endpoints.
- **Contacts:** SHA-256 of salted email addresses, computed on the device. Only email is matched, and the hashes aren't stored.
- **Payments:**
  - through Stripe (Elements) and Paystack (hosted, receives the email address);
  - orders, payments and webhook payloads are stored; card numbers never are.
- **AI:**
  - Anthropic Claude receives the prompts listed in the privacy policy;
  - `ai_tool_calls` logs metadata without content;
  - translations are cached.
- **Media moderation:** AWS Rekognition (optional).
- **Third parties the device talks to directly:** Jamendo (music audio), Google STUN, Stripe.js (web checkout), Expo, APNs and FCM.
- **No third-party analytics, crash reporting, ad SDK or tracking.**
- **Data download** (`GET /v1/me/export`, Settings > Your data, 3 an hour): every kind of data above that is about the person, as grouped JSON with a guide at the top (`apps/api/src/lib/data-export.ts`). Other people appear by username only; messages are the person's own. No tokens, hashes, two-step secrets, passkey keys, stream keys, webhook secrets, push endpoints, storage keys or payment provider references. Files are listed by address while they can still be opened. Views, ads seen and analytics are counted per day or per event, and long lists are capped (the limits are in the file and in `docs/product/status.md`). Automated risk flags are counted, not described; the audit log shows the person's own actions without IP address or details; reports about them show as decisions, never who reported.
