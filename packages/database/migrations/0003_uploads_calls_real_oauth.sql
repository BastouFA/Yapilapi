-- Resumable uploads, calls, Real, Real Together, OAuth.

-- ─── Resumable uploads ─────────────────────────────────────────────────
CREATE TABLE upload_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size         bigint NOT NULL CHECK (size > 0),
  chunk_size   integer NOT NULL CHECK (chunk_size > 0),
  total_chunks integer NOT NULL CHECK (total_chunks > 0),
  received     integer[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'failed', 'expired')),
  media_id     uuid REFERENCES media(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_sessions_user_idx ON upload_sessions (user_id, created_at DESC);

ALTER TABLE media ADD COLUMN storage_key text;
ALTER TABLE media ADD COLUMN size_bytes bigint;
ALTER TABLE media ADD COLUMN used_at timestamptz;

-- ─── Calls ─────────────────────────────────────────────────────────────
CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  caller_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('audio', 'video')),
  status          text NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'active', 'ended', 'missed', 'declined')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz,
  ended_at        timestamptz
);
CREATE INDEX calls_conversation_idx ON calls (conversation_id, created_at DESC);
CREATE UNIQUE INDEX calls_one_live_per_conversation ON calls (conversation_id) WHERE status IN ('ringing', 'active');

CREATE TABLE call_participants (
  call_id   uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz,
  left_at   timestamptz,
  PRIMARY KEY (call_id, user_id)
);

-- ─── Real Together ─────────────────────────────────────────────────────
CREATE TABLE togethers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   uuid REFERENCES events(id) ON DELETE SET NULL,
  title      text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closes_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE together_members (
  together_id uuid NOT NULL REFERENCES togethers(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('creator', 'member')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (together_id, user_id)
);
CREATE INDEX together_members_user_idx ON together_members (user_id);

CREATE TABLE together_contributions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  together_id uuid NOT NULL REFERENCES togethers(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id    uuid REFERENCES media(id) ON DELETE CASCADE,
  caption     text NOT NULL DEFAULT '',
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX together_contributions_idx ON together_contributions (together_id, captured_at);

-- ─── OAuth (authorization code + PKCE) ─────────────────────────────────
CREATE TABLE oauth_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash      text NOT NULL UNIQUE,
  redirect_uri   text NOT NULL,
  scopes         text[] NOT NULL,
  code_challenge text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes             text[] NOT NULL,
  access_hash        text NOT NULL UNIQUE,
  refresh_hash       text NOT NULL UNIQUE,
  access_expires_at  timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;
