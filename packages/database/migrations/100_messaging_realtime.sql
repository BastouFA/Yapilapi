-- 100: Messaging realtime + calls support.

-- Single-use, short-lived WebSocket tickets. Only a SHA-256 hash is stored; the plaintext is returned once to the
-- caller. A table (not process memory) so any API instance can redeem a ticket issued by another.
CREATE TABLE ws_tickets (
  ticket_hash text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX ws_tickets_expires_idx ON ws_tickets (expires_at);
CREATE INDEX ws_tickets_user_idx ON ws_tickets (user_id);

-- At most one open (ringing/active) call per conversation, race-safe.
CREATE UNIQUE INDEX calls_one_open_per_conversation ON calls (conversation_id) WHERE status IN ('ringing','active');

CREATE INDEX message_attachments_media_idx ON message_attachments (media_id);
CREATE INDEX plans_conversation_idx ON plans (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX messages_sender_idx ON messages (sender_id) WHERE sender_id IS NOT NULL;
