# Accessibility

YAPILAPI targets **WCAG 2.2 AA**. Two automated suites in `apps/web/e2e/` guard it, and CI runs both (`accessibility` job in `.github/workflows/ci.yml`).

## How to run the audit

The suites need a running API and web app. Use your own ports, the host `127.0.0.1` (so the audit's cookies stay apart from a `localhost` development session) and a scratch database, never the development one:

```bash
# A scratch database, migrated, with the Memory feature on (memories, chapters and recaps are audited)
docker compose exec db psql -U postgres -c "CREATE DATABASE yapilapi_a11y"
DATABASE_URL=postgres://postgres:postgres@localhost:5432/yapilapi_a11y pnpm db:migrate
docker compose exec db psql -U postgres -d yapilapi_a11y \
  -c "INSERT INTO feature_flags (key, enabled) VALUES ('MEMORY', true) ON CONFLICT (key) DO UPDATE SET enabled = true"

# API: APP_ENV=test lifts rate limits for the sign-ups; JOB_WORKER=true still runs the background
# jobs (photo processing, the recap video), which APP_ENV=test otherwise leaves to the API tests.
APP_ENV=test JOB_WORKER=true API_HOST=127.0.0.1 API_PORT=4100 RATE_LIMIT_MAX=100000 WEB_ORIGIN=http://127.0.0.1:3100 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/yapilapi_a11y pnpm dev:api

# Web app pointed at it (a production build gives the most faithful results)
cd apps/web
API_INTERNAL_URL=http://127.0.0.1:4100 NEXT_PUBLIC_WS_URL=ws://127.0.0.1:4100/v1/realtime npx next build
API_INTERNAL_URL=http://127.0.0.1:4100 npx next start --port 3100 --hostname 127.0.0.1

# Once: the browser
pnpm --filter @yapilapi/web exec playwright install chromium

A11Y_BASE_URL=http://127.0.0.1:3100 pnpm --filter @yapilapi/web test:a11y
node apps/web/e2e/summary.ts            # counts by project and rule (--details for every element)
```

`A11Y_BASE_URL` defaults to `http://127.0.0.1:3100`; nothing else in the suites names a port.

`e2e/global-setup.ts` signs up three fresh users through the web app's `/api` proxy (random throwaway passwords, nothing typed by hand) and gives the main user realistic content on every page:

- posts (one with two photos and their descriptions), a **draft** and a post **scheduled** for next week;
- a public **board** with two posts, a saved post from a friend, a **circle** with the friend in it;
- a "Now" **status**, a **cover photo**, followers and following;
- two photo **stories** in a **chapter**, and a **recap video** made from it (the setup waits until it is `ready`);
- a **reel** by the friend (its **sound** has a page), and a friend's **story with music and stickers** (a poll and a hashtag);
- a **conversation** with a **reply**, a **pinned** message, a reaction and **disappearing messages** on;
- a community, a place, an event hosted by the friend, a shop, and **grouped notifications** (two people like the same post, one comments).

Photos and the reel come from `e2e/fixtures/` (small generated files). **Audio rooms** are made fresh by each test that opens one (`liveRoom()`): the friend starts a live room in a new community of his and joins it as host. A community has one live room at a time and a room without its host ends after five minutes, so rooms are not shared between tests.

### What is checked

**`a11y.spec.ts`**: axe-core (`@axe-core/playwright` 4.13) with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice` rule sets (contrast, names and labels, ARIA validity, landmarks, heading order, target size, document language and title…).

**45 pages:** landing, login, signup, forgot password; home, discover, create, inbox, a conversation, your profile, someone else's profile, community, event, place, settings (with the Data saver card), studio, notifications (grouped), a single post, events, assistant, live, a business page, developers, memories, reels, search, search results, camera, a tag page, Plus, invite, drafts and scheduled posts, continue a draft, create a story, create a reel, saved, a board, circles, a circle, recaps, a recap (ready video), make a recap, a chapter, the story archive, a sound page.

**30 open states** (sheets, menus and other things that only show after an action; the page audit only sees them closed). Each is opened the way a person would, then the whole page is audited:

- profile: the status sheet, the share sheet (QR code), the cover sheet, the followers and following lists;
- chat: a message's menu, replying, editing, the reaction picker, search with results, the disappearing messages sheet;
- the story viewer on a story with music and stickers (paused);
- "Save to a board" from a post's menu on home, and from a board; a board post's options, the collaborators sheet, arranging;
- drafts: the schedule sheet;
- create: scheduling with a circle chosen and co-author suggestions open; the photo editor; a photo with its description field; the story music picker; a story with music chosen;
- chapter: the player and the invite sheet; recap: "Send in a chat" and "Post as a reel";
- settings: the Data saver card;
- an audio room before joining, and after joining with a hand raised.

Everything runs in four projects: **desktop** (1440×900) and **mobile** (Pixel 7, 412×915, touch) × **light** and **dark** color schemes. That is **300 audits**; each must have zero violations. The page is audited after network idle, after loading states (`aria-busy`) clear and after finite animations finish.

**Right-to-left:** every signed-in page is loaded with `dir="rtl"` in all four projects and must not be wider than the viewport. (An offscreen skip link placed with `left: -9999px` once made every page scroll to blank space in RTL.) The design system uses logical properties (`inset-inline-*`, `margin-inline-*`, logical corner radii), mirrors directional icons, and marks user-written text with `dir="auto"` / `<bdi>` so mixed-direction names, handles, tags and messages read correctly.

**`keyboard.spec.ts`** (desktop and mobile layouts, 11 tests):

- The first Tab reaches a visible "Skip to content" link; following it puts the next Tab inside `main`. The primary navigation is reached next, in visual order, with `aria-current="page"` on the current destination.
- Post options **menu**: Enter opens it on the first item, arrows/Home/End move with wrap-around, ArrowUp opens on the last item, Escape closes it and returns focus to the button, Tab closes it.
- Comments **bottom sheet**: focus moves into it, Tab and Shift+Tab stay inside, Escape closes it and focus returns to the Comments button. The open sheet is audited with axe.
- **Story viewer**: opens from the stories strip, focus moves in and stays in, Space pauses, the open viewer is audited with axe, Escape closes it and the ring then reads as seen.
- **Checkout** sheet: opens from a Buy button, focus moves in and stays in, the open sheet and the paid state are audited with axe, Escape closes it.
- Delete-account **dialog** and settings **tabs**: arrows and Home/End move between tabs, the dialog traps focus, closes on Escape and returns focus to its button. The open dialog is audited with axe.
- **Chat reply, keyboard only**: Tab from the top of the page to a message's options, Enter opens the menu on Reply, Enter puts focus in the message box, which is described as "Replying to Ben Keyboard"; Escape cancels and keeps focus there; Shift+Tab back, reply again, type and press Enter: the sent message quotes the original and focus stays in the (empty) box.
- **Chat reaction picker and search**: the picker takes focus, arrows move in it, Escape closes it and focus returns to the message's options; search opened from the chat's menu takes focus, announces the number of results, and Escape returns focus to the menu button.
- **Status sheet**: Enter opens it, focus moves in and stays in, the page behind is `inert`, Escape closes it and focus returns to "Edit status"; opened again, a new status is typed and saved with the keyboard, the toast is announced from the (always present) live region and focus returns to the button.
- **Camera mode tabs**: focus moves into the camera; the tabs are one tab stop (the selected one); Left/Right move and select with wrap-around, Home/End go to the ends; Tab stays in the camera; Escape closes it.
- **Audio room**: Tab to "Join as a listener", Enter joins and focus moves to the room's title; Tab to "Raise hand", Space and Enter toggle it (`aria-pressed`, same name, focus stays), the raised hand shows in the listeners list; the room is audited with axe; "Leave quietly" leaves.

## Results (2026-09-27): new pages and states

### Automated audit

The 16 new pages (and the tag page, now on a tag with posts) and 30 states, before fixes (development server), and all 75 pages and states after (production build):

| Project       | Before: violations (rule × page) | Before: elements | After |
| ------------- | -------------------------------: | ---------------: | ----: |
| desktop-light |                                0 |                0 |     0 |
| desktop-dark  |                                0 |                0 |     0 |
| mobile-light  |                                3 |                6 |     0 |
| mobile-dark   |                                2 |                2 |     0 |
| **Total**     |                            **5** |            **8** | **0** |

| Rule           | Impact  | Elements | Pages                                                          | Fix |
| -------------- | ------- | -------: | -------------------------------------------------------------- | --- |
| `color-contrast` | serious |        4 | reels (phone, light)                                           | The bottom navigation's frosted background let the black reel show through, so its labels were 3.7:1. The glass is now 90% opaque (was 78%): labels keep at least 4.5:1 over anything behind them. |
| `target-size`  | serious |        4 | conversation, chat search, disappearing messages sheet (phones) | A message's options button was half under the composer, which stays at the bottom over the messages. The chat page now has `scroll-padding-bottom` for the composer (and the phone navigation), so scrolling to the newest message or to a message's buttons with Tab stops above them (also WCAG 2.4.11, focus not obscured). Behind an open sheet, the page is now `inert` (see below), so it can't be focused or tapped. |

### Keyboard, focus, names and announcements (found by review and the new keyboard tests)

| Where | Before | After |
| --- | --- | --- |
| `useModalFocus` (every dialog, sheet and full-screen overlay) | The page behind a modal was only hidden by `aria-modal`, which some screen readers ignore, and could still be clicked | Everything outside the open modal is `inert` while it's open (the siblings of the modal and of each of its ancestors), restored on close before focus returns. Live regions (`role="status"`, `role="alert"`) are left alone so toasts are still announced. |
| `Toast` | The `role="status"` element was added together with its text (and re-mounted for each toast), which screen readers often miss | An always-present live region (`role="status"`, `aria-live="polite"`, `aria-atomic`); only its content changes. Each toast has an `id` so the same text twice is announced twice. |
| Camera | `role="dialog"` with no focus handling; mode "tabs" were three tab stops and arrows changed the mode without moving focus; no Escape | `useModalFocus` (focus moves in and stays in, the page behind is inert, Escape stops a recording or closes). The mode tabs are one tab stop (roving `tabindex`); Left/Right (mirrored in RTL) move focus and select, with wrap-around; Home/End. "R" no longer fires while typing or with modifier keys. |
| Audio room | "Raise hand" had `aria-pressed` *and* renamed itself "Lower hand" (a pressed "Lower hand" reads backwards); same for "Tell me when it starts" / "We'll tell you"; the speakers stage had `aria-label` on a plain `div`; the controls were a `role="toolbar"` without toolbar arrow keys; joining removed the focused button and left focus nowhere; the speaking ring flickered on every pause (every 200 ms) | Toggles keep one name and use `aria-pressed`. The stage is a labelled `group`; the controls are a `group`. After joining, focus moves to the room's title. The raised-hands count for hosts is a live region. Someone stays "speaking" through short pauses (0.7 s, or 2 s with reduced motion), so the ring and the "Speaking" text don't flicker. |
| Chat | Reaction chips had `aria-pressed` and a name that flipped between "Add this reaction" and "Remove your reaction"; the reaction picker's Escape left focus nowhere and it had no arrow keys; closing search left focus nowhere and the result count wasn't announced; "Replying to …" was a `role="status"` added with its text; cancelling a reply dropped focus | Chips are "❤️ 2 reactions" with `aria-pressed`. The picker: arrows/Home/End, Escape and picking return focus to the React button or the message's menu button, Tab out closes it. Search returns focus to the chat's menu button and announces "3 messages found" from a live region. The message box is described by the reply/edit line (`aria-describedby`), so it's read when focus lands there; Cancel keeps focus in the box. |
| Sounds and story music | Play buttons had `aria-pressed` and a name that changed (Play/Pause); picking a sound removed "Add music" and left focus nowhere; "Use" buttons all had the same name | Play/Pause is a plain button whose name says what it does. After picking, focus moves to "Choose another sound". "Use Oven timer beats". The "Loading sounds" line is a status. |
| Story viewer, reels, posts | "Like"/"Unlike", "Repost"/"Undo repost" and "Turn sound on/off" were toggles with `aria-pressed` whose names also changed | One name ("Like", "Repost", "Sound") with `aria-pressed`. |
| Follow lists | The sheet was titled only with the person's name; following someone swapped the focused button for plain text | "Ada Access: followers" / "…: following"; the button stays (as "Following", `aria-disabled`) so focus isn't lost; "Follow Ben Keyboard" names. |
| Drafts | Publishing or deleting a draft removed the focused button | Focus moves to the page title. |
| `Button` | Couldn't take a `ref` | Takes a `ref` (to move focus to it). |

All these names and announcements go through `t()`/`tp()`: the new ones (`m.music.useTitle`, `m.chat.reactionCount`, `m.chat.searchFound`, `m.chat.searchFoundMore`, `follow.titleFollowers`, `follow.titleFollowing`, `follow.followName`, `follow.followingName`, `m.reels.sound`) are in all 8 catalogs in `packages/shared/src/i18n.ts`, and toggles use the existing key for their one name (for example `m.rooms.raiseHand`, `post.like`, `m.reels.repost`).

Reduced motion was reviewed for the new animations: the music sticker's bars stop (`prefers-reduced-motion`), room reactions fade in place instead of floating, the speaking ring's transition uses the design-system durations (0 with reduced motion) and now changes less often (above). Headings: each new page has one `h1` and `h2` sections in order (axe `heading-order` passes on all of them).

After the fixes: **300 audits, 0 violations** in every project, **11 keyboard tests** passing in both layouts, **164** right-to-left overflow checks passing (production build, 2026-09-27).

## Results (2026-09-26): first audit

### Automated audit

| Project       | Before: violations (rule × page) | Before: elements | After |
| ------------- | -------------------------------: | ---------------: | ----: |
| desktop-light |                                6 |                7 |     0 |
| desktop-dark  |                               10 |               12 |     0 |
| mobile-light  |                                7 |                8 |     0 |
| mobile-dark   |                                7 |                8 |     0 |
| **Total**     |                           **30** |           **35** | **0** |

Before, by rule (all projects):

| Rule                    | Impact   | Elements | Pages               | Fix |
| ----------------------- | -------- | -------: | ------------------- | --- |
| `aria-valid-attr-value` | critical |        8 | community, settings | `Tabs` pointed `aria-controls` at panels that were never rendered. Only the selected tab now references a panel; pages that render their own panel pass `id`/`panelId` and wrap it in `role="tabpanel"` (settings, community, admin). |
| `target-size`           | serious  |        6 | home, community     | The post author link was 20px tall. Its line box is now 24px (WCAG 2.5.8). |
| `region`, `document-title`, `html-has-lang`, `landmark-one-main` | serious/moderate | 12 | event | The event page crashed in Chromium: `Intl.DateTimeFormat` does not allow `dateStyle`/`timeStyle` with `timeZoneName`, so the error page was audited. The date is now formatted with explicit fields. |
| `aria-allowed-role`     | minor    |        4 | home                | Moments were `<button role="listitem">`. The strip is now a `<ul>` of `<li>` with plain buttons inside. |
| `landmark-unique`       | moderate |        2 | discover            | Discover and the sidebar both had an unnamed `role="search"` form. They are labelled "Discover" and "Quick search". |

The "before" run used the development server; the "after" run a production build (60 audits, 0 violations; 8 keyboard tests passing).

### Keyboard and focus (found by review and the keyboard suite)

| Component (design system) | Before | After |
| --- | --- | --- |
| `Dialog` | Escape and focus return, but Tab could leave the dialog | New `useModalFocus` hook: focus moves in, Tab/Shift+Tab wrap inside, Escape closes, focus returns to the opener. Nested modals: only the top one handles keys. |
| `BottomSheet` | Escape only; Tab left the sheet; focus was lost on close | `useModalFocus` |
| `MediaViewer` | Escape and arrows; no trap, no focus return | `useModalFocus` (arrows unchanged) |
| `Menu` | Escape closed it but focus stayed nowhere; no arrow keys; Tab left it open; Escape inside a sheet also closed the sheet | Full menu-button pattern: arrows/Home/End, ArrowUp/Down open, Escape returns focus to the button without closing an enclosing sheet, Tab closes; choosing an item returns focus to the button so a sheet it opens can hand focus back |
| `Tabs` | Left/Right only | Also Home/End |
| `NavBar` | Unread badge read as a bare number ("Yap 3") | "Yap, 3 unread" (badge hidden from screen readers, text visually hidden) |
| Menu items, moments | Focus shown only as a faint background change / browser default | Focus ring (`--focus-ring`) |
| Post composer, message composer | Textarea outline removed with no replacement | The surrounding box shows the focus ring while the textarea has focus |
| Call and Mini App overlays (`role="dialog"` in the web app) | No focus handling | `useModalFocus` (the call overlay deliberately has no Escape: it must not hang up by accident) |


## Remaining known issues

- **Not audited automatically:** admin, real/together, onboarding, OAuth consent, password reset pages; the incoming-call and Mini App overlays (they need a second live session or a registered app); the video editor (it needs a real video decode in the browser); a room you host (speaking needs a microphone). They use the same components, but have not been run through axe.
- **Color contrast** is checked by axe on rendered text only. Text over photos, video and gradients (moment rings, story text and stickers, the music sticker, profile covers) is reported as "needs review" by axe, not as pass or fail, and has not been checked by hand. Icon-only buttons' 3:1 non-text contrast isn't checked by axe either (chat message tools are dimmed to 70% on touch screens).
- **Screen readers:** no manual pass with VoiceOver, TalkBack or NVDA yet. Toasts, chat search results, raised hands and loading lines use live regions; the conversation is a `role="log"` that announces new messages as they arrive (not yet confirmed with each screen reader).
- **Reduced motion:** transitions respect `prefers-reduced-motion` in the design system, and the new animations were reviewed (above), but the Real capture countdown and live video are not covered.
- **Mobile tab order:** on phones the bottom navigation comes before the page content in tab order (it is first in the DOM); the skip link jumps over it.
- **Localisation:** axe runs in English only. Right-to-left layout is checked for overflow automatically and was reviewed by eye on home, discover and settings at phone and desktop widths; a native Arabic or Hebrew reader hasn't reviewed it.
- **Nested dialogs:** stacking (focus and `inert`) is handled by `useModalFocus`, but only the sheet → sheet and sheet → dialog combinations exercised in code today have been tried.
- **Confirmations** before unsending a message or deleting a draft use the browser's `confirm()`, which is accessible but can't be styled or audited.
