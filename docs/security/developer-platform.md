# Developer platform

Scope: `apps/api/src/modules/developer`, migration `195_developer.sql`, `scripts/deliver-webhooks.ts`. Tests: `apps/api/test/developer.test.ts`,
`apps/api/src/modules/developer/developer.unit.test.ts`.

## Who can build

Only adult accounts register apps (max 10 per account, 5 active API keys and 5 webhook endpoints per app). **Teen and minor accounts cannot connect
third-party apps and are never exposed through the public API**, whichever credential is used.

## Credentials

| Kind          | Prefix  | Stored as | Notes                                                                                       |
| ------------- | ------- | --------- | ------------------------------------------------------------------------------------------- |
| API key       | `ylk_`  | SHA-256   | shown once at creation; scope `public:read`; per-key rate limit; revocable; expiry optional |
| Client secret | `ylcs_` | SHA-256   | confidential clients only; rotatable (old secret stops working immediately)                 |
| Access token  | `ylat_` | SHA-256   | 1 hour                                                                                      |
| Refresh token | `ylrt_` | SHA-256   | 30 days, rotated on every use                                                               |

Nothing secret is ever logged or returned again after creation. The prefixes make leaked secrets greppable by secret scanners.

## OAuth 2.0 authorization code + PKCE

- `GET /v1/oauth/scopes`, `GET|POST /v1/oauth/authorize`, `POST /v1/oauth/token`, `POST /v1/oauth/revoke` (RFC 7009).
  Scopes: `profile:read`, `posts:read` (read-only; nothing can act on the user's behalf).
- **PKCE with S256 is mandatory for every client**, public or confidential. `plain` is rejected. The challenge must be a 43-character base64url digest.
- Redirect URIs must match a registered value exactly (no wildcards, no prefix matching); https only (plain http is accepted for loopback hosts, for local development). Errors about the client or
  redirect are never redirected (RFC 6749 4.1.2.1).
- The consent screen data comes from the server: app name, developer, exact scopes. The user approves through an authenticated POST; the approval is audited.
- Codes are single-use, valid 10 minutes, bound to client, redirect URI and challenge, and consumed atomically. **Replaying a used code revokes every token issued from it.**
- **Refresh tokens rotate**; presenting an already-rotated token is treated as theft and revokes the whole grant.
- Token responses are `no-store`. Client authentication via body or HTTP Basic.
- Users list and revoke grants under Privacy > Connected apps; revoking a grant kills its tokens at once and emits `authorization.revoked`.

## Public API

`GET /v1/public/users/:username`, `GET /v1/public/users/:username/posts`, `GET /v1/public/me`, `GET /v1/public/me/posts`. Bearer key or access token.
Only **adult, active, non-private accounts and public, moderation-approved posts** are visible; everything else is 404. Responses are a fixed, minimal
projection (no email, birth date, location, follower lists). Rate limits are per credential (key setting, or 300/min per OAuth token) with `429` and `Retry-After`.

## Webhooks

Events: `ping`, `post.created` (public posts of users who authorised the app), `authorization.revoked`. Signature header `t=<unix>,v1=<hex>` =
HMAC-SHA256 of `t.body` with the endpoint secret; receivers should reject timestamps older than 5 minutes. Secrets are encrypted at rest (AES-GCM, bound to the endpoint id).

Delivery: retries at 1m, 5m, 30m, 2h, 6h, 12h (7 attempts max); 4xx (except 408/429) is a permanent failure; an endpoint is **disabled after 20
consecutive failures** and the owner is notified. Each delivery has a stable id for idempotency. Rows are claimed with `SKIP LOCKED`, so the worker can run concurrently.

### SSRF protections (defence in depth)

1. **URL validation at registration**: `https` only, ports 443/8443 only, no credentials in the URL, no `localhost`/`.local`/`.internal`/`.lan`/... names, no single-label hosts,
   literal IPs must be public. IPv4 blocks: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24,
   203.0.113/24, 224/4, 240/4. IPv6 blocks: `::`, `::1`, IPv4-mapped/compatible/NAT64 and 6to4 (checked against the embedded IPv4), unique-local, link-local, site-local,
   multicast, documentation, Teredo. Unparseable addresses fail closed. Decimal/hex/octal IPv4 spellings are normalised before checking.
2. **DNS resolution, all answers**: the hostname is resolved and _every_ answer must be public (one private A record poisons the host).
3. **Pinned connection**: the request connects to the validated address (TLS SNI and Host stay the hostname); the OS resolver is not consulted again.
4. **No redirects** are followed.
5. **Re-validation on every delivery**, so a hostname that turns into an internal address after registration (DNS rebinding) is refused at send time.
6. Hard 5 second timeout; at most 64 KiB of response is read (then the connection is dropped) and the body is never stored: only the status code and a short error string are kept.

## Mini-apps

Behind the `MINI_APPS` feature flag (off). Developers submit a manifest (name, entry URL, permissions from a closed list); staff with `miniapps.review` approve or reject
(`PUT /v1/staff/mini-apps/:id/review`, audited); users install/uninstall approved ones. **There is no sandboxed runtime yet**, so nothing executes a mini-app: this
module manages the catalog, review and installs only, and the flag must stay off until a sandbox (iframe with CSP, message bridge) exists.

## Endpoints

Developer: `/v1/developer/apps*` (CRUD, rotate-secret, keys, webhooks, deliveries, test, mini-apps), `/v1/developer/webhooks/*`, `/v1/developer/webhook-events`.
OAuth: `/v1/oauth/*`. Public: `/v1/public/*`. Users: `/v1/mini-apps*`, `/v1/privacy/connected-apps*`. Staff: `/v1/staff/mini-apps*`.

## Gaps

- **Token endpoint and CSRF:** the app-wide origin check cannot be edited from this module; a browser SPA acting as an OAuth client from a non-allow-listed origin
  is refused. Server-side and native clients are unaffected. Fix: allow-list per-app origins in the global hook.
- Mini-app runtime/sandbox is absent (see above). Webhook `post.created` is the only content event; no edits/deletes yet.
- No per-app usage analytics or billing; rate limits are per minute only.
- Scopes are read-only by design; write scopes need a separate threat review (spam, consent screens, per-app rate limits).
- Webhook egress should additionally be forced through a network egress proxy in production (defence against resolver bugs).
- Client-credentials grants and app-to-app tokens are not implemented.
