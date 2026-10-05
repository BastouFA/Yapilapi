# Accessibility

YAPILAPI targets **WCAG 2.2 AA**, and 44 by 44 CSS pixel touch targets (WCAG 2.5.5, AAA). Three automated suites in `apps/web/e2e/` guard it, and CI runs all three (`accessibility` job in `.github/workflows/ci.yml`).

## How to run the audit

The suites need a running API and web app. Use your own ports, the host `127.0.0.1` (so the audit's cookies stay apart from a `localhost` development session) and a scratch database, never the development one:

```bash
# A scratch database, migrated, with the Memory and Together features on (memories, chapters, recaps and albums are audited)
docker compose exec db psql -U postgres -c "CREATE DATABASE yapilapi_a11y"
DATABASE_URL=postgres://postgres:postgres@localhost:5432/yapilapi_a11y pnpm db:migrate
docker compose exec db psql -U postgres -d yapilapi_a11y \
  -c "INSERT INTO feature_flags (key, enabled) VALUES ('MEMORY', true), ('REAL_TOGETHER', true) ON CONFLICT (key) DO UPDATE SET enabled = true"

# API: APP_ENV=test lifts rate limits for the sign-ups; JOB_WORKER=true still runs the background
# jobs (photo processing, the recap video), which APP_ENV=test otherwise leaves to the API tests.
# PUBLIC_API_URL: media links point at this API (it defaults to port 4000), so photos and videos load.
APP_ENV=test JOB_WORKER=true API_HOST=127.0.0.1 API_PORT=4100 PUBLIC_API_URL=http://127.0.0.1:4100 RATE_LIMIT_MAX=100000 WEB_ORIGIN=http://127.0.0.1:3100 \
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
- a community, a place, an event hosted by the friend, a shop, and **grouped notifications** (two people like the same post, one comments);
- **Ask me**: a question box on both profiles with a prompt, an answered question (so the profile has an Answers tab) and one asked without a name waiting in the inbox;
- **profile style**: an accent with the cover photo header, pronouns, a city, a link, a profile song and a featured post (the friend has another accent and the gradient header);
- **drops**: the friend's drop, scheduled, with you waiting for it, and your own draft drop from your own shop;
- a second **chat** (with the third user) with a wallpaper and bubble colour, a message to **send later**, and one **game** of each kind (Four up, Noughts, Word ladder), your turn in each;
- this week's **weekly wrap**, made through `POST /dev/weekly-wrap` (development and test only; wraps normally come on Sunday evening);
- **Market**: a listing by Ben (you can write to him or make an offer) and one of yours; their words carry the run's code, since the same words listed again and again are held for review;
- **tickets**: Ben's class, where you're going (so your wallet holds a ticket you can give to a friend), and your own tasting an hour from now, where Ben is checked in and Cleo isn't yet (the check-in screen);
- a **Together** album started from a group chat with Ben and Cleo, with two of your photos and one of Ben's, one starred with a comment.

Photos and the reel come from `e2e/fixtures/` (small generated files). **Audio rooms** are made fresh by each test that opens one (`liveRoom()`): the friend starts a live room in a new community of his and joins it as host. A community has one live room at a time and a room without its host ends after five minutes, so rooms are not shared between tests. **Watch together** sessions are asked for by each test that opens one (`watchSession()`): the third user starts one in the second chat with a reel queued, or joins the one still running (people whose player goes quiet leave after 45 seconds, and a session nobody watches ends).

### What is checked

**`a11y.spec.ts`**: axe-core (`@axe-core/playwright` 4.13) with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice` rule sets (contrast, names and labels, ARIA validity, landmarks, heading order, target size, document language and title…).

**79 pages:** landing, login, signup, forgot password, legal, privacy policy, cookie notice; home, discover, create, inbox, a conversation, your profile, someone else's profile, community, event, place, settings and its sections (account, notifications, privacy, security, safety, appearance, help), studio, notifications (grouped), a single post, events, assistant, live, a business page, developers, memories, reels, a reel with highlights, search, search results, camera, a tag page, Plus, invite, drafts and scheduled posts, continue a draft, create a story, create a reel, saved, a board, circles, a circle, recaps, a recap (ready video), make a recap, a chapter, the story archive, a sound page; and, newer: past weekly wraps, a weekly wrap, questions (Ask me inbox), drops, a new drop, someone's drop, your draft drop, editing a drop, and a chat with a wallpaper, a scheduled message and four games; and, newest: Market, selling something, someone's listing, your listing, your Market, editing a listing, an event you hold a ticket for, your tickets, check-in at the door, Together, an album, a new album, making an echo and a reel's echoes.

**70 open states** (sheets, menus and other things that only show after an action; the page audit only sees them closed). Each is opened the way a person would, then the whole page is audited:

- profile: the status sheet, the share sheet (QR code), the cover sheet, the followers and following lists;
- chat: a message's menu, replying, editing, the reaction picker, search with results, the disappearing messages sheet;
- the story viewer on a story with music and stickers (paused);
- "Save to a board" from a post's menu on home, and from a board; a board post's options, the collaborators sheet, arranging;
- drafts: the schedule sheet;
- create: scheduling with a circle chosen and co-author suggestions open; the photo editor; a photo with its description field; the story music picker; a story with music chosen;
- chapter: the player and the invite sheet; recap: "Send in a chat" and "Post as a reel";
- settings: the Data saver card;
- reels: details, the options sheet, the share sheet, comments with a moment, clear view;
- an audio room before joining, and after joining with a hand raised;
- newer: Pulse with the weekly wrap card and the drops row; your profile with its styled header, links and song chip; the Answers tab; someone's profile with the Ask card filled in; answering a question; your own drops; the watch together banner in a chat and the watch together page; the sheet to start a game and the board sheet of each game (Four up, Noughts, Word ladder, Chess); the wallpaper and colour sheet; the send later sheet; Settings > Account > Customise your profile (with a new link); the change username sheet with a name checked as free;
- newest: "Why am I seeing this?" from a post's menu; each game board in the 3D view; making an offer on a listing; marking your listing reserved; giving a ticket to a friend; a code at the door that isn't on the list; an album's photo viewer, its people and invite sheets, and adding photos; the echo screen with your video chosen; a board, a listing and an album that couldn't load (the connection dropped: the reason and Try again); and the call screen, from the audio call button in a chat's header (a silent tone stands in for the microphone; each project calls in a new group, since a chat has one call at a time).

The newer pages and states (the last item and the newer pages above) are audited at **375px** wide in the mobile projects (the narrowest common phone), and each must also not scroll sideways there.

Everything runs in four projects: **desktop** (1440×900) and **mobile** (Pixel 7, 412×915, touch) × **light** and **dark** color schemes. That is **596 audits** (149 × 4); each must have zero violations. The page is audited after network idle, after loading states (`aria-busy`) clear and after finite animations finish.

**Right-to-left:** every signed-in page is loaded with `dir="rtl"` in all four projects and must not be wider than the viewport. (An offscreen skip link placed with `left: -9999px` once made every page scroll to blank space in RTL.) The design system uses logical properties (`inset-inline-*`, `margin-inline-*`, logical corner radii), mirrors directional icons, and marks user-written text with `dir="auto"` / `<bdi>` so mixed-direction names, handles, tags and messages read correctly.

**`targets.spec.ts`** (desktop and mobile layouts, 32 pages and 4 open states): every visible control (links, buttons, fields, selects, summaries and the button-like ARIA roles) must be at least **44 × 44** to press. Each control is scrolled into view and the page is asked, pixel by pixel out from its centre (left, right, up, down), whether a press there still reaches the control, something inside it or its label: it must reach 44px across and 44px down (less a pixel for rounding). The failure names what stopped it, so a neighbour means two targets overlap and anything else means the target is too small; a control covered at its centre by another control fails too. A control bigger than 44px passes if 44px fits across it somewhere (a card with a small button over one corner). A checkbox or field inside its label is measured by the label. Not measured: links inside a paragraph or sentence (WCAG's inline exception), controls that are hidden, clipped away or covered by something that isn't a control, and past the edge of the screen. Pages: home, discover, a conversation, the chat with games, inbox, both profiles, a post, notifications, settings (home, account, privacy, notifications), create, Market and a listing, an event and events, a Together album, a board, a community, search results, studio, tickets, questions, drops, saved, a sound page, and signed out: landing, log in, sign up and legal. States: the post and message option menus, the share profile and status sheets. Colours don't change sizes, so the dark projects skip it.

**`keyboard.spec.ts`** (desktop and mobile layouts, 19 tests):

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
- **Chat sheets**: "Start a game" (from the composer's menu, with the arrow keys), "Send later" (Tab from the message box) and "Wallpaper and colour" (from the chat's menu) each take focus, keep Tab inside, are audited with axe, and on Escape close and return focus to what opened them.
- **Chess board**: the board is one tab stop, starting on your king; arrows move around the grid and every square says what's on it; Enter picks a piece up ("picked up") and marks where it can go ("move here"); Escape puts it back without closing the sheet (this was broken: the sheet closed, because it listens on the document, where React does too; fixed in `ChessBoard.tsx`); a second Escape closes the sheet and returns focus to "Your turn: Chess". No move is made, since the projects share the game.
- **Newest sheets**: "Why am I seeing this?" (from the post menu with the arrow keys), the offer sheet on a listing, giving a ticket, and an album's people sheet each take focus, keep Tab inside, are audited with axe, and on Escape close and return focus to what opened them. The album's photo viewer does the same and returns focus to the photo. The **call screen** keeps Tab inside and, by design, stays open on Escape; Hang up ends the call and focus returns to "Audio call".
- **Reels**: M and C toggle sound and clear view (`aria-pressed`), Space plays and pauses, the scrubber is a slider (Home, arrows a second at a time), the options sheet takes focus and returns it on Escape, and J/K move between reels with the address following.

## Results (2026-09-29): 44px touch targets

Every control on the web app can now be pressed anywhere in a 44 × 44 box, while the design draws it at its own size. `targets.spec.ts` (above) measures it; it ran on main's code first (production build), then on the change.

| Layout  | Before: controls too small | Before: pages and states failing | After |
| ------- | -------------------------: | -------------------------------: | ----: |
| desktop |            899 of 1416 |                         36 of 36 |     0 |
| mobile  |            623 of 1014 |                         35 of 36 |     0 |

The largest groups before: header and post actions (`.yp-action`, 38px), segments and tabs (34px), small buttons (32px), aside names and "See all" links (19px and 16px), chips (30px), text fields (40px), 40px buttons and menu items, links in navigation and footers, the chat's send-later actions (24px), suggested replies (36px) and the story "add" and suggested "hide" buttons (24px, 28px). A wider scan of every page the axe suite opens, signed in and out, in both layouts, found nothing left.

**How** (centrally, in `packages/design-system/src/components.css`, "Touch targets"):

- Buttons, links with a class, a heading's or a navigation's links, summaries, the button-like ARIA roles and labels around a checkbox or radio get a transparent `::after` layer, `inset: min(0px, (100% - 44px) / 2)`: 44px for a small control, its own size for a bigger one. The control gets `position: relative` and `isolation: isolate`, and the layer sits at `z-index: -1` inside it, so it is behind the control's own content and never covers a control nested in a bigger one. It changes neither layout nor paint. The switch draws its thumb with `::after`, so its layer is `::before`. Links inside running text (class-less links, hashtags and mentions) are left as they are. A link that is a line of its own gets a class so it is covered (a Market offer's listing link in a chat, a community card's name).
- A text field in a `.yp-field` reaches out through its label, whose layer fills the gaps around the input. A text field on its own is 44px tall with a transparent border above and below (taken back by the margin), its visible 1px line drawn as an inset shadow; focused, it is drawn as before. Its drawn height is `--yp-input-h`, which pages set instead of `height` or `min-height`.
- Where a control truncates its text, its own `overflow` clips the layer, so it reaches out with padding and an equal negative margin instead (aside names, a post's author, a reel's author), or `overflow: clip` with `overflow-clip-margin` (suggested replies; Safari clips those to the chip). Transparent inputs inside a drawn box (the chat composer, the co-author picker, the Discover assistant, the search bar) are 44px tall with the margin taking the difference back.
- Where a later element sat over a control's layer, the control is raised (`z-index: 1`): the aside's "See all", a post's sound link, a community card's name, a reaction, a game's "Your turn", the reel play button, the suggested card's "hide". A notification's text link and a policy card's link cover their whole row or card.

**What looks different** (before/after screenshots of the same data, production builds): these are the places where two 44px targets would otherwise overlap, so the page leaves room between them.

| Where | Change |
| --- | --- |
| Segments (`.yp-segments`) and tab lists (`.yp-tabs__list`) | 2px taller (5px padding above and below instead of 4px): a scrolling row clips what reaches past it. Everything under them moves down 2px. |
| Menus | Items 44px tall instead of 40px. With the taller items, a message's menu on a phone could open under the chat's header or the message box, or off the side of the screen, and its last items couldn't be reached. `Menu` now leaves out what stays over the page (the page's `scroll-padding-bottom`, which a chat sets for its message box and the navigation, and a sticky `.yp-topbar`) when it picks up or down, lines up with the button's other edge when it would run off the side, and moves the page when there's no room either way. |
| Switches or checkboxes one under another | 12px (switches) or 13px (checkboxes) more between them; for example Settings > Notifications, the Market filters and delivery choices. |
| Rows of small buttons, chips or plain links that wrap onto a second line | 14px between the lines instead of 8px (a row on one line is unchanged); the footer's policy links 21px. |
| Chat composer on phones | 8px between the icon buttons instead of 2px. |
| Profile | 6px more under the counts, 2px more above "Confirm your email"; wrapped action rows as above. |
| Others | 9px more above a community's rules; the story sticker buttons' wrapped lines 14px apart; the recap reorder buttons 4px apart instead of 2px; a reel's caption block 8px higher; 14px (was 6px) between the log-in password field and "Forgot password?". |
| A chat, when it follows the newest message | It now scrolls far enough to show the Yap row and suggested replies under the messages too: they used to stop under the message box that stays at the bottom, so on phones "Turn on Yaps" sat behind it (and axe found it partly covered, depending on the scroll). |
| Text fields on their own | The rounded corners' anti-aliasing differs by a pixel (inset shadow instead of a border). |
| Settings > Privacy, "Add a memory" | The field was drawn 20px tall (a `flex: 1` meant for the field landed on the input); it is now the usual 40px. |

Pixel diffs, before → after, on the three dense pages (1440 × 900 and Pixel 7, the same seeded data and a fixed clock, both builds served one after the other; a second "before" run differs by at most 33 pixels, from presence and time). On desktop the right-hand column is left out: its "Happening soon" and "People to follow" follow the server's clock and the other test users, so they change between any two runs.

| Page | Desktop | Phone |
| --- | --- | --- |
| A chat | 99 pixels, none off by more than 5 levels of colour (a reaction drawn on its own layer) | 0.2%: the composer's icon buttons, 6px further apart |
| The chat with games | 0.2%, none off by more than 6 levels (the "Your turn" buttons on a layer of their own) | 0.3%: the composer, and the same |
| Post feed (home) | 4.5%: everything under the feed segments moves down 2px; above them identical | 9.0%: the same |
| Settings | identical | identical |
| Settings > Account | identical in the first screen; 2px lower below the header picker's segments | 6.5%: segments and a wrapped button row |
| Profile | 3.9%: segments and wrapped rows | 16.6%: wrapped action rows, counts and chips |

The same check over 60 more pages, signed in and out, showed only the changes in the table above (the signed-out pages centre their card, so the footer's wider line spacing moves the whole card up). Element sizes were compared too (every element's box, before and after): the only boxes that change size are the ones listed.

## Results (2026-10-05): phone app, 44pt touch targets

Every control in the phone app (`apps/mobile`) can now be tapped anywhere in a 44 × 44 point box, as on the web. It was done by reading the code: each control's size from its styles (width, height, minimums, padding, the icon or line of text inside) plus its `hitSlop`. The app wasn't run for this, and no tool measured it on a device.

**The check:** `node scripts/check-targets.mjs` (from `apps/mobile`). It reads every screen and component with the TypeScript compiler and flags a `Pressable` (or `Touchable*`) whose touch area it can work out from literals and that is under 44 in either direction. It counts width and height, their minimums, padding, `space[n]`, an icon that is the control's only content, `StyleSheet.create` styles in the same file, both sides of a condition, and `hitSlop` (a number, `{ top, bottom, left, right }` or `slop({ … })`). It is conservative: a size that comes from text, a variable or the layout around it is unknown, so it isn't flagged. A smaller control that is meant to be one (a screen reader-only control, say) is marked `targets-ok: why` in a comment on the line above. Before this work it flagged 39 controls. Now it flags none, and it fails (exit 1) if one comes back.

**The rules used:**
- `hitSlop` first, because it changes nothing visible.
- Where `hitSlop` can't reach 44, `minWidth` or `minHeight` with the content centred, on controls that have no background.
- Spacing changes only where two 44pt areas would otherwise overlap. In those places the reach is split between the two controls, or goes the way that has room.
- `hitSlop`'s left and right don't swap in Arabic, so `slop({ top, bottom, start, end })` in `lib/ui.tsx` gives an uneven reach by reading direction.
- A touch area doesn't reach past a parent that clips (`overflow: 'hidden'`, or a scroll view's own edge). Rows of chips that scroll sideways therefore have 4pt of padding inside, taken back by a negative margin.
- Where touch areas overlap, the later control wins. So wrapped rows of small chips and links get a `rowGap`.

