# Messaging, realtime and calls

Module: `apps/api/src/modules/messaging`. Migration: `packages/database/migrations/100_messaging_realtime.sql`.

## What exists

- **Conversations**: `direct` (idempotent via `conversations.direct_key = "<low uuid>:<high uuid>"`), `group` (owner/admin/member roles, max 100 members), and `community_channel` (created by the communities module; this module only serves them).
- **Messages**: text, media, file, voice, in-message polls, plan proposals, call announcements. Replies, edits, delete-for-everyone (tombstone, text/attachments/reactions removed in the DB), reactions (`reactions.target_type = 'message'`), read receipts (`conversation_members.last_read_at`), unread counts, keyset pagination. `clientMessageId` makes sends idempotent (unique index on conversation + sender + client id; a retry returns the original message).
- **Plans**: `plans`, `plan_participants` (RSVP), `plan_tasks`, created inside a direct/group conversation together with a `plan` message.
- **Calls**: `calls` / `call_participants` records with start, join, leave, decline, end, list active, lazy "missed" after 60 s of ringing, at most one open call per conversation (partial unique index), at most 8 participants.
- **Realtime**: `POST /v1/ws/ticket` then `GET /v1/ws?ticket=...` (WebSocket).
- **Reusable service**: `sendMessage(ctx, { conversationId, senderId, body, ... })` (exported from `modules/messaging/index.ts`) applies exactly the rules of the HTTP route. Other modules must use it instead of inserting into `messages`.

## Access rules (server side, everywhere)

| Case                        | Rule                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| direct / group              | active member (`left_at IS NULL`); anything else is **404**, never 403                                                                                                                                       |
| direct + block (either way) | conversation disappears for both (404 on read/send/list/react/call, excluded from inbox)                                                                                                                     |
| direct create/send          | recipient `who_can_message` (everyone, followers = sender follows recipient, friends, nobody) re-checked on every send; either side a teen requires accepted friendship; recipient must be an active account |
| groups                      | every member added passes the same contact rules; a teen and a new member must be accepted friends; history before (re)joining is hidden                                                                     |
| community_channel           | derived from `getMembership()` (active members only; banned/left/pending/non-members get 404); sending needs the `post` permission                                                                           |
| restricted sender           | message is delivered, the restrictor's notification is suppressed                                                                                                                                            |
| moderation                  | text goes through `screenText`; non-approved messages are visible only to their sender and are never pushed over realtime                                                                                    |

Notifications carry ids only, never message text.

## WebSocket protocol

Auth: the session token never goes into the URL. `POST /v1/ws/ticket` (cookie/bearer auth, 30 req/min) returns a random 256-bit ticket valid for 60 s. Only its SHA-256 is stored (`ws_tickets`, so any API instance can redeem it). Redemption is one atomic `UPDATE ... WHERE used_at IS NULL` and also requires the session and user to still be valid. The upgrade is rejected with a plain HTTP error (before any socket exists) for: missing/invalid/used/expired ticket (401), an `Origin` header outside `CORS_ALLOWED_ORIGINS` (403, ticket not consumed), too many connections. Native clients send no `Origin`; the ticket authenticates them.

Server frames (JSON): `ready`, `pong`, `subscribed`, `unsubscribed` (`reason: access_revoked` when a heartbeat re-check finds the membership gone), `error {code}`, plus fan-out events:
`message.new | message.updated | message.deleted | conversation.read | conversation.updated | conversation.member.added/removed/updated | typing | call.started | call.updated | plan.updated` (from `conv:<id>`), and `notification | call.signal | conversation.added | conversation.removed` (from `user:<id>`, which `lib/notify.ts` already publishes to). Payloads pushed to channels are viewer-neutral (no "mine" fields, no client message ids).

Client frames: `ping`, `subscribe {conversationId}`, `unsubscribe`, `typing {conversationId, state}`, `call.signal {callId, to, signal:{kind: offer|answer|ice|bye, data}}`. Anything else, or invalid JSON, gets an `error` frame. Binary frames close the socket.

Hardening: `maxPayload` 16 KB (1009 on violation); 200 frames per 10 s per socket; typing throttled; 8 sockets per user per process; 1 MB send-buffer cap for slow consumers; server ping every 30 s (missed pong terminates); every heartbeat re-validates the session and all subscriptions (closes with 4401 if the session ended); subscriptions and timers are released on close. Membership changes push `conversation.added/removed` so sockets follow them immediately; the heartbeat is the safety net.

Multi-instance: fan-out goes through `ctx.pubsub` (`RedisPubSub` when `REDIS_URL` is set, in-memory otherwise, which is single-process only).

## Calls: what is real and what is not

Implemented: call records and lifecycle, participant tracking, authorization, and **signaling relay** over the WebSocket. A signal is relayed only if sender and recipient are both currently _joined_ participants of an _open_ call and both still have access to the conversation; the server stamps `from`, so it cannot be spoofed. Flow: initiator `POST /v1/conversations/:id/calls`, callee `POST /v1/calls/:id/join`, then peers exchange `offer` / `answer` / `ice` frames.

**Not implemented (external, and not pretended):** media transport. Audio/video is client-side peer-to-peer WebRTC in a full mesh (hence the 8-participant cap). There is **no TURN/STUN configuration, no SFU/MCU, no recording, no push-notification wake-up (APNs/FCM) for incoming calls, and no group-call scaling**. Clients need their own ICE servers (public STUN, and a TURN service such as coturn for restrictive NATs); `calls.room_id` is generated and reserved for a future SFU provider but nothing consumes it yet. Ringing timeout is applied lazily when calls are read (no background worker).

## Other known limits

- No end-to-end encryption; messages are stored in plaintext in PostgreSQL. Do not describe them as E2EE.
- Inbox lists direct and group conversations only; community channels are discovered through the communities module.
- Message search, link previews, forwarding, per-message delivery receipts and multi-device read-state sync beyond `conversation.read` events are not implemented.
- Account deletion hook: DM messages sent by the user become tombstones, group messages are anonymised (`sender_id` NULL, text kept for remaining members), reactions/votes/tickets removed, group memberships closed with ownership transferred, open calls ended.
