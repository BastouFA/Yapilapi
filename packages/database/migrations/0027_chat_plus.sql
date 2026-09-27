-- Better chats: replies, editing, unsend and delete for me, pinned messages,
-- search inside a chat, and disappearing messages.

-- ─── Unsend and edit ───────────────────────────────────────────────────
-- Unsend (the sender, for everyone): the message is emptied and marked deleted
-- like before, and unsent_at keeps a "Message unsent" line in its place.
ALTER TABLE messages ADD COLUMN unsent_at timestamptz;
-- Earlier versions of an edited message (text only), kept for safety reports.
-- Removed when the message is unsent or disappears.
CREATE TABLE message_edits (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  body       text NOT NULL,
  edited_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_edits_message_idx ON message_edits (message_id, edited_at);

-- Delete for me: the message stays for everyone else.
CREATE TABLE message_hides (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- ─── System lines ──────────────────────────────────────────────────────
-- A line in the chat that tells everyone about a change (for now: who changed
-- disappearing messages). meta holds what changed.
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('message', 'yap', 'system'));
ALTER TABLE messages ADD COLUMN meta jsonb;

-- ─── Pinned messages ───────────────────────────────────────────────────
-- Up to 3 per conversation (checked by the API under a lock).
CREATE TABLE conversation_pins (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pinned_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, message_id)
);

-- ─── Disappearing messages ─────────────────────────────────────────────
-- Off (NULL), 24 hours, 7 days or 90 days. New messages carry expires_at; the job
-- worker deletes them (and the files attached) once it passes.
ALTER TABLE conversations ADD COLUMN disappearing_seconds integer CHECK (disappearing_seconds IN (86400, 604800, 7776000));
ALTER TABLE messages ADD COLUMN expires_at timestamptz;
CREATE INDEX messages_expires_idx ON messages (expires_at) WHERE expires_at IS NOT NULL;
