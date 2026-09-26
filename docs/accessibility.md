# Accessibility

YAPILAPI targets **WCAG 2.2 AA**. Two automated suites in `apps/web/e2e/` guard it, and CI runs both (`accessibility` job in `.github/workflows/ci.yml`).

## How to run the audit

The suites need a running API and web app. Use your own ports and a scratch database, never the development one:

```bash
# API against a scratch database (APP_ENV=test lifts rate limits for the sign-ups)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/yapilapi_a11y pnpm db:migrate
APP_ENV=test API_PORT=4100 DATABASE_URL=postgres://postgres:postgres@localhost:5432/yapilapi_a11y pnpm dev:api

# Web app pointed at it (a production build gives the most faithful results)
cd apps/web
API_INTERNAL_URL=http://127.0.0.1:4100 NEXT_PUBLIC_WS_URL=ws://127.0.0.1:4100/v1/realtime npx next build
API_INTERNAL_URL=http://127.0.0.1:4100 npx next start --port 3100

# Once: the browser
pnpm --filter @yapilapi/web exec playwright install chromium

A11Y_BASE_URL=http://localhost:3100 pnpm --filter @yapilapi/web test:a11y
node apps/web/e2e/summary.ts            # counts by project and rule (--details for every element)
```

`e2e/global-setup.ts` signs up two fresh users through the web app's `/api` proxy (random throwaway passwords, nothing typed by hand) and gives the main user a post, a community, a place, an event hosted by the other user, a conversation and notifications, so every page has real content to audit.

### What is checked

**`a11y.spec.ts`**: axe-core (`@axe-core/playwright` 4.13) with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice` rule sets (contrast, names and labels, ARIA validity, landmarks, heading order, target size, document language and title…) on 19 pages:

landing, login, signup, home, discover, create, inbox, a conversation, profile, community, event, place, settings, studio, notifications, a single post, events, assistant, live

in four projects: **desktop** (1440×900) and **mobile** (Pixel 7, 412×915, touch) × **light** and **dark** color schemes. That is 76 page audits; each must have zero violations. The page is audited after network idle, after loading states (`aria-busy`) clear and after finite animations finish.

**Right-to-left:** every signed-in page is loaded with `dir="rtl"` in all four projects and must not be wider than the viewport. (An offscreen skip link placed with `left: -9999px` once made every page scroll to blank space in RTL.) The design system uses logical properties (`inset-inline-*`, `margin-inline-*`, logical corner radii), mirrors directional icons, and marks user-written text with `dir="auto"` / `<bdi>` so mixed-direction names, handles, tags and messages read correctly.

**`keyboard.spec.ts`** (desktop and mobile layouts):

- The first Tab reaches a visible "Skip to content" link; following it puts the next Tab inside `main`. The primary navigation is reached next, in visual order, with `aria-current="page"` on the current destination.
- Post options **menu**: Enter opens it on the first item, arrows/Home/End move with wrap-around, ArrowUp opens on the last item, Escape closes it and returns focus to the button, Tab closes it.
- Comments **bottom sheet**: focus moves into it, Tab and Shift+Tab stay inside, Escape closes it and focus returns to the Comments button. The open sheet is audited with axe.
- **Checkout** sheet: opens from a Buy button, focus moves in and stays in, the open sheet and the paid state are audited with axe, Escape closes it.
- Delete-account **dialog** and settings **tabs**: arrows and Home/End move between tabs, the dialog traps focus, closes on Escape and returns focus to its button. The open dialog is audited with axe.

## Results (2026-09-26)

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
| `NavBar` | Unread badge read as a bare number ("Inbox 3") | "Inbox, 3 unread" (badge hidden from screen readers, text visually hidden) |
| Menu items, moments | Focus shown only as a faint background change / browser default | Focus ring (`--focus-ring`) |
| Post composer, message composer | Textarea outline removed with no replacement | The surrounding box shows the focus ring while the textarea has focus |
| Call and Mini App overlays (`role="dialog"` in the web app) | No focus handling | `useModalFocus` (the call overlay deliberately has no Escape: it must not hang up by accident) |

## Remaining known issues

- **Not audited automatically:** admin, developers, real/together, memories, onboarding, OAuth consent, password reset and business pages; the incoming-call and Mini App overlays (they need a second live session or a registered app); media uploads and the media viewer (the seed has no media). They use the same components, but have not been run through axe.
- **Color contrast** is checked by axe on rendered text only. Text over images and gradients (moment rings, media) is reported as "needs review" by axe, not as pass or fail, and has not been checked by hand.
- **Screen readers:** no manual pass with VoiceOver, TalkBack or NVDA yet. Live regions exist for toasts and the AI panel; the conversation is a `role="log"` that announces new messages as they arrive (not yet confirmed with each screen reader).
- **Reduced motion:** transitions respect `prefers-reduced-motion` in the design system, but the Real capture countdown and live video are not covered.
- **Mobile tab order:** on phones the bottom navigation comes before the page content in tab order (it is first in the DOM); the skip link jumps over it.
- **Localisation:** axe runs in English only. Right-to-left layout is checked for overflow automatically and was reviewed by eye on home, discover and settings at phone and desktop widths; a native Arabic or Hebrew reader hasn't reviewed it.
- **Nested dialogs:** stacking is handled by `useModalFocus`, but only sheet → dialog combinations exercised in code today have been tried.
