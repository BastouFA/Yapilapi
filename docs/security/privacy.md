# Privacy center

Scope: `apps/api/src/modules/privacy`, `apps/api/src/modules/analytics` (consent side), migration `191_privacy.sql`, `scripts/finalize-deletions.ts`.
Tests: `apps/api/test/privacy.test.ts`.

## Consent

Five purposes: `personalization`, `ai_processing`, `ai_memory`, `advertising`, `analytics`. Defaults are privacy-preserving: everything is **opt-in**
except personalised recommendations for adults.

- **Append-only.** `consents` rows are never updated or deleted (a database trigger refuses both, tested). A change inserts a new row; the latest wins.
  Each row records purpose, decision, timestamp and the policy version shown. `GET /v1/privacy/consents/history` returns the full trail.
- **One question, `hasConsent(ctx, userId, purpose)`.** Every module that processes personal data for a purpose (AI, ads, analytics, recommendations)
  asks it. `user_preferences.personalization` remains the source of truth for the feed/search switch and is kept in sync by `setConsent`.
- **Teens cannot grant** `ai_memory`, `advertising`, `analytics` (`teenCanGrant: false`): `hasConsent` returns false and the API refuses the change.
- **Revoking analytics** also detaches existing analytics events from the account (`user_id` set to NULL).

## Endpoints

`GET /v1/privacy/overview` (what we hold, why, for how long), `GET|PUT /v1/privacy/consents[/:purpose]`, `GET /v1/privacy/consents/history`,
`GET|PUT /v1/privacy/advertising`, `GET /v1/privacy/visibility` (who can see what, derived from the real settings, not a copy),
`POST /v1/privacy/export`, `GET /v1/privacy/requests`, `POST /v1/privacy/requests/:id/download-link`, `GET /v1/privacy/requests/:id/download`,
`GET /v1/privacy/connected-apps`, `DELETE /v1/privacy/connected-apps/:id` (revokes an OAuth grant). Deletion is scheduled through
`POST /v1/account/deletion` (auth module) and finalised here.

## Data export

- Modules register _export sections_ (`registerExportSection`); the archive is assembled from all of them. **A failing section fails the export**: an
  incomplete archive must never look complete. Tests assert the archive's contents (and that `buildExport` is exactly what the endpoint serves).
- Only **the requester's own data**: messages they sent (not replies from others), their reactions, their reports. Other people's content, and staff
  notes about the account, are excluded. Tests seed a second user and assert none of their data appears.
- The archive is stored gzipped with a SHA-256 checksum in `privacy_exports` (protected by the database's own encryption at rest; there is no per-archive key), with a 72 hour expiry; one export per 24 hours. Download needs a fresh 10-minute link, requires the
  signed-in owner, and is audited. Expired archives are purged by the finalizer script.

## Account deletion

1. `POST /v1/account/deletion` (auth module) moves the account to `pending_deletion` with a 14-day grace period; `POST /v1/account/deletion/cancel` restores it.
2. `scripts/finalize-deletions.ts` (hourly) finds accounts past the grace period and, **per account in one transaction**: runs every module's
   deletion hook, anonymises `users`/`profiles`, deletes credentials (sessions, MFA, tokens, passkeys, push tokens, OAuth grants, API keys), completes the request.
   A failure rolls back and the account stays pending for the next run. The script assembles the app first so every module's hook is registered
   (a partial hook list would leave data behind).
3. Messages they sent are blanked (others keep a "deleted message" placeholder); graph edges are removed and the other side's counters corrected;
   content is removed or anonymised; free-text and location are erased.

**Retained after deletion, and why:** audit logs and consent evidence (pseudonymous ids only; legal accountability), moderation cases, reports,
enforcements and appeals (safety and legal obligations), orders/payments/ledger (financial record keeping; the delivery address is erased),
other users' content that merely mentions the account. Analytics events are detached from the user id.

## Connected apps and advertising

Users see every third-party app they authorised (scopes, when, last used) and can revoke instantly: the grant and all its tokens die in one statement.
Personalised advertising is off by default, unavailable to under-18s, and independent of the analytics consent.

## Minors

Teen accounts: private by default, discovery off, messages from friends only, no personalised ads, no analytics, no third-party apps or public API
exposure, guardian links (see `trust-and-safety.md`), quiet hours 22:00-07:00 by default for notifications.

## Notifications (privacy relevant)

Push payloads are content-free (kind and counts only, never message text or names). Security and moderation notices cannot be disabled in-app and bypass quiet hours.
Email digests contain counts per category, never content.

## Gaps

- Consent copy is not localised and has no versioned re-prompt when the policy text changes.
- Export covers the API's tables; files in object storage are listed, not bundled.
- "Right to rectification" is served through the normal edit screens, there is no request workflow.
- No data-processing-agreement tooling for developers; the developer platform relies on the terms and the scope limits.
- Backups are outside the deletion transaction; restore procedures must re-run the finalizer.
