-- Polls, shared lists and reminders in chats (one-to-one and groups).
--
-- A poll or a list is a message (kind 'message'; its body is the question or the
-- title, so previews, pins, replies and search work as for any message) with a row
-- here keyed by the message. Everything cascades from the message: when a
-- disappearing message is deleted, its poll or list goes with it. Unsending a
-- message deletes these rows (the API does it).

-- ─── Polls ─────────────────────────────────────────────────────────────
CREATE TABLE chat_polls (
  message_id        uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question          text NOT NULL,
  multiple          boolean NOT NULL DEFAULT false,
  -- Nobody sees who voted for what (votes are still stored per person, so each can change theirs).
  anonymous         boolean NOT NULL DEFAULT false,
  allow_add_options boolean NOT NULL DEFAULT false,
  ends_at           timestamptz,
  -- Set when it ends: at ends_at (by a job) or early by its creator.
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_polls_conversation_idx ON chat_polls (conversation_id);

-- Up to 10 per poll (checked by the API under a lock).
CREATE TABLE chat_poll_options (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES chat_polls(message_id) ON DELETE CASCADE,
  text       text NOT NULL,
  position   integer NOT NULL,
  added_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_poll_options_text_key ON chat_poll_options (message_id, lower(text));
CREATE INDEX chat_poll_options_poll_idx ON chat_poll_options (message_id, position);

CREATE TABLE chat_poll_votes (
  option_id  uuid NOT NULL REFERENCES chat_poll_options(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES chat_polls(message_id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX chat_poll_votes_poll_idx ON chat_poll_votes (message_id, user_id);

-- ─── Shared lists ──────────────────────────────────────────────────────
CREATE TABLE chat_lists (
  message_id      uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_lists_conversation_idx ON chat_lists (conversation_id);

-- Up to 100 per list (checked by the API under a lock).
CREATE TABLE chat_list_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES chat_lists(message_id) ON DELETE CASCADE,
  text       text NOT NULL,
  position   integer NOT NULL,
  added_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  done_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_list_items_list_idx ON chat_list_items (message_id, position);

-- ─── Reminders ─────────────────────────────────────────────────────────
-- 'me': a notification (and push) to the person who set it. 'group': a system line
-- in the chat, set by a group admin. Each has a job queued for its time.
CREATE TABLE chat_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('me', 'group')),
  remind_at       timestamptz NOT NULL,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_reminders_user_idx ON chat_reminders (user_id, remind_at) WHERE sent_at IS NULL;
CREATE INDEX chat_reminders_message_idx ON chat_reminders (message_id);
CREATE INDEX chat_reminders_due_idx ON chat_reminders (remind_at) WHERE sent_at IS NULL;
