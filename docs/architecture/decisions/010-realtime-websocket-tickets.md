# ADR 010: WebSockets authenticated by single-use tickets

Status: accepted. Scope: messaging, notifications, live

## Decision

Clients call `POST /v1/ws/ticket` (authenticated normally) and connect to the WebSocket with the returned single-use, short-lived, hashed ticket, so long-lived credentials never appear in URLs or logs. The socket checks Origin, subscribes to `user:<id>` and the caller's `conv:<id>` channels, and events fan out through Redis pub/sub (in-memory in development). Membership is re-checked when subscribing.

## Known gaps

Sockets are not automatically subscribed to conversations created after connect (clients reconnect or refetch). WebRTC calls are signaling-only: no TURN/SFU is provided. Messages are protected in transit and at rest by the platform but are not end-to-end encrypted.
