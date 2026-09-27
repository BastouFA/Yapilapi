-- Account and chat additions: changing your username (the old one is held for 14 days and
-- redirects), sign-in alerts for new devices, messages scheduled to send later, and chat
-- wallpapers and bubble colours.

-- ── Changing your username ──────────────────────────────────────────────
-- One row per change. Until held_until, nobody else can take the old name, and old profile
-- links and @mentions of it lead to the account. A change is allowed once every 14 days.
CREATE TABLE username_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_username text NOT NULL,
  new_username text NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  held_until   timestamptz NOT NULL
);
CREATE INDEX username_history_old_idx ON username_history (lower(old_username), held_until DESC);
CREATE INDEX username_history_user_idx ON username_history (user_id, changed_at DESC);

-- ── Sign-in alerts ──────────────────────────────────────────────────────
-- The devices (browser or app on a system, and the approximate place when the CDN reports a
-- country) an account has signed in from. A sign-in from one that isn't here is announced in
-- the app and, unless turned off, by email.
CREATE TABLE known_sign_ins (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint   text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);

ALTER TABLE user_preferences ADD COLUMN sign_in_email_alerts boolean NOT NULL DEFAULT true;

-- ── Send later ──────────────────────────────────────────────────────────
-- A message written now and sent at send_at by the jobs worker, as a normal message (blocks,
-- membership and the chat's disappearing timer are checked then). Only the sender sees it
-- until then. 'failed' keeps the reason it couldn't go out.
CREATE TABLE scheduled_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL,
  reply_to_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  send_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'failed', 'cancelled')),
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  failure         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_messages_sender_idx ON scheduled_messages (sender_id, conversation_id, send_at) WHERE status = 'scheduled';

-- ── Chat wallpapers and bubble colours ──────────────────────────────────
-- Chosen by any member; everyone in the chat sees the same. Names from packages/shared chat-theme.ts.
ALTER TABLE conversations
  ADD COLUMN wallpaper text NOT NULL DEFAULT 'plain',
  ADD COLUMN accent text NOT NULL DEFAULT 'yapi';
