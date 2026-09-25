# Communities module

Code: `apps/api/src/modules/communities/` (`index.ts` routes, `service.ts` shared rules and exported services). Tests: `apps/api/test/communities.test.ts`. Migration: `110_community_channels.sql`.

## Model

- `communities` (visibility `public|private|secret`, join policy `open|request|invite`, `rules` jsonb, paid settings), `community_roles` (system roles seeded from `SYSTEM_COMMUNITY_ROLES`, custom roles per community), `community_members` (status `active|pending|invited|banned|left`), `community_topics`, `community_resources`, `community_decisions`, channels as `conversations` rows (`kind = 'community_channel'`).
- `member_count` is recomputed from `community_members` inside the mutating transaction (community row locked `FOR UPDATE`), so it cannot drift.
- Invitations are `community_members` rows with status `invited`; join requests are rows with status `pending`.

## Access rules

| Viewer                 | public                                                    | private                                 | secret                                                |
| ---------------------- | --------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| anonymous / non-member | full detail, feed, resources, decisions                   | summary only (no rules), 403 on content | 404                                                   |
| pending / invited      | as non-member                                             | summary                                 | invitee sees summary (so they can accept); others 404 |
| banned                 | detail visible, no membership, feed hides community posts | summary                                 | 404                                                   |
| active member          | full                                                      | full                                    | full                                                  |

Secret communities are always invite-only. Member lists, channel lists and the moderation queue are members-only; non-active member listings (`pending|invited|banned`) need `manage_members` or `moderate`. Non-members never see teen members in member lists.

Every member-affecting action checks a permission and the rank hierarchy (actor rank must be strictly greater than the target's). Roles may only carry permissions the creator holds and rank below the creator's; system roles are immutable; ownership moves only through `transfer-ownership`.

## Teens (`ageBand = 'teen'`)

Teens may only create **private** communities (never public or secret, never paid), cannot make a community public/secret/paid via settings, cannot join or accept invitations to secret communities (invitations to secret communities are hidden from their inbox), and are hidden from member lists shown to non-members. Adult owners/moderators are always visible to members, so moderation stays visible.

## Endpoints

Create/read: `POST /v1/communities`, `GET /v1/communities` (browse public: `topic`, `q`, `language`, keyset), `GET /v1/communities/:id` (id or slug), `PATCH|DELETE /v1/communities/:id`, `GET /v1/communities/:id/feed`, `GET /v1/me/communities`, `GET /v1/me/community-invitations`.
Membership: `POST :id/join|leave`, `GET :id/members?status=`, `DELETE :id/members/:userId` (kick), `POST|DELETE :id/members/:userId/ban`, `POST :id/requests/:userId/approve|reject`, `POST :id/invitations`, `POST :id/invitation/accept|decline`, `POST :id/transfer-ownership`.
Roles: `GET|POST :id/roles`, `PATCH|DELETE :id/roles/:key`, `PUT :id/members/:userId/role`.
Governance: `GET|POST :id/resources`, `PATCH|DELETE :id/resources/:rid`, `PUT :id/resources/:rid/pin`, `GET|POST :id/decisions`, `PATCH|DELETE :id/decisions/:did` (authoring needs `moderate` or `manage_settings`).
Channels: `GET|POST :id/channels`, `PATCH :id/channels/:cid` (rename, archive/unarchive; `manage_channels`). A `general` text channel is created with the community. The messaging module owns messages; it must treat `conversations.archived_at IS NOT NULL` as read-only and derive channel access from active `community_members`.
Moderation: `GET :id/moderation/queue?state=pending_review|restricted`, `POST :id/moderation/posts/:postId/approve|reject`, `DELETE :id/posts/:postId`, `DELETE :id/comments/:commentId` (all `moderate`; audited; author notified). Approving does not close the platform-level `moderation_cases` row; platform staff keep that queue. `escalated` content is platform-only.

## Exported services (`modules/communities/index.ts`)

- `grantCommunityMembership(ctx, communityId, userId)`: idempotent, refuses banned users and teens-into-secret. **The only way into a paid community.** For the payments module to call after a confirmed payment.
- `listCommunityKnowledge(ctx, communityId, viewerId)`: rules + resources + decisions/FAQ for the community AI; returns `null` unless the viewer is an active member. Only human-authored content.
- `removeUserFromCommunities(tx, userId)`: body of the registered deletion hook. Ownerless communities pass ownership to the highest-ranked remaining active member (longest-standing on ties); sole-member communities are soft-deleted; all membership rows for the user are removed.

## Paid communities: known gap

Configuration is real (`isPaid`, `priceCents`, `currency`; owner only; needs the `COMMERCE` flag; teens cannot). No payment flow exists in this module. `POST :id/join` and `POST :id/invitation/accept` on a paid community respond **402** with error code `payment_required` and `details { priceCents, currency }` (new `ErrorCode` in `@yapilapi/shared`); managers cannot approve requests around the paywall. Nothing pretends to succeed. Until the payments module calls `grantCommunityMembership` after a successful charge, paid communities effectively cannot gain members; do not enable them for real users before then. Renewal/expiry/refund handling (removing access when a subscription lapses) is also not implemented.

## Migration 110

Adds `conversations.archived_at`, makes the channel-name uniqueness apply to live channels only, and changes `communities.created_by`, `community_resources.created_by`, `community_decisions.decided_by` to nullable `ON DELETE SET NULL` so account deletion neither fails on nor cascades away governance data.

## Limits and notes

Keyset cursors use millisecond timestamps (same as the other modules). Caps: 24 roles, 50 live channels, 20 rules, 10 topics per community. Slugs that look like UUIDs or collide with reserved words are refused.
