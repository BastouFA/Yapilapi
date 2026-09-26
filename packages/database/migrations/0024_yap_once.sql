-- Yaps: hold-to-talk voice clips that play out loud when they arrive, and
-- view-once photos and videos in chats.

-- ─── Yaps ──────────────────────────────────────────────────────────────
-- A yap is a voice message (one audio attachment, up to 60 seconds) that
-- plays right away for people who allowed it. It stays in the chat.
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'yap'));
-- The per-sender rate limit (30 a minute) counts recent yaps.
CREATE INDEX messages_yaps_sender_idx ON messages (sender_id, created_at DESC) WHERE kind = 'yap';

-- "Let Yaps play out loud" for one chat. NULL is the default: on for yaps from friends, off otherwise.
ALTER TABLE conversation_members ADD COLUMN yaps_out_loud boolean;
-- "Pause Yaps" everywhere: they still arrive, silently.
ALTER TABLE user_preferences ADD COLUMN yaps_paused boolean NOT NULL DEFAULT false;

-- ─── View once ─────────────────────────────────────────────────────────
-- Private media lives outside the public /media/ folder (under private/) and is
-- only served through an authorized, short-lived link.
ALTER TABLE media ADD COLUMN private boolean NOT NULL DEFAULT false;
-- When the file was removed from storage (view-once media after everyone saw it, or after 14 days).
ALTER TABLE media ADD COLUMN deleted_at timestamptz;

ALTER TABLE messages ADD COLUMN view_once boolean NOT NULL DEFAULT false;
-- The private file, kept here too because deleting a message empties its attachments.
ALTER TABLE messages ADD COLUMN view_once_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
-- Set when the file is deleted: 'viewed' once every recipient has opened it, 'expired' after 14 days
-- (NULL when the message itself was deleted first).
ALTER TABLE messages ADD COLUMN view_once_ended_at timestamptz;
ALTER TABLE messages ADD COLUMN view_once_end_reason text CHECK (view_once_end_reason IN ('viewed', 'expired'));
-- A view-once upload goes in one message only.
CREATE UNIQUE INDEX messages_view_once_media_key ON messages (view_once_media_id) WHERE view_once_media_id IS NOT NULL;
CREATE INDEX messages_view_once_open_idx ON messages (created_at) WHERE view_once AND view_once_ended_at IS NULL;

-- Who opened a view-once message. opened_at: when they tapped it; viewed_at: when
-- they closed it (from then on the file is never returned to them again).
CREATE TABLE message_views (
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  viewed_at     timestamptz,
  screenshot_at timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_views_unclosed_idx ON message_views (opened_at) WHERE viewed_at IS NULL;