**Shared parts** (`lib/ui.tsx`, `lib/chips.tsx`):
- `SwitchRow` is at least 44 tall. The switch itself is 31.
- A section header's action ("Clear", "See all") reaches less far downwards, so it no longer covers chips that start 8pt below it.
- These were already 44: `Button` (`size="sm"` is 36 with 4 of slop), `Segmented`, `Chip`, `SheetItem` (48), the sheet's close button, `Field` (44 tall; the password eye is 44 × 44), the tab bar (each tab is a full slot, 54 tall) and the header Cancel and Home buttons.

**What changed, by place:**

| Where | Change |
| --- | --- |
| Post card (`lib/post.tsx`) | The actions (like, repost, share, tip, more, save) are 20pt icons 16pt apart. They reach 44 × 44 without overlapping: further down into the card's padding than up, and further sideways for the icon-only ones. Link, event and product chips, the community name, the "duet with" / "remix of" and sound lines, a photo's name tags and their remove cross, "Load full photo", and a co-author's avatar now reach 44. |
| Post page (`app/p/[id].tsx`) | Comment buttons (Reply, Edit, Pin, Delete, Report, like) are at least 32 × 36 with slop; avatars, the comment settings choices, the likers list and Cancel reply now reach 44. |
| Chat (`app/chat/[id].tsx`, `lib/chat-*.tsx`) | The composer's add and view-once buttons reach into the free space next to them. The disappearing-messages line, "Open settings", video attachments, a quoted message, the pinned bar and its unpin button, the search close button, reactions, poll and list buttons, the scheduled-message actions and the game board picture now reach 44. |
| Headers | The home bell and Reels and the You title now reach 44. Chat header icons now sit in 36 × 44 boxes. |
| Reels, stories, camera (`app/reels.tsx`, `lib/stories.tsx`, `lib/story-stickers.tsx`, `app/camera.tsx`) | Now 44: the reel's author, Follow, "more" and its chips, the details panel chips and topics, the rail avatar and follow badge, the story top-bar buttons, reply-bar buttons, footer pills and share list, sticker choices and placed stickers, the camera's mode tabs and "Both sides". |
| Elsewhere | Translation links, catch-up links, smart replies, picked people in a new group, chapters and the chapter player, boards, the date and time picker, co-author and photo-tag crosses, hidden-word, circle, starter and archive chips, music and sound links, the `Slider` track, a community's similar posts, an event's links, an invited person's row, related tags, and an echo's link. |

