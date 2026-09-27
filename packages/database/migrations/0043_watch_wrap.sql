-- Watch together, and the weekly wrap.

-- ─── Watch together ─────────────────────────────────────────────────────
-- People in a one-to-one or group chat (up to 8) watch reels and video posts at the
-- same time. The API keeps the shared playback (which item, playing or paused, where,
-- as of when) and relays changes over the realtime hub to the people watching; each
-- player corrects its own drift against it. The side chat is the conversation itself.
-- Nothing about what was watched is kept once a session ends beyond these rows.

CREATE TABLE watch_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  started_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The host's player is the clock everyone follows. When the host leaves, the person
  -- who has been watching longest becomes host; with nobody left, the session ends.
  host_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  -- Shared playback: the item on screen, playing or paused, and its position at state_at.
  current_item_id uuid,
  playing         boolean NOT NULL DEFAULT false,
  position_ms     integer NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
  state_at        timestamptz NOT NULL DEFAULT now(),
  -- Goes up by one on every play, pause, seek or change of item, so players drop late updates.
  state_seq       bigint NOT NULL DEFAULT 0,
  state_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
-- One session at a time per chat.
CREATE UNIQUE INDEX watch_sessions_one_active_idx ON watch_sessions (conversation_id) WHERE status = 'active';
CREATE INDEX watch_sessions_active_idx ON watch_sessions (created_at) WHERE status = 'active';

-- Who is watching. A row stays after someone leaves (left_at) so they can come back.
CREATE TABLE watch_participants (
  session_id   uuid NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  -- Players send a heartbeat; someone not seen for a while has left.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX watch_participants_present_idx ON watch_participants (session_id, joined_at) WHERE left_at IS NULL;
CREATE INDEX watch_participants_user_idx ON watch_participants (user_id) WHERE left_at IS NULL;

-- The queue: reels and video posts anyone watching added. Only posts everyone in the chat
-- can see go in; the others are skipped with a note (skip_reason) and never shown to anyone.
CREATE TABLE watch_queue_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  position    integer NOT NULL,
  -- queued → playing → played; skipped when it stopped being visible to everyone; removed by whoever added it or the host.
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'playing', 'played', 'skipped', 'removed')),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason IN ('not_visible', 'unavailable')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_queue_items_session_idx ON watch_queue_items (session_id, position);
-- The same post waits in a queue once at a time.
CREATE UNIQUE INDEX watch_queue_items_waiting_idx ON watch_queue_items (session_id, post_id) WHERE status IN ('queued', 'playing');
ALTER TABLE watch_sessions ADD CONSTRAINT watch_sessions_current_item_fk FOREIGN KEY (current_item_id) REFERENCES watch_queue_items(id) ON DELETE SET NULL;

-- ─── Weekly wrap ────────────────────────────────────────────────────────
-- A private look back at your week, made on Sunday evening in your time zone: what you
-- shared and its best moments, new friends and communities, places and events you went
-- to, songs you used, and a moment of the week from your own posts. Optional (on by
-- default, off in Settings), and nothing is made or sent for a week without activity.

ALTER TABLE user_preferences
  ADD COLUMN weekly_wrap        boolean NOT NULL DEFAULT true,
  -- The notification when it's ready (the card on Pulse stays either way).
  ADD COLUMN weekly_wrap_notify boolean NOT NULL DEFAULT true,
  -- The person's IANA time zone, as their device last reported it.
  ADD COLUMN timezone           text;

CREATE TABLE weekly_wraps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The Monday the week started on, in the person's time zone.
  week_start     date NOT NULL,
  timezone       text NOT NULL,
  -- A week without activity: kept only so the week isn't looked at again. Never shown or sent.
  empty          boolean NOT NULL DEFAULT false,
  -- Counts and the ids of what to show; read back through the usual visibility rules.
  summary        jsonb NOT NULL DEFAULT '{}',
  moment_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  notified_at    timestamptz,
  dismissed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);
CREATE INDEX weekly_wraps_user_idx ON weekly_wraps (user_id, week_start DESC) WHERE NOT empty;
