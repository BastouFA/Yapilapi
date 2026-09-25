# ADR 006: scrypt, opaque server-side sessions, TOTP MFA; passkeys deferred

Status: accepted. Scope: `apps/api/src/modules/auth`, `packages/security`

## Decision

- Passwords: scrypt (memory-hard, in Node's standard library, no native addon). Argon2id is a drop-in upgrade behind the hash-format prefix if native builds are acceptable in your deployment.
- Sessions are random opaque tokens; only a SHA-256 is stored, so a database leak does not yield usable sessions. Browsers get an `httpOnly` `yl_session` cookie plus a CSRF header and Origin check; mobile and third parties use `Authorization: Bearer`.
- MFA: TOTP with AES-256-GCM encrypted secrets, replay protection and HMAC-hashed recovery codes. Staff routes require an MFA-verified session.
- Escalating lockout, uniform login errors (no enumeration), new-device email, and all sessions revoked on password reset.
- Passkeys (WebAuthn): tables exist, endpoints are NOT implemented. Tracked as a gap.

## Consequences

Server-side sessions allow instant revocation at the cost of a database lookup per request (indexed, cached per request).