**What looks different** (everything else looks the same):

| Where | Change |
| --- | --- |
| Switch rows | At least 44 tall. A one-line switch row with no hint is about 13pt taller. |
| Chat header | The icons are 6pt further apart, so a long chat name is cut off a little sooner. |
| Post card | When a post has both a "duet with" / "remix of" line and a sound, they are 14pt further apart. Link chips that wrap onto a second line are 4pt further apart. |
| Comments | Each comment's button row is 4pt taller, and buttons with short labels ("Pin", "Edit") take at least 32pt. "View replies" is 44 tall (was 32). Wrapped button rows are 8pt apart. |
| Reply bar on a post | "Cancel" is 24 tall (was about 20). |
| Translation links | "See translation" and "See original" are 32 tall (was 17), under any post, comment, message or story that offers them. |
| Scheduled messages in a chat | The pill shows the time on one line and the actions on the next. Before, they all shared one line that wrapped. |
| Chat list items | The move and remove buttons are 44 wide (was 32), so the item text is narrower. The pinned bar's unpin button and the search close button are 2pt wider. |
| Reels | The caption and chips sit 9pt higher. Items in the details panel are 4pt further apart. Wrapped topic tags are about 44pt apart (was 25). |
| A community's similar posts | Each is 44 tall (the links were 4pt apart). |
| Rows that wrap onto a second line | 2pt to 16pt more between the lines. This covers the date picker's shortcuts, sticker choices, starter tags, related tags (16pt), chat reactions and new-group chips. |

