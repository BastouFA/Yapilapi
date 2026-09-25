# ADR 007: authorization is enforced server-side, in the query, and fails closed

Status: accepted. Scope: whole API

## Decision

1. The frontend is never trusted. Web, admin and mobile only hide UI; the API is the enforcement point.
2. Every route declares its authentication class (`public | optional | user | staff:[roles]`) in one place; missing declarations do not compile.
3. Visibility of posts, moments, media, communities, events and profiles is computed by shared SQL predicates that account for blocks (both directions), private accounts, audience lists, community membership, subscriber tiers, teen safety defaults and moderation state.
4. Resources a caller may not see return 404, not 403, so existence is not leaked.
5. Staff actions require an MFA-verified session and are appended to an append-only audit log (`forbid_mutation()` trigger).
6. AI acts as the requesting user: the Permission Engine evaluates the same rules before any content enters a prompt (ADR 009).

## Verification

Each module ships an authorization-matrix integration test (owner / other user / blocked user / staff / anonymous) against a real database.
