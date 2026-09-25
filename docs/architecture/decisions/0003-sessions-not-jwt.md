# 0003: Opaque server-side sessions

**Status:** accepted, 2026-09-25

**Decision.** Log-in creates a random 256-bit token. The client keeps it (httpOnly, SameSite=Lax cookie on web; OS keychain on mobile). The database stores only its SHA-256 hash with device, IP and expiry.

**Why.** Sessions must be revocable instantly (log out everywhere, password reset, suspension, account deletion) and listable per device. JWTs make revocation hard.

**Consequences.** One indexed lookup per request (`last_seen_at` is written at most once a minute). Redis can cache sessions later if needed.
