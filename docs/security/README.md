# Security

## Controls in place

| Area | Control | Where |
| --- | --- | --- |
| Passwords | scrypt (N=2^15, r=8, p=1), per-password salt, constant-time compare, equal timing for unknown accounts | `packages/auth` |
| Sessions | 256-bit random tokens, only SHA-256 hashes stored, httpOnly + SameSite=Lax cookies (Secure in production), expiry, per-device listing and revocation, revoke-all on password reset and suspension | `apps/api/src/modules/auth.ts` |
| Authorization | Every protected route uses `requireAuth` / `requireRole`; visibility enforced in shared SQL predicates; hidden content returns 404, not 403 | `plugins/auth.ts`, `lib/visibility.ts` |
| Input | zod validation on every body, query and path parameter; parameterized SQL only | `packages/shared/src/schemas.ts` |
| Abuse | Global and per-route rate limits (Redis-backed), stricter on auth, posting, messaging, reports, AI | `app.ts`, route configs |
| Uploads | MIME allowlist, magic-byte sniffing, 50 MB limit, random object keys | `modules/media.ts`, `lib/storage.ts` |
| Payments | No card data stored; HMAC-verified webhooks, event replay protection, amount reconciliation, idempotent orders | `modules/commerce.ts`, `lib/payments.ts` |
| Minors | Minimum age 13, private by default under 18, no adult→minor DMs unless friends, immediate hiding on minor-safety reports | `modules/auth.ts`, `modules/messaging.ts`, `modules/safety.ts` |
| Audit | Moderation decisions, role and status changes, flags, consents, orders, refunds, payouts, account deletion | `audit_logs` table |
| Security events | Sign-ups, logins, failed logins, resets, session revocations, deletions (visible to the user) | `security_events` table |
| Logging | Authorization headers, cookies, passwords and tokens are redacted from logs | `app.ts` logger `redact` |
| Headers | nosniff, DENY framing, no-referrer (API), HSTS when `COOKIE_SECURE` | `app.ts`, `next.config.ts` |
| Production guard | API refuses to start in production with dev webhook secret or insecure cookies; seed refuses to run | `config.ts`, `seed.ts` |
| CI | gitleaks secret scanning, `pnpm audit`, CodeQL | `.github/workflows/ci.yml` |

## Not yet in place

- MFA (TOTP) and passkeys: schema exists; enrolment needs `MFA_ENCRYPTION_KEY` and a WebAuthn relying-party id.
- Encryption at rest is delegated to the managed database and object store (enable it there).
- Malware scanning of uploads and image/video content classification.
- Content Security Policy on the web app (needs the final CDN and font origins).

## Rules for contributors

Never commit secrets, never trust the client for authorization, never log credentials or payment data, never disable a security check to make a test pass. Report vulnerabilities privately to the security contact before disclosure.
