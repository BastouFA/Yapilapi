-- AI helpers: Catch me up on Pulse, smart replies in chats, photo descriptions and
-- caption ideas. Each one only ever reads what the person can see right now, and
-- nothing is posted or sent without the person confirming it.

-- ─── Catch me up ────────────────────────────────────────────────────────
-- When someone opens Pulse after being away (12 hours or more), the time they were
-- away is kept as a "visit window": the catch-up covers what their people shared in it.
CREATE TABLE pulse_visits (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- The current visit window, when the last gap was long enough.
  away_since    timestamptz,
  back_at       timestamptz,
  -- "Not now" on the card: hidden until the next window.
  dismissed     boolean NOT NULL DEFAULT false
);

-- One summary per person and visit window, so opening the card again costs nothing.
-- It holds the lines shown and the ids of the posts they link to (checked again on read).
CREATE TABLE ai_catchups (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  away_since timestamptz NOT NULL,
  back_at    timestamptz NOT NULL,
  output     jsonb NOT NULL,
  provider   text NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, away_since, back_at)
);

-- ─── Smart replies ──────────────────────────────────────────────────────
-- Everywhere: NULL is the default (on, except for people under 18, who turn it on themselves).
ALTER TABLE user_preferences
  ADD COLUMN smart_replies boolean,
  -- Show the Catch me up card on Pulse.
  ADD COLUMN catch_up boolean NOT NULL DEFAULT true;
-- In one chat: NULL is the default (on in one-to-one chats, off in groups and community chats).
ALTER TABLE conversation_members ADD COLUMN smart_replies boolean;

-- Suggestions already made for a received message, per reader (they are short-lived).
CREATE TABLE ai_reply_suggestions (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  suggestions jsonb NOT NULL,
  lang        text,
  provider    text NOT NULL,
  model       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- Per-person limits count recent calls by task (ai_tool_calls_user_task_idx, from 0035).