**Left as is:**
- Links inside running text: mentions, hashtags, inline links, the sign-up consent sentence, and a post's "Edited" in its time line. The web leaves these too (WCAG's inline exception).
- The chess board's squares are the board's width ÷ 8. They are 44 on a 375pt phone and about 37 on a 320pt one. The calendar's days are about 41 wide on a 320pt screen.
- Where the room isn't there, two controls' areas still meet:
  - "See translation" just above a post's remix line;
  - a long Reels chip that reaches under "more";
  - the Reels avatar, whose 44 partly comes from the space above it, because the follow badge covers it.
- Story stickers are scaled by the person who placed them, so a sticker scaled down is smaller to tap. Stickers can also overlap.
- Short photo-tag names: a name of two letters, next to its remove cross, is about 35 wide.

## Results (2026-09-29): Market, tickets and check-in, Together, echoes, 3D game boards, calls in the chat header, "Why am I seeing this?", Try again

The suite first ran unchanged on the day's code (production build): all 468 audits, 14 keyboard tests and 232 right-to-left checks passed. The 14 new pages and 18 new states were then added and run before any fix, and everything again after the fixes (production build, 596 audits, 19 keyboard tests, 288 right-to-left checks, all passing).

### Automated audit (new pages and states)

| Project       | Before: violations (rule × page) | Before: elements | Before: sideways scroll at 375px | After |
| ------------- | -------------------------------: | ---------------: | -------------------------------: | ----: |
| desktop-light |                                4 |                4 |                                – |     0 |
| desktop-dark  |                                4 |                4 |                                – |     0 |
| mobile-light  |                                4 |                4 |                                2 |     0 |
| mobile-dark   |                                4 |                4 |                                2 |     0 |
| **Total**     |                           **16** |           **16** |                            **4** | **0** |

