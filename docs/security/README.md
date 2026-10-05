# Security

## Controls in place

| Area | Control | Where |
| --- | --- | --- |
| Passwords | scrypt (N=2^15, r=8, p=1), per-password salt, constant-time compare, equal timing for unknown accounts; after 10 wrong passwords in 15 minutes (from any address) an account waits; a reset or change ends every other reset link | `packages/auth`, `apps/api/src/modules/auth.ts` |
| Two-step verification | TOTP (RFC 6238, ±30 s), secrets encrypted with AES-256-GCM, 10 hashed single-use recovery codes, 5-minute login challenges locked after 5 wrong codes, disabling requires password + code | `apps/api/src/modules/mfa.ts`, `packages/auth/src/totp.ts` |
| API keys | Hashed, scoped read/write, revocable, never carry admin roles, blocked from auth, keys, exports, payouts, consents, AI memory, OAuth consent, family supervision, the privacy center and what identifies the account (email and phone, username, date of birth, sign-in alerts) | `apps/api/src/plugins/auth.ts` |
| Webhooks | HMAC-SHA256 signed with timestamp, https only in production, private/loopback addresses rejected at creation and on the delivery connection itself, no redirects followed | `apps/api/src/lib/webhooks.ts`, `lib/safe-fetch.ts` |
| Outside fetches | Every URL someone gives us is fetched through `safeFetch`: https only, public addresses only, checked on the connection itself (see below) | `apps/api/src/lib/safe-fetch.ts` |
| Sessions | 256-bit random tokens, only SHA-256 hashes stored, httpOnly + SameSite=Lax cookies (Secure in production); changes made with the cookie must come from `WEB_ORIGIN` (another origin of the same site gets 403, and can't open the realtime socket with it), expiry, per-device listing and revocation, revoke-all on password reset and suspension | `apps/api/src/modules/auth.ts` |
| Authorization | Every protected route uses `requireAuth` / `requireRole`; visibility enforced in shared SQL predicates; hidden content returns 404, not 403 | `plugins/auth.ts`, `lib/visibility.ts` |
| Input | zod validation on every body, query and path parameter; parameterized SQL only | `packages/shared/src/schemas.ts` |
| Abuse | Global and per-route rate limits (Redis-backed), stricter on auth, posting, messaging, reports, AI | `app.ts`, route configs |
| Caller address | `X-Forwarded-For` is only believed from proxies on loopback and private networks (`TRUST_PROXY`), so a caller can't write in a different address to get fresh rate limits or hide from sign-in alerts | `config.ts`, `test/trust-proxy.test.ts` |
| Uploads | MIME allowlist, magic-byte sniffing, 50 MB limit, random object keys | `modules/media.ts`, `lib/storage.ts` |
| Payments | No card data stored; HMAC-verified webhooks, event replay protection, amount reconciliation, idempotent orders | `modules/commerce.ts`, `lib/payments.ts` |
| Minors | Minimum age 13, private by default under 18 (private accounts approve each follower), no adult→minor DMs unless friends, immediate hiding on minor-safety reports | `modules/auth.ts`, `modules/messaging.ts`, `modules/safety.ts` |
| Audit | Moderation decisions, role and status changes, flags, consents, orders, refunds, payouts, account deletion | `audit_logs` table |
| Security events | Sign-ups, logins, failed logins, resets, session revocations, deletions (visible to the user) | `security_events` table |
| Logging | Authorization headers, cookies, passwords and tokens are redacted from logs | `app.ts` logger `redact` |
| Headers | nosniff, DENY framing, no-referrer (API), HSTS when `COOKIE_SECURE` | `app.ts`, `next.config.ts` |
| Production guard | API refuses to start in production with dev webhook secret or insecure cookies; seed refuses to run | `config.ts`, `seed.ts` |
| CI | gitleaks secret scanning, `pnpm audit`, CodeQL | `.github/workflows/ci.yml` |

## Not yet in place

- Passkeys (WebAuthn): not started; TOTP two-step verification is in place.
- Encryption at rest is delegated to the managed database and object store (enable it there).
- Malware scanning of uploads and image/video content classification.
- Content Security Policy on the web app (needs the final CDN and font origins).

## Fetching outside URLs

The API fetches addresses that people give it: webhook deliveries for developer apps and site icons
for profile links. Every such fetch goes through `safeFetch` (`apps/api/src/lib/safe-fetch.ts`);
nothing else may call `fetch`, `http.request` or `https.request` on a URL that came from a person.

- **https only**, no credentials in the URL. Plain http goes only to localhost, and only in
  development and tests.
- **Public addresses only.** Loopback, private, link-local (including cloud metadata at
  169.254.169.254), CGNAT (100.64.0.0/10), benchmarking, documentation, reserved, multicast and
  unspecified addresses are refused, in IPv4 and IPv6, including IPv4 written as IPv6
  (`::ffff:127.0.0.1`, `::ffff:7f00:1`) and IPv6 outside global unicast (`fc00::/7`, `fe80::/10`,
  NAT64). If a name resolves to several addresses and any one of them is private, it is refused.
- **Checked on the connection, not before it.** The host is looked up once, inside the connection
  (a `lookup` for `net.connect` that checks every answer), and the connection goes only to the
  addresses that were checked. There is no separate earlier lookup a hostile DNS server could
  answer differently (DNS rebinding). TLS still checks the certificate against the host name (SNI)
  and the Host header carries the name.
- **Redirects are followed by hand**, each hop checked like the first URL, up to the caller's limit
  (webhooks: none; link icons: 2). No connection is reused between requests.
- **Callers keep their own limits**: time limits through an abort signal, and size limits by
  reading the body as a stream (link icons stop at 32 KB).

Webhook URLs are also checked when they are saved, so a developer hears at once about one that
can't work, but only the check on the connection counts. The tests are in
`apps/api/test/safe-fetch.test.ts`, the link icon tests in `profile-style.test.ts` and the webhook
tests in `expansion.test.ts`. This closes finding 9 of the
[2026-09-28 review](review-2026-09-28.md).

## Reviews

- [2026-09-28](review-2026-09-28.md): the features added on 2026-09-27 and 28 (live location, Market, tickets, Echo, collages, Together, Mixes, covers, games, Ask me, drops, the export and deletion).

## Rules for contributors

Never commit secrets, never trust the client for authorization, never log credentials or payment data, never disable a security check to make a test pass. Report vulnerabilities privately to the security contact before disclosure.
