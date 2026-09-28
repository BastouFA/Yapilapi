-- Sharing where you are with a chat (one-to-one and groups), for a limited time or once.
--
-- A share is a message (kind 'message'; its body is "Live location" or "Location", so previews,
-- search and helpers never see a place) with a row here keyed by the message, like games (0046).
-- The row keeps only the latest point, never a history. When a live share ends (its time, Stop,
-- a block, leaving the chat, someone joining it, unsending) the point is deleted and only the fact that it happened stays: who
-- shared with which chat, when, and for how long. A pin sent once keeps its point like a message
-- until it's unsent. Coordinates never go into messages, logs, analytics or the data export.

CREATE TABLE location_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            text NOT NULL CHECK (mode IN ('live', 'once')),
  precision       text NOT NULL CHECK (precision IN ('precise', 'approximate')),
  -- The latest point (degrees, to 5 decimal places at most), how sure the device was, and when it read it.
  lat             double precision CHECK (lat BETWEEN -90 AND 90),
  lng             double precision CHECK (lng BETWEEN -180 AND 180),
  accuracy_m      integer,
  point_at        timestamptz,
  started_at      timestamptz NOT NULL DEFAULT now(),
  -- Live shares stop by themselves at this time (15 minutes, 1 hour or 8 hours after starting).
  ends_at         timestamptz,
  stopped_at      timestamptz,
  stop_reason     text CHECK (stop_reason IN ('stopped', 'expired', 'blocked', 'left', 'joined', 'unsent')),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (mode = 'once' OR (ends_at IS NOT NULL AND ends_at <= started_at + interval '8 hours 1 minute')),
  -- Once a share has ended, it keeps no place.
  CHECK (stopped_at IS NULL OR lat IS NULL)
);
-- One live share per person per chat at a time.
CREATE UNIQUE INDEX location_shares_one_live ON location_shares (conversation_id, user_id) WHERE mode = 'live' AND stopped_at IS NULL;
-- Live shares that are due to stop (the sweep that catches any whose own job was missed).
CREATE INDEX location_shares_due_idx ON location_shares (ends_at) WHERE mode = 'live' AND stopped_at IS NULL;
CREATE INDEX location_shares_user_idx ON location_shares (user_id, started_at DESC);
