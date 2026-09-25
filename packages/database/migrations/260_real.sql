-- 260: REAL ("Real Moments"): authenticity receipts on top of 002's real_captures.
-- Design: docs/product/real.md. Server-verifiable signals only; device attestation is NOT claimed (device_attested stays false until an
-- AttestationVerifier backed by Apple App Attest / Play Integrity is configured).

ALTER TABLE real_captures
  ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved'
    CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  ADD COLUMN shared_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,   -- set when the owner explicitly shared it to their profile
  ADD COLUMN capture_session_id uuid,                                       -- the single-use capture session that produced it
  ADD COLUMN reaction_count integer NOT NULL DEFAULT 0;

-- A capture session is issued by POST /v1/real/capture-sessions and consumed exactly once by POST /v1/real/captures.
-- The signed token carries the session id; consuming the row (used_at) is what makes replays impossible.
CREATE TABLE real_capture_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash   text NOT NULL,                     -- sha256(user id + client device id): never the raw device id
  clock_skew_ms bigint,                            -- server time minus client-reported time at issue (NULL = client sent no time)
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  capture_id    uuid REFERENCES real_captures(id) ON DELETE SET NULL
);
CREATE INDEX real_capture_sessions_user_idx ON real_capture_sessions (user_id, issued_at DESC);
CREATE INDEX real_capture_sessions_expiry_idx ON real_capture_sessions (expires_at);

CREATE UNIQUE INDEX real_captures_session_uniq ON real_captures (capture_session_id) WHERE capture_session_id IS NOT NULL;
-- One capture per media file (a re-used file is not a fresh capture).
CREATE UNIQUE INDEX real_captures_front_uniq ON real_captures (front_media_id) WHERE front_media_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX real_captures_rear_uniq ON real_captures (rear_media_id) WHERE rear_media_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX real_captures_recent_idx ON real_captures (captured_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Audience for visibility = 'selected'.
CREATE TABLE real_capture_audience (
  capture_id uuid NOT NULL REFERENCES real_captures(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (capture_id, user_id)
);
CREATE INDEX real_capture_audience_user_idx ON real_capture_audience (user_id);

-- Reactions on captures (the shared `reactions` table does not list this target type; 002 is never edited).
CREATE TABLE real_reactions (
  capture_id uuid NOT NULL REFERENCES real_captures(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'like' CHECK (kind IN ('like','love','laugh','wow','sad','insightful')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, user_id)
);
CREATE INDEX real_reactions_user_idx ON real_reactions (user_id);

-- Opt-in reminders. There is deliberately NO streak, count or "missed" column: nothing here can be used to pressure a user.
CREATE TABLE real_reminder_settings (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  days         smallint[] NOT NULL DEFAULT '{}' CHECK (days <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(days) <= 7),  -- 0 = Sunday
  local_minute smallint NOT NULL DEFAULT 1080 CHECK (local_minute BETWEEN 0 AND 1439),
  timezone     text NOT NULL DEFAULT 'UTC',
  last_sent_on date,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX real_reminder_enabled_idx ON real_reminder_settings (user_id) WHERE enabled;
