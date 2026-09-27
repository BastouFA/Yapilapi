-- Live audio rooms in communities.
--
-- A moderator, admin or owner starts a room now or schedules it. Members of
-- the community join as listeners; hosts (the person who started it and the
-- community's moderators, admins and owner) bring people up to speak, mute,
-- move speakers back and remove people. Audio never touches the database or
-- the API: clients connect over WebRTC (a mesh today, see
-- apps/api/src/lib/room-media.ts) and the API only relays signaling.
--
-- Nothing is recorded. What stays after a room ends is its title, times and
-- the most people who were in it at once.

CREATE TABLE rooms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  created_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- scheduled: shows on the community until a host starts it.
  -- live: people can join. ended / cancelled: read-only history.
  status         text NOT NULL DEFAULT 'live' CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  scheduled_for  timestamptz,
  started_at     timestamptz,
  ended_at       timestamptz,
  -- Last time a host was in the room; a live room with no host for a few minutes ends on its own.
  host_seen_at   timestamptz,
  peak_listeners integer NOT NULL DEFAULT 0 CHECK (peak_listeners >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rooms_community_idx ON rooms (community_id, created_at DESC);
-- One live room per community at a time.
CREATE UNIQUE INDEX rooms_one_live_idx ON rooms (community_id) WHERE status = 'live';
CREATE INDEX rooms_live_idx ON rooms (host_seen_at) WHERE status = 'live';

-- Everyone who has been in a room. A row stays after someone leaves, so a
-- removed person can't come back (removed_at) and history stays countable.
CREATE TABLE room_participants (
  room_id        uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'listener' CHECK (role IN ('speaker', 'listener')),
  is_host        boolean NOT NULL DEFAULT false,
  muted          boolean NOT NULL DEFAULT true,
  hand_raised_at timestamptz,
  -- A host asked this listener to speak; they accept or decline.
  invited_at     timestamptz,
  invited_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  -- Clients send a heartbeat; people not seen for a while are treated as gone.
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  left_at        timestamptz,
  removed_at     timestamptz,
  removed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_participants_present_idx ON room_participants (room_id, role) WHERE left_at IS NULL;
CREATE INDEX room_participants_user_idx ON room_participants (user_id) WHERE left_at IS NULL;

-- Members who asked to be told when a scheduled room starts.
CREATE TABLE room_reminders (
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
