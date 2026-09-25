# Admin console (`apps/admin`)

Internal staff console for YAPILAPI. Next.js 15 App Router, TypeScript strict, port **3100**
(`npm run dev:admin`, `npm run build:admin`). It is a client of the existing API only: `/v1/admin/*`,
`/v1/staff/*`, `/v1/auth/*`. No endpoint was invented. Where the API has no endpoint, the view shows an
honest empty state and the gap is listed below.

## Architecture

- `packages/api-client` exposes `client.admin.*` (me, users, content, moderation, communities,
  businesses, creators, payments, fraud, ai, analytics, audit, flags, system, miniApps). The admin types
  are hand-maintained (see gaps).
- `src/app/(auth)/login` is the only public route. Everything under `src/app/(console)` is gated on the
  server in `layout.tsx` by `getServerSession()`, which forwards the httpOnly cookie to `/v1/auth/me` and
  `/v1/admin/me`. An API outage renders "unavailable", not "signed out".
- Pages are thin server components that wrap a client view in `Guard`. Views live in `src/views`.
- `MutationDialog` (`components/common.tsx`) is the only path for state-changing actions. It requires an
  audited reason (min 3 chars), a typed confirmation phrase for destructive actions (remove content,
  suspend/ban, kill switch, and similar), and on failure stays open and shows the API message and request id.

## Auth and MFA

Password, then authenticator code (or recovery code), against the API's own endpoints. The API requires an
MFA-verified session on staff routes; the console does not store tokens (httpOnly cookie only). `?next=` is
validated by `lib/redirect.ts` (same-origin, path-only) to prevent open redirects.

## Roles and navigation

Roles: support < moderator < admin < superadmin. `lib/nav.ts` `visibleNav()` and `Guard` hide links and
pages the role cannot use. This is cosmetic. The API is the enforcement point, and a 403 is rendered as a
plain "not allowed" state. Tests use the real permission matrix parsed from
`apps/api/src/modules/admin/rbac.ts`, so nav tests cannot drift from the API.

## Security

- CSP with a per-request nonce in `src/middleware.ts`: no `unsafe-inline` or `unsafe-eval` in production,
  `style-src 'self'`, `connect-src` limited to self and the API origin, `frame-ancestors 'none'`.
- `next.config.mjs`: HSTS, COOP/CORP same-origin, nosniff, `X-Frame-Options: DENY`, no-referrer,
  Permissions-Policy, `no-store`, `noindex`, no `X-Powered-By`.
- No inline styles anywhere (charts use CSS classes). No `localStorage` for data. No secrets in the client
  bundle: the only public value is the API base URL.
- No PII logging. `app/error.tsx` logs only the error digest. A test scans sources for `console.*`.
- Analytics privacy is preserved: cells under 5 arrive as `null` and render "Hidden (fewer than 5)", never 0.

## i18n

Typed catalogs: `en` is complete (about 1000 keys, split by area under `i18n/messages`). Keys and
`{placeholders}` are checked at compile time. `fr`, `ar` and `yo` are partial overrides that fall back to
English per key. Locale is a cookie (`yl_admin_locale`) or Accept-Language; the layout sets `lang` and
`dir`, and Arabic is RTL. CSS uses logical properties only (enforced by a test). A test fails on
hardcoded user-facing strings in components.

Status: **fr (about 200 keys), ar (about 200, with full plural forms) and yo (about 90) are machine-drafted
and need native review before staff rely on them.** Yoruba is deliberately small.

## Accessibility

Labelled controls, keyboard-operable dialogs with focus return, live regions for toasts, scrollable table
regions with unique names, logical-property layout for narrow screens. `a11y.test.tsx` runs axe-core in
jsdom on the login steps, dashboards, tables, case detail and the decision dialog.

## Testing

`npm test -w @yapilapi/admin`: vitest + jsdom + Testing Library + user-event + axe-core. 179 tests in 18
files: i18n catalogs (parity, placeholders, fallbacks), lib, MutationDialog, LoginFlow, Shell/nav, charts,
CaseDetail, UserDetail, Flags, page smoke tests per role, a11y, and a security/hygiene suite that checks
CSP, headers, port, no console, no inline styles and no hardcoded strings.

## Gaps (honest list)

1. **No browser e2e.** Playwright was dropped; coverage is jsdom, RTL and axe. There is no live contract
   test against a running API, so the hand-maintained admin types in `packages/api-client` are checked only
   against reading the API source.
2. **axe `color-contrast` is not run** (jsdom has no layout/paint). Contrast needs a real-browser pass.
3. **Flags cannot be created or deleted**: the API has no such endpoints. The console edits rollout,
   kill switch and overrides only.
4. **Some actions accept no reason, so nothing is audited for them**: deleting a flag override and
   `unblockMedia`. The UI asks for a typed confirmation only.
5. **No staff-role management and no MFA/session management page**: no list or edit endpoints for staff
   roles, and no way to list or revoke sessions or reset MFA.
6. **User search needs a query**; there is no listing endpoint.
7. **No bulk actions** on reports or cases, and **no strike-ladder editing** (the ladder is displayed and
   the recommendation shown, not configurable).
8. **No dashboard export or alerting.**
9. **Mini-apps view depends on the `MINI_APPS` flag**; when off, it shows an empty state.
10. `/v1/staff/fraud-signals` returns no cursor, so the fraud list cannot page beyond one response.
11. Impersonation check (Identity tab) is a lookup only; it does not act on matches.
12. Machine-drafted fr/ar/yo (see i18n).
