# Live

Scope: `apps/api/src/modules/live`, migration `245_live.sql`, `scripts/live-maintenance.ts` (`npm run live:maintenance`). Feature flag **`LIVE`, off by default**: with the flag off every endpoint, including the WebSocket upgrade, answers `404 feature_disabled`.
Tests: `modules/live/rules.unit.test.ts` (17 pure rules), `apps/api/test/live.test.ts` (26 on real Postgres, including real WebSocket connections).

## Two modes, honestly

- **`interactive`** sessions (chat, reactions, polls, Q&A, gifts, shopping, tickets) work with **no media server at all**.
- **`video`** sessions need an `IngestProvider` (`runtime.ts`). This repository ships only the `none` provider, so starting a video session answers `501 feature_disabled / ingest_unavailable` and the session stays `scheduled`. A provider creates the stream on start; its `streamKey` is returned to the host **once** and never stored (only the provider's opaque `ref` is). There is no WebRTC/RTMP/HLS stack here and nothing pretends to carry video.

## Endpoints (`/v1/live`)

Sessions: `GET live` (on air / scheduled / ended I may see), `GET live/mine`, `POST live`, `GET|PATCH live/:id`, `PATCH live/:id/settings` (chat on/off, slow mode, blocked terms), `POST live/:id/start|end|cancel`.
Team: `GET live/:id/team`, `PUT|DELETE live/:id/team/:userId` (co-host or moderator, host only).
Audience: `POST live/:id/join|leave`, `GET|POST live/:id/messages`, `DELETE live/:id/messages/:mid`, `POST|GET live/:id/reactions`, polls (`GET|POST live/:id/polls`, `POST .../:pid/vote|close`), Q&A (`GET|POST live/:id/questions`, `PUT|DELETE .../:qid/upvote`, `POST .../:qid/answer`, `DELETE .../:qid`).
Moderation: `GET live/:id/moderation`, `PUT|DELETE live/:id/participants/:userId/mute|ban`.
Commerce: `GET live/:id/commerce`, `GET live/:id/products`, `PUT|DELETE live/:id/products/:productId`, `PUT|DELETE live/:id/products/:productId/pin`.
Extras: `POST|GET live/:id/markers`, `POST|GET live/:id/clips`, `POST live/:id/recording`, `POST live/:id/clips/:cid/studio`, `POST live/:id/translate`.
Staff: `GET staff/live/:id`, `POST staff/live/:id/end` (reason mandatory, audited), `POST staff/live/maintenance`.
Realtime: `GET /v1/live/:id/ws?ticket=...` (WebSocket).

## Design

**Lifecycle.** `scheduled -> live -> ended | cancelled` (`rules.canTransition`). One live session per host at a time (advisory lock). Ending removes everyone from the room, closes open polls, releases the ingest stream and tells every socket. The host, any co-host, or staff can end a session; the maintenance job ends sessions left running for 12 h and cancels no-shows 24 h after their scheduled time.

**Roles** (`rules.ts`, unit-tested matrix): `host` everything; `cohost` runs the room and may end it, but cannot start/cancel/edit, change the team or attach recordings; `moderator` mutes, bans, removes chat/questions and answers questions; `audience` chats, reacts, asks, votes. Moderation goes down a ladder only (`outranks`): nobody can act on the host or on an equal.

**Who can see a session** is one SQL predicate, `liveVisibleSql` (`access.ts`), used by the list, the detail view, chat, and gifting: host and appointed team always; otherwise the host must be active, no block in either direction, and `public` (not a private profile, or followed) / `followers` / `subscribers` (entitled subscription, same rule as `postVisibleSql`) / `private` (team only). Hidden and missing are both `404`. Cancelled sessions are hidden from non-team. A banned participant gets 404 for that session.

**Tickets** ride on the events module: a session may reference a ticket type of an event the host runs. Join, chat, history and gifting need an active `event_ticket_grants` row; entitlement is re-checked on **every** action, so a released ticket closes the room. Tickets are sold through the existing event/checkout flows (`GET live/:id/commerce` points to them).

**Chat safety.** Every message passes: role, mute, chat on/off, blocked terms (host-defined, folded for case/accents/leetspeak), `classifyText` from `packages/moderation`, and slow mode (serialised per person with an advisory lock so parallel requests cannot dodge it). People you blocked (or who blocked you) are filtered out of history and of your socket. Chat lines also go through the same rules when sent over the WebSocket.

**WebSocket** (`ws.ts`): same single-use `ws_tickets` scheme as `/v1/ws` (`POST /v1/ws/ticket`); origin, ticket, flag, visibility, on-air and ticket entitlement are all checked _before_ the upgrade. Connecting joins the room and the last socket closing leaves it (presence follows the socket). Events on `live:<id>` are forwarded from a whitelist and stamped with `liveId`; a ban closes that person's socket (`4403`), a block or lost access is caught by the heartbeat re-check (`4404`), floods close with `1008`.

**Gifts and subscriptions during a live.** `assertLiveGiftable(ctx, viewerId, liveId, recipientId)` (`access.ts`) is the seam the creator module imports dynamically: the session must be visible to the viewer and on air, the viewer not banned/blocked and holding the ticket, and the recipient the host or a co-host. Money handling stays in the creator module (teens cannot purchase). The creator module publishes a `gift` event on `live:<id>` when the gift settles; subscriptions use the ordinary creator subscribe flow (`GET live/:id/commerce` returns the plans).

**Live shopping.** Only products the _host_ sells (own, or a business they own/manage) and that are active; one pinned product at a time (partial unique index plus a row lock); with `COMMERCE` off the shelf is empty but the room keeps working.

**Clips and recordings.** Markers and clip ranges are recorded against session time. A recording exists only if the host attaches their own uploaded media after the session ended (`POST live/:id/recording`); `POST .../clips/:cid/studio` then creates a Studio project with the clip as a trim and stops there (nothing is published). Without a recording it answers `409 no_recording`.

**Translation hook.** `TranslationProvider` (optional). With none: `501 translation_unavailable`. It only translates messages the caller may see.

**Privacy.** Export section `live`; deletion hook ends sessions the user hosted, removes their messages and questions.

## Honest gaps

- **No video.** No ingest/transport implementation and no server-side recording; `video` mode needs a provider, `interactive` mode is complete.
- **No translation provider ships.**
- Reactions are aggregate counters (no per-person feed) and gifts are not persisted as chat lines (late joiners do not see past gift animations; the gift ledger has them).
- Presence/viewer count is per process: with several API instances a crashed instance can leave viewers counted until the session ends (maintenance ends stale sessions; there is no per-viewer TTL).
- Live moderation queues for staff (reports on individual chat lines) go through the general safety module; there is no live-specific staff console beyond ending a session.
- No push notification when a followed host goes live.
