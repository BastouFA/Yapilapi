-- 245: Live runtime (feature flag LIVE, off by default). Builds on 005 (live_sessions, live_participants, live_products, live_questions,
-- live_clips). Real video needs an external media server (see docs/architecture/live.md); everything here works without one in
-- 'interactive' mode (chat, polls, Q&A, gifts, shopping) and never pretends to carry video.

ALTER TABLE live_sessions
  ADD COLUMN media_mode          text NOT NULL DEFAULT 'video' CHECK (media_mode IN ('video','interactive')),
  ADD COLUMN ingest_provider     text NOT NULL DEFAULT 'none',
  ADD COLUMN ingest_state        text NOT NULL DEFAULT 'none' CHECK (ingest_state IN ('none','waiting','connected','ended')),
  ADD COLUMN slow_mode_sec       integer NOT NULL DEFAULT 0 CHECK (slow_mode_sec BETWEEN 0 AND 300),
  ADD COLUMN chat_enabled        boolean NOT NULL DEFAULT true,
  ADD COLUMN blocked_terms       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN viewer_count        integer NOT NULL DEFAULT 0 CHECK (viewer_count >= 0),
  ADD COLUMN recording_media_id  uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN ended_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN end_reason          text,
  ADD COLUMN language            text,
  ADD CONSTRAINT live_title_len CHECK (length(title) BETWEEN 1 AND 160),
  ADD CONSTRAINT live_time_order CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at);
CREATE INDEX live_sessions_scheduled_idx ON live_sessions (scheduled_for) WHERE status = 'scheduled';

ALTER TABLE live_participants
  ADD COLUMN muted_until timestamptz,
  ADD COLUMN banned_at   timestamptz,
  ADD COLUMN ban_reason  text,
  ADD COLUMN acted_by    uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX live_participants_active_idx ON live_participants (live_id) WHERE left_at IS NULL AND banned_at IS NULL;

CREATE TABLE live_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id     uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','system','gift')),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  hidden_at   timestamptz,
  hidden_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_messages_live_idx ON live_messages (live_id, created_at DESC, id DESC);
CREATE INDEX live_messages_user_idx ON live_messages (live_id, user_id, created_at DESC);

CREATE TABLE live_reactions (
  live_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('like','love','laugh','wow','clap','fire')),
  n          integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (live_id, user_id, kind)
);

CREATE TABLE live_polls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question   text NOT NULL CHECK (length(question) BETWEEN 1 AND 200),
  multiple   boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);
CREATE INDEX live_polls_live_idx ON live_polls (live_id, created_at DESC);
CREATE TABLE live_poll_options (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id  uuid NOT NULL REFERENCES live_polls(id) ON DELETE CASCADE,
  label    text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  position integer NOT NULL,
  votes    integer NOT NULL DEFAULT 0 CHECK (votes >= 0)
);
CREATE INDEX live_poll_options_poll_idx ON live_poll_options (poll_id, position);
CREATE TABLE live_poll_votes (
  poll_id   uuid NOT NULL REFERENCES live_polls(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES live_poll_options(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, option_id, user_id)
);
CREATE INDEX live_poll_votes_user_idx ON live_poll_votes (poll_id, user_id);

ALTER TABLE live_questions
  ADD COLUMN answer      text CHECK (answer IS NULL OR length(answer) <= 1000),
  ADD COLUMN answered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN answered_at timestamptz,
  ADD COLUMN hidden_at   timestamptz;
CREATE TABLE live_question_votes (
  question_id uuid NOT NULL REFERENCES live_questions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, user_id)
);

ALTER TABLE live_products
  ADD COLUMN pinned    boolean NOT NULL DEFAULT false,
  ADD COLUMN position  integer NOT NULL DEFAULT 0,
  ADD COLUMN added_at  timestamptz NOT NULL DEFAULT now();
-- One pinned product at a time per session (the "spotlight").
CREATE UNIQUE INDEX live_products_one_pinned ON live_products (live_id) WHERE pinned;

CREATE TABLE live_markers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at_ms      integer NOT NULL CHECK (at_ms >= 0),
  label      text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_markers_live_idx ON live_markers (live_id, at_ms);

ALTER TABLE live_clips
  ADD COLUMN created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN label             text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  ADD COLUMN studio_project_id uuid REFERENCES studio_projects(id) ON DELETE SET NULL,
  ADD COLUMN error_code        text,
  ADD CONSTRAINT live_clip_max_len CHECK (end_ms - start_ms <= 600000);
CREATE INDEX live_clips_live_idx ON live_clips (live_id, created_at DESC);