| Rule / check | Impact | Elements | Pages | Fix |
| --- | --- | ---: | --- | --- |
| `page-has-heading-one` | moderate | 16 | a board, a listing and an album that couldn't load; a listing that isn't available | A page that is only an empty state ("isn't available", or a failed load with Try again) had no `h1`: `EmptyState`'s title was always an `h2`. `EmptyState` now takes `level`, and every page that shows only an empty state (missing, failed, signed out, not allowed; 31 files) passes `level={1}`. |
| sideways scroll at 375px | – | 2 pages | the echo screen, with and without a video | "Echo @handle" didn't wrap: a long handle has no break points. Titles in `.yp-topbar` now break anywhere when they must (`overflow-wrap: anywhere`). |

The listing first showed as not available because the seed's listing words were the same on every run, so Market held it for review as a repeat; the seed now adds the run's code to them.

### Keyboard, focus and announcements

Walked through with the keyboard (headless Chromium, 1440px and 375px) and covered by the new keyboard tests: the new sheets and dialogs (Why am I seeing this?, make an offer, mark reserved or sold, give a ticket, an album's viewer, people, invite and add sheets, a game in 3D) take focus, keep Tab inside, close on Escape and return focus to what opened them. The 3D view button is a toggle (`aria-pressed`) that keeps its name. The little board on a game card opens the game on click only; keyboards and screen readers use the card's button, so it stays `aria-hidden`.

| Where | Before | After |
| --- | --- | --- |
| Call screen | "Calling…" and "Connecting…" were plain text, so a screen reader landing on Mute heard only "Call, dialog, Mute"; an incoming call showed an eye or a bell | The status is a `role="status"` line and describes the dialog while nobody has joined; an incoming call shows the phone or camera icon, like the header buttons. Escape still doesn't hang up (by design). |
| Market listing | The seller's name link was 23px tall | 24px (WCAG 2.5.8). |

Targets: the new pages were scanned at 375px for controls under 44 × 44. Everything under 44px is a shared design-system size used across the app (40px buttons, 34px segments, 38px header actions, 32px small buttons, the 40 × 24 switch whose whole row is its label, 18px checkboxes inside their labels); Together's window and audience chips are 44px with the radio inside them. Those sizes now reach 44px to press; see the touch target results above.

## Results (2026-09-28): watch together, weekly wraps, Ask me, drops, games, chat looks, send later, profile style, usernames

### Automated audit

The 9 new pages and 16 new states, before fixes, and all 116 pages and states after (production build). Two problems on older pages turned up in the same run: Settings had been rebuilt as one page per section since the last audit, and the log in form had changed.

| Project       | Before: violations (rule × page) | Before: elements | After |
| ------------- | -------------------------------: | ---------------: | ----: |
| desktop-light |                                5 |                8 |     0 |
| desktop-dark  |                                5 |                8 |     0 |
| mobile-light  |                                5 |                8 |     0 |
| mobile-dark   |                                5 |                8 |     0 |
| **Total**     |                           **20** |           **32** | **0** |

| Rule                 | Impact   | Elements | Pages | Fix |
| -------------------- | -------- | -------: | ----- | --- |
| `heading-order`      | moderate |       16 | your profile, someone's profile (the Ask card), Settings > Account (Customise your profile) | The Ask card's title was an `h3` right under the profile's `h1`; it is an `h2` now. The customise card's parts (Style, About, Links, Profile song, Tabs, Featured) were `h4` under the card's title; they are `h3` under an `h2` (below). |
| `aria-allowed-attr`  | critical |       12 | Settings > Account | The header style buttons were `role="radio"` with `aria-checked` *and* `aria-pressed`. They are toggle buttons (`aria-pressed`) in the fieldset that names them, like `Segments`. |
| `autocomplete-valid` | serious  |        4 | log in | The email field had `autocomplete="username email"` (only one field name is allowed). It is `username`, which also offers saved emails. |
| `heading-order`      | moderate | 11 pages | every Settings section page | Found with a quick axe pass before the full run (desktop, light): each card's title was an `h3` straight under the page's `h1`. The design system's `Card` now takes its heading level from `CardHeadings`, and `SettingsPage` wraps its cards in `<CardHeadings level={2}>`. |

Horizontal overflow at 375px: none on any of the new pages or states (checked in all four projects). Right-to-left: the 9 new pages are added to the overflow check (58 pages × 4 projects, all passing).

### Keyboard, focus and announcements (checked by hand with Playwright, then fixed)

Tab order, Escape and focus return were walked through with the keyboard on each new sheet and page (headless Chromium, 1440px and 375px): every sheet takes focus when it opens, Tab and Shift+Tab stay inside it, Escape closes it and focus goes back to what opened it, and no page traps focus. Game boards are one tab stop with arrow keys, Home and End. What was wrong:

| Where | Before | After |
| --- | --- | --- |
| `useModalFocus` (all sheets and dialogs) | A sheet whose field has `autoFocus` (the Word ladder board) saw focus already inside it when it opened, so on close focus went nowhere | The hook remembers the element focused before the current one; when focus is already inside the modal, it returns focus to that one (the "Your turn: Word ladder" button). |
| `Button` with `loading` | Became `disabled` while loading, which drops focus to the page (Notify me, Answer, Rematch, Save…) | Stays focusable while loading: `aria-disabled` and `aria-busy`, clicks do nothing (a submit button doesn't submit twice). |
| Drop page | "Notify me" and "Stop reminding me" were two different buttons, so focus was lost on each press; the status line ("Opens in 5 minutes") was a live region that changed every minute; the seller link read the name twice (avatar and text) | One button that changes its text, so focus stays; the status line is plain text and only a change of phase (it opens, sells out, ends) is announced; the avatar in the link is hidden from screen readers. |
| Wallpaper and colour sheet | `role="radio"` swatches, each a tab stop, with no arrow keys; `disabled` while saving (focus lost after each pick) | Toggle buttons (`aria-pressed`) in their fieldsets: each change posts a line in the chat, so arrow keys must not pick. They stay focusable (`aria-disabled`) while saving; visible focus ring. |
| Scheduled messages in a chat | "Edit", "Send now" and "Cancel" didn't say which message; `disabled` while sending; focus lost when the message went | Each is described by its message and time (`aria-describedby`); `aria-disabled` while busy; after Send now or Cancel focus moves to the message box; visible focus ring. |
| Watch together | The sound button had `aria-pressed` and a name that flipped ("Turn sound on/off"); "Add … to the queue" buttons were `disabled` while adding (focus lost) | "Sound" with `aria-pressed` (pressed: on), like reels; the add buttons stay focusable (`aria-disabled`) and say when a video is already in the queue. |
| Game board sheet | After Forfeit or Rematch the button that had focus went away | Focus moves to the line saying what happened (the sheet's `role="status"` line). |
| Questions | Cancelling an answer dropped focus | Focus returns to the question's Answer button. |
| Pulse cards | "Put away" removed the card and focus with it | Focus moves to the page title. |
| Ask card on your profile | "Turn on" swapped the card, dropping focus | Focus moves to "Open your questions" on the new card. |
| Customise your profile | Adding a link left focus on "Add a link"; removing a link or a featured post dropped focus | Focus moves to the new link's name; after removing, to "Add a link" or "Choose posts". |
| Settings: a link to one setting | The setting's brief highlight also replaced the fade-in of a dialog opened from it (delete account), and when the highlight ended the dialog faded in again, so for a moment its text was faint (the keyboard test's contrast check failed now and then) | The highlight leaves dialogs alone. |

Reduced motion: the new animations (floating reactions in watch together, the profile song's bars) already stop or fade in place with `prefers-reduced-motion`; nothing else new moves. Headings: each new page has one `h1` and sections in order.

### Phone app (reviewed in code)

The matching screens in `apps/mobile` were read for labels, roles, states, touch targets and text size:

- **Labels and roles:** each queue item's remove button names its video; the wrap list reads its counts; wrap links to people read the name only (not the avatar's initials); the drop's seller link and Share button have names; seller stats and game player chips read as one item each ("Waiting: 12", "X, Ada"); the display name is a header on profiles; the song-can't-play icon and decorative separators are hidden.
- **States:** scheduled message actions report disabled and busy; the playing queue item reports disabled; the chat look sheet's two groups are labelled.
- **Touch targets:** reaction chips, the pinned message's unpin button, the reminder line, chat search's close button, scheduled message actions, the profile song link and the cover edit button now reach 44pt (with `hitSlop` where the visual size stays smaller).
- **Announcements:** watch together's sync status and notices, drop phase changes and the Notify me result, Ask me results, the username check and tab moves are announced on iOS too (`AccessibilityInfo.announceForAccessibility`; Android keeps its live regions). The drop's minute-by-minute status line is no longer a live region.
- **Text size:** the app lets text grow freely. Where text sits in a fixed-size box it is now capped: `Button` labels at 2× (the button is a fixed 44pt or 36pt tall), X and O on the Noughts board and the featured post's number at 1.3× (their boxes are fixed; the label says the same thing).

The audit's setup now puts a second shop in place for the drop (a product waiting for a drop can't be bought yet, and it had become the first Buy button the checkout keyboard test pressed), and the run instructions set `PUBLIC_API_URL`: without it, media links point at port 4000, so photos and videos didn't load when the API ran on another port.

After the fixes: **464 audits, 0 violations** in every project, **232** right-to-left overflow checks and the **12 keyboard tests** passing in both layouts (production build, 2026-09-28).

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

All these names and announcements go through `t()`/`tp()`: the new ones (`m.music.useTitle`, `m.chat.reactionCount`, `m.chat.searchFound`, `m.chat.searchFoundMore`, `follow.titleFollowers`, `follow.titleFollowing`, `follow.followName`, `follow.followingName`, `m.reels.sound`) are in all 8 catalogs in `packages/shared/src/locales/`, and toggles use the existing key for their one name (for example `m.rooms.raiseHand`, `post.like`, `m.reels.repost`).

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

- **Newer features:** the start a game, send later, wallpaper and chess board checks are now in `keyboard.spec.ts` (run 2026-09-28, desktop and mobile, all passing); watch together is still checked by hand. A game move made by the other player while the board is open, and a drop opening while its page is open, are not exercised. The phone app was reviewed in code only, not with VoiceOver or TalkBack.
- **Touch targets:** 44px is checked on 32 pages and 4 open states (`targets.spec.ts`) and was scanned once on every page the axe suite opens; other open sheets and menus and pages not in the axe suite were not measured. The phone app was checked in code (`apps/mobile/scripts/check-targets.mjs` and by reading), not measured on a device. The chess board's squares are the size of the board (about 40px on a phone) and have no extra layer. Suggested replies reach 44px through `overflow-clip-margin`, which Safari doesn't support yet (there they stay 36px tall). Hovering near a small control now shows its hover state a few pixels early, since the layer is part of it.
- **Not audited automatically:** admin, real, onboarding, OAuth consent, password reset pages; the incoming-call and Mini App overlays (they need a second live session or a registered app); the video editor (it needs a real video decode in the browser); a room you host (speaking needs a microphone). They use the same components, but have not been run through axe.
- **Color contrast** is checked by axe on rendered text only. Text over photos, video and gradients (moment rings, story text and stickers, the music sticker, profile covers) is reported as "needs review" by axe, not as pass or fail, and has not been checked by hand. Icon-only buttons' 3:1 non-text contrast isn't checked by axe either (chat message tools are dimmed to 70% on touch screens).
- **Screen readers:** no manual pass with VoiceOver, TalkBack or NVDA yet. Toasts, chat search results, raised hands and loading lines use live regions; the conversation is a `role="log"` that announces new messages as they arrive (not yet confirmed with each screen reader).
- **Reduced motion:** transitions respect `prefers-reduced-motion` in the design system, and the new animations were reviewed (above), but the Real capture countdown and live video are not covered.
- **Mobile tab order:** on phones the bottom navigation comes before the page content in tab order (it is first in the DOM); the skip link jumps over it.
- **Localisation:** axe runs in English only. Right-to-left layout is checked for overflow automatically and was reviewed by eye on home, discover and settings at phone and desktop widths; a native Arabic or Hebrew reader hasn't reviewed it.
- **Nested dialogs:** stacking (focus and `inert`) is handled by `useModalFocus`, but only the sheet → sheet and sheet → dialog combinations exercised in code today have been tried.
- **Confirmations** before unsending a message or deleting a draft use the browser's `confirm()`, which is accessible but can't be styled or audited.
