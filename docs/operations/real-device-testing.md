# Testing the phone app on real phones

The simulator proves screens and flows. It can't prove push notifications, calls between two
phones, the microphone and cameras, location, links opening the app, or how the app behaves on
mobile data. This page gets the app onto your own iPhone and Android phone, pointed at the
production servers on Render, and lists what to check there.

1. [Before you start](#1-before-you-start)
2. [Getting the app on your phones](#2-getting-the-app-on-your-phones)
3. [Links that open the app](#3-links-that-open-the-app)
4. [The checklist](#4-the-checklist)

## 1. Before you start

- **The servers are up.** Steps 1 to 8 of [deploy-render.md](deploy-render.md#go-live-checklist)
  are done: `https://yapilapi-api.onrender.com/health/ready` shows `"status":"ready"` and you can
  sign in on `https://yapilapi-web.onrender.com`.
- **Two phones and two accounts.** Calls, messages and notifications need someone on the other
  end. An iPhone and an Android phone is best: it tests both at once. Sign up a second account on
  the web for the second phone (any email address you can read).
- **A SIM with mobile data** in at least one phone, for the calls and Data saver checks.
- **Where the app points.** Builds from the `preview` and `production` profiles in
  `apps/mobile/eas.json` talk to `https://yapilapi-api.onrender.com` and open web pages at
  `https://yapilapi-web.onrender.com`. Requests, uploads, photos and videos, the realtime socket
  (`wss://yapilapi-api.onrender.com/v1/realtime`), shared links, checkout and the legal pages all
  follow those two settings (`apps/mobile/lib/api.ts`). If Render gave the services other names, or
  when you move to your own domain, change the two lines in `eas.json` and build again.

## 2. Getting the app on your phones

Pick one way per phone. Option A is the one to use: it builds in the cloud, needs nothing on your
computer beyond the command line tool, and is the same kind of build testers will get.

| | Option A: preview build (EAS) | Option B: over USB from your Mac |
| --- | --- | --- |
| iPhone | Expo account and Apple Developer Program membership | Xcode and Apple Developer Program membership |
| Android | Expo account | Android Studio, or only its command line tools |
| Push notifications | yes, once set up below | yes, with the same setup |
| Links open the app | yes | iPhone yes; Android only if you add your computer's key (below) |

A free Apple ID is not enough for an iPhone build either way: the app uses push notifications and
associated domains, which only a paid membership can sign. Android needs no Google account until
you publish to Play.

### Option A: preview build with EAS

One time, on your computer:

```bash
npm install -g eas-cli
cd apps/mobile
eas login                      # your Expo account
eas init                       # creates the EAS project and prints its id
eas env:create --environment preview --name EAS_PROJECT_ID --value <the project id> --visibility plaintext
```

Push on Android needs Firebase (it is free). In the Firebase console, create a project, add an
Android app with the package name `com.yapilapi.app`, and download `google-services.json`. Then:

```bash
eas env:create --environment preview --name GOOGLE_SERVICES_JSON --type file --value <path to google-services.json> --visibility sensitive
```

In Firebase, **Project settings > Service accounts > Generate new private key** gives a JSON key.
Upload it with `eas credentials --platform android`: choose the preview profile, then
**Google Service Account > Manage your Google Service Account Key for Push Notifications (FCM V1)**.

**iPhone.** Ad hoc builds only install on phones registered in advance:

```bash
eas device:create              # choose "Website", open the link it prints on the iPhone, and install the profile it offers
eas build --profile preview --platform ios
```

The first build asks you to sign in to your Apple Developer account, then makes the certificate and
the provisioning profile. Say yes when it offers to set up push notifications (it makes the APNs key).
When the build finishes, open the link it prints (or the QR code on expo.dev) on the iPhone and
install. The first time, iOS asks you to turn on **Settings > Privacy & Security > Developer Mode**
and restart; do it, then open the app. To add another iPhone later, run `eas device:create` again and
build again (the build asks to include the new phone).

**Android.**

```bash
eas build --profile preview --platform android
```

Open the link or QR code on the phone, download the APK and open it. Android asks to allow installs
from your browser or file manager once; allow it.

**Updating.** Run the build again and install over the old app; you stay signed in. A change to
JavaScript only still needs a new build: there are no over-the-air updates in this app.

### Option B: over USB from your Mac

From a checkout of the repository with `npm install` done in `apps/mobile`. The native folders
(`apps/mobile/ios`, `apps/mobile/android`) are generated from the app's settings and are not in
git, so regenerate them whenever the addresses change.

```bash
cd apps/mobile
export YAPILAPI_API_URL=https://yapilapi-api.onrender.com
export YAPILAPI_WEB_URL=https://yapilapi-web.onrender.com
export EAS_PROJECT_ID=<the project id from eas init>   # without it the app works but can't get push
```

**iPhone**, with the cable plugged in and the iPhone unlocked (tap **Trust** on the phone):

```bash
npx expo prebuild --clean --platform ios
npx expo run:ios --device --configuration Release
```

Pick your iPhone from the list. If it stops at signing, open `apps/mobile/ios/YAPILAPI.xcworkspace`
in Xcode, select the YAPILAPI target, open **Signing & Capabilities**, tick **Automatically manage
signing**, choose your team, and run the command again. Turn on Developer Mode on the iPhone if asked.
`Release` puts the app's code inside the build, so it runs without your computer afterwards.

**Android**, with **Developer options > USB debugging** on (tap **Settings > About phone > Build
number** seven times to show Developer options) and `google-services.json` copied to
`apps/mobile/secrets/` for push:

```bash
npx expo prebuild --clean --platform android
npx expo run:android --variant release
```

This build is signed with your computer's own key, so the site's links open in the browser rather
than the app unless you add that key's fingerprint to `ANDROID_CERT_SHA256` (below; `cd android &&
./gradlew signingReport` prints it under `Variant: release`).

## 3. Links that open the app

A link to the site (a shared post, reel, profile, story, event, drop, listing, live, board, room,
place, tag, Watch together session, Together invite or friend invite) opens the app when it is
installed, and the browser when it isn't. The list is in `packages/shared/src/app-links.json`.
Everything else stays in the browser: sign-in, password resets and email confirmation, settings,
the legal pages and checkout. Pages the app opens on purpose (checkout, Studio, buying a ticket to a
live) go through `/web/<page>`, which no app link covers, so they don't bounce back into the app.

The phone builds already name the web address (iOS associated domains, an Android App Links intent
filter). What's missing is the web side: each phone system downloads a file from the site to check
the app really belongs to it, and the files need two values only you can get.

1. **Apple team id.** In the Apple Developer site, **Account > Membership details > Team ID** (ten
   letters and digits).
2. **Android signing fingerprints**, SHA-256, as many as you use, separated by commas:
   - the EAS key, for preview builds: `eas credentials --platform android`, pick the profile, and
     copy **SHA256 Fingerprint**;
   - the Play app signing key, once the app is on Play: **Play Console > your app > Test and release
     > App integrity > App signing**, the SHA-256 certificate fingerprint;
   - your computer's key, only if you use option B on Android.
3. On Render, **yapilapi-web > Environment**: set `APPLE_TEAM_ID` and `ANDROID_CERT_SHA256`, then
   **Save and deploy** (no rebuild is needed; they are read when the files are requested).
4. Check both files open as JSON:
   - `https://yapilapi-web.onrender.com/.well-known/apple-app-site-association`
   - `https://yapilapi-web.onrender.com/.well-known/assetlinks.json`

   Until a value is set, its file answers "Not set up yet" (404) and links open in the browser.
5. Phones check when the app is installed, so **reinstall the app** afterwards. Apple reads the file
   through its own cache, which can take a few hours to catch up:
   `https://app-site-association.cdn-apple.com/a/v1/yapilapi-web.onrender.com` shows what iPhones
   see. On Android, **Settings > Apps > YAPILAPI > Open by default** should list the site as a
   verified link.

When you move to your own domain, set the new web address in `eas.json` and build again: the domain
is written into the build.

## 4. The checklist

Go through it on both phones. Each item says what to do, what should happen, and what to send back
if it doesn't. With every report, send:

- the phone model and its system version (iOS 18.1, Android 15);
- the app version, from **Settings > Help and legal** in the app (at the bottom);
- the time it happened, to the minute, so it can be found in the Render logs;
- a screenshot or a screen recording, when you can (both phones can record the screen from their
  quick settings).

### Signing in

1. **Sign in on each phone.**
   - Do: open the app, sign in with your account on one phone and the second account on the other.
   - Should: Pulse loads, and your profile shows your posts. Nothing mentions `localhost`.
   - If not: the message on screen, and whether `https://yapilapi-web.onrender.com` works in the
     phone's browser at the same moment.

### Push notifications

2. **Allow notifications.**
   - Do: in the app, **Settings > Notifications**, tap **Turn on notifications** and allow. On Android 13 and later the
     system asks; earlier versions allow them by default.
   - Should: "Notifications are on." On Android, **Settings > Apps > YAPILAPI > Notifications** shows
     two categories, Default and Calls.
   - If not: the exact message. "Notifications need a real phone and an EAS project" means the build
     has no `EAS_PROJECT_ID`; say which build you installed.
3. **App open.**
   - Do: with the app open on phone A, send it a message from phone B (not in that chat), and like
     one of its posts.
   - Should: a banner appears at the top within a few seconds, without a sound. Tapping it opens the
     chat or the post.
   - If not: whether the message showed up in the app anyway (realtime works but push doesn't), and
     the time.
4. **App in the background, and closed.**
   - Do: press the home button on phone A and send another message. Then close the app completely
     (swipe it away in the app switcher) and send one more.
   - Should: a notification on the lock screen both times. Tapping it opens the app at that chat,
     even from closed.
   - If not: which of the two failed, the time, and whether the phone was in Focus or Do Not
     Disturb mode (those hold notifications back on purpose).
5. **Quiet hours.**
   - Do: in the app, **Settings > Notifications > Quiet hours**, turn on **Use quiet hours every
     day** with a window that covers the next 30 minutes. From phone B, like a post of phone A's.
   - Should: no notification on phone A, but the like is in the app's notifications list. Once the
     window ends, notifications come through again.
   - If not: the times you set, the time zone the screen shows, and when the like was sent.
6. **Notifications turned off in the phone's settings.**
   - Do: turn notifications off for YAPILAPI in the phone's settings, then open **Settings >
     Notifications** in the app.
   - Should: "Notifications are blocked in Settings." Nothing arrives until you turn them back on.
   - If not: what that screen shows.

### Calls

7. **Audio call on Wi-Fi.**
   - Do: both phones on Wi-Fi. From a chat on phone A, start an audio call; answer on phone B. Talk
     for a minute, try mute, and switch between earpiece and speaker.
   - Should: phone B rings (ringtone, or vibration when the ringtone isn't available) and shows the
     call screen. Both hear each other within a couple of seconds of answering. Mute silences you
     only; the call starts on the earpiece.
   - If not: who called whom, how far it got (ringing, "Connecting…", connected without sound), and
     whether the microphone prompt appeared.
8. **Video call.**
   - Do: start a video call. Switch camera, turn the camera off and on, lock the screen of one phone
     for ten seconds and unlock.
   - Should: both see each other; switching and the camera button work; a video call starts on the
     speaker; the call is still going after the lock (audio carries on in the background).
   - If not: which control failed, and on which phone.
9. **Call with the app closed.**
   - Do: close the app on phone B completely, lock it, and call it from phone A.
   - Should: a notification with **Answer** and **Decline**. Either one opens the app. It rings as a
     notification, not like a phone call on the lock screen; that needs CallKit, which the app
     doesn't have yet.
   - If not: whether anything appeared, and the time.
10. **Call on mobile data.**
    - Do: turn Wi-Fi off on phone A so it uses mobile data, keep phone B on Wi-Fi, and call. Then
      both on mobile data, on different carriers if you can.
    - Should, with the calls relay (TURN) running: it connects as on Wi-Fi, perhaps a second slower.
    - Without the relay (a plain Render deploy has none): many mobile networks don't allow a direct
      connection between two phones. The call rings and can be answered, then stays on
      "Connecting…" and ends with "The connection dropped. Try calling again." Some networks still
      connect directly, so it can work for you and fail for someone else. The fix is the relay:
      [Live video and the calls relay](deploy-render.md#live-video-and-the-calls-relay).
    - If not: both carriers, which phone was on what, whether `TURN_URLS` is set on yapilapi-api,
      and how far the call got.

### Microphone and cameras

For each of these, the first time try **Don't Allow**, then allow it in the phone's settings and try
again. The app should explain what's missing and never get stuck.

11. **Voice messages.**
    - Do: in a chat, tap **Record a voice message**. Deny the microphone. Then in the phone's settings
      allow the microphone for YAPILAPI, come back and record ten seconds. Also try a recording under
      a second, and play one with the iPhone's silent switch on.
    - Should: denied, it says "To record voice messages, allow microphone access in your phone
      settings." Allowed, the timer runs and the message sends; the other phone plays it. A very short
      one says "That recording was too short to send." Playback is heard with the silent switch on.
    - If not: the step that failed and what the screen said.
12. **Yaps.**
    - Do: in a chat with a friend, hold **Hold to Yap**, speak, release. Then lock the receiving
      phone, unlock, and send another.
    - Should: "Release to send" with a timer while holding; the Yap arrives in the chat. If the two of
      you are friends it plays out loud by itself on the other phone while the app is open; it never
      plays by itself in the background, in focus mode or in quiet hours.
    - If not: what the receiving phone did (nothing, played twice, played while locked).
13. **Audio posts.**
    - Do: in Create (the Spark button), record an audio post, listen back and post it. Play it from
      the other phone.
    - Should: recording starts after the microphone is allowed, stops at the time limit, and the post
      plays for others. Its transcript shows once the server has made it (if captions are set up).
    - If not: the step and the message.
14. **Real.**
    - Do: from Create, choose Real. Deny the camera once, then allow it. Capture.
    - Should: denied, it says "Real uses your camera to capture this moment." with **Allow camera**.
      Allowed, it takes the back photo and then the front one, and shares.
    - If not: which camera failed, and whether the preview was black.
15. **Camera and videos.**
    - Do: tap Spark to open the camera. Take a photo; hold the shutter to record a short video (allow
      the microphone when asked); switch to Reel and record. Deny the microphone once.
    - Should: the photo and video appear in the editor and post. Denied, the camera explains the
      microphone is needed for sound. Videos play back with sound for others after processing.
    - If not: what failed, and the video's length.
16. **Photo picker.**
    - Do: in Create, choose from the library. On iPhone, the first time pick **Limit Access** and
      choose two photos; then try **Allow Full Access**. On Android, the system photo picker opens.
    - Should: only what you chose is offered with limited access; the chosen photos upload and post.
      Saving a photo from the app asks only to add to the library.
    - If not: what the picker showed and which option you picked.

### Location

17. **Share where you are.**
    - Do: in a chat, share your location. Deny once, then allow **While Using the App**. Also open
      Market and look at what's near you.
    - Should: the app only ever asks for "while using" (never "always"). Denied, Market says
      "Location is off for YAPILAPI. Allow it in your phone's settings to see what's near you." Allowed,
      the chat shows the shared spot and the other phone sees it.
    - If not: what was asked, and what the chat showed.

### Sound in the background

18. **Leaving the app stops what's playing.**
    - Do: play an audio post, then press the home button. Do the same with a video and with a Yap.
      Then join an audio call and press the home button.
    - Should: the audio post, the video and the Yap stop when you leave the app (Yaps also drop what
      was queued). A call keeps going. Nothing from YAPILAPI keeps playing on the lock screen
      otherwise.
    - If not: which one kept playing, and for how long.

### Links

19. **A shared link opens the app.** Do section 3 first.
    - Do: share a post from the app to yourself by email (or the Notes app). On each phone, tap the
      link in the Mail app. Then try a profile link (`https://yapilapi-web.onrender.com/u/<name>`), a
      reel, and an event. Also try `yapilapi://p/<post id>` from Notes.
    - Should: each opens the app at that post, profile, reel or event, without the browser. Typing a
      link into the browser's address bar opens the web page; that's how iPhones work. Gmail opens
      links in its own browser unless you change that in its settings; long-press the link and choose
      **Open in YAPILAPI** to test there.
    - If not: which link, which mail app, and whether the two `.well-known` addresses in section 3
      show JSON. On iPhone, if a link once opened in Safari, the small `yapilapi-web.onrender.com`
      button at the top right of Safari sends it back to the app next time.
20. **Pages that must stay in the browser.**
    - Do: from the app, open the legal pages (**Settings > Help and legal**), and a checkout: subscribe to a creator or tip
      from a post, if your purchase settings show those (item 23), or buy a drop.
    - Should: these open in the browser and stay there, even though the app also opens profile links.
      After paying (Stripe test card `4242 4242 4242 4242`, any future date, any CVC), going back to
      the app shows the result.
    - If not: the address the browser showed, and whether it jumped back into the app.
21. **Emails.**
    - Do: on the phone, ask for a password reset and tap the link in the email.
    - Should: it opens in the browser (that page isn't in the app); after resetting, sign in in the
      app with the new password.
    - If not: what opened, and the address.

### Mini Apps

22. **A Mini App in the app.** This needs at least one approved Mini App on the production site
    (the Developers page on the web).
    - Do: in a chat, a community or an event, open Mini Apps, add one and open it. Tap a link inside
      it that goes to another site. If it asks to send something as you, try **Don't send** once.
    - Should: it opens full screen with its name, and says when it comes from another developer.
      Links to other sites open in the browser, not inside the Mini App. Nothing is sent as you
      without your choice.
    - If not: the Mini App's name, a screenshot, and what it was doing.

### Purchases

23. **What the store rules show.** There is no App Store or Google Play billing in the app yet, so
    there is no store sandbox to test. What can be tested is the setting from
    [in-app-purchases.md](in-app-purchases.md#which-setting-to-change):
    - Do: with the defaults (`IOS_DIGITAL_PURCHASES=hidden`, `ANDROID_DIGITAL_PURCHASES=play_billing_required`),
      look at a creator's profile, a post for subscribers, Plus and a paid download on each phone.
      Then, if you plan option B, set the link mode for `US` on yapilapi-api, wait a minute, and
      reopen the app on a phone whose region and account country are the US.
    - Should: with the defaults, neither phone offers to buy Plus, subscriptions, tips, downloads or
      live tickets; physical goods in Market and drops still work. In link mode with US on both, a
      link opens the web page in the browser; anywhere else it stays hidden. The web admin console's
      **Feature flags** card "Phone app purchases" shows what the API is sending.
    - If not: the screen, the phone's region, the account's country and the two settings.

    When StoreKit and Play Billing are added, test them here with an Apple sandbox account (**App
    Store Connect > Users and Access > Sandbox**) and a Play license tester (**Play Console > Settings
    > License testing**), and never with your own card.

### Feel

24. **Vibration and sounds.** The app doesn't use tap vibrations. The one thing that buzzes is an
    incoming call.
    - Do: call phone B while the app is open, with the ringer on and then on silent. Decline once,
      answer once, and let one ring out.
    - Should: it rings (or vibrates when the ringtone can't play) and stops the moment you answer or
      decline, or after 45 seconds. With **Quiet mode** on in the app (**Settings > Feed and time**), the app makes no
      sounds or vibrations of its own.
    - If not: whether it kept ringing or vibrating, and for how long.

### Data and connection

25. **Data saver on mobile data.**
    - Do: on mobile data, in **Settings > Data saver**, choose **On**. Scroll Pulse and Reels, then
      post a photo. (Automatic works like Off on phones for now, because the app can't tell Wi-Fi from
      mobile data yet.)
    - Should: photos load smaller first, videos wait until you tap play, and the uploaded photo is
      made smaller before it's sent. The phone's data usage for YAPILAPI grows noticeably slower than
      with Off.
    - If not: what still loaded at full size, and the data used (the phone's settings show it per app).
26. **Offline, then back.**
    - Do: turn on airplane mode while on Pulse. Open a chat and try to send a message. Turn airplane
      mode off.
    - Should: "You're offline. Some things may not load." with **Try again**, then "Back online"
      within a few seconds of the connection returning; new messages arrive again without restarting.
      A message sent offline either sends once the connection is back or says it didn't send; it never
      disappears silently.
    - If not: what happened to the message, and whether the banner went away.

### Languages and accessibility

27. **Arabic, right to left.**
    - Do: on iPhone, **Settings > YAPILAPI > Language > العربية**; on Android, **Settings > System >
      Languages > App languages > YAPILAPI**. Open the app. Go through Pulse, a chat, Create and
      Settings, then switch back.
    - Should: the app reloads once and everything mirrors: the dock, back arrows, rows and text start
      from the right. Names and posts in English inside Arabic text keep their own order. Switching
      back to your language mirrors back.
    - If not: screenshots of the screens that look wrong.
28. **Large text.**
    - Do: iPhone: **Settings > Accessibility > Display & Text Size > Larger Text**, the slider to the
      biggest (with Larger Accessibility Sizes on). Android: **Settings > Display > Display size and
      text**, both at the largest. Open sign-in, Pulse, a post, a chat, Create, Profile and Settings.
    - Should: text grows; nothing important is cut off or overlaps; every button can still be reached
      by scrolling; the dock stays usable.
    - If not: screenshots, and which screen.
29. **VoiceOver and TalkBack.**
    - Do: turn on VoiceOver (iPhone: **Settings > Accessibility > VoiceOver**) or TalkBack (Android:
      **Settings > Accessibility > TalkBack**). Swipe through sign-in, Pulse, a post, a chat (including
      the record button), Create, Profile and Settings. Like a post, send a message and close a
      sheet using only the screen reader (VoiceOver: two-finger scrub to go back).
    - Should: every button says what it does ("Like", "Record a voice message"), not just "button";
      the order follows the screen from top to bottom; you can finish each task without sight.
    - If not: the screen and the control that said nothing or the wrong thing (a screen recording
      with the sound on is the most useful).
