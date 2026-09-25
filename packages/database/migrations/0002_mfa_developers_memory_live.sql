-- Two-step verification, developer platform, Memory and Live.

-- ─── MFA ───────────────────────────────────────────────────────────────
ALTER TABLE mfa_factors ADD COLUMN confirmed_at timestamptz;
CREATE UNIQUE INDEX mfa_factors_one_totp ON mfa_factors (user_id) WHERE kind = 'totp' AND confirmed_at IS NOT NULL;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- A password-verified login waiting for its second factor.
CREATE TABLE mfa_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  attempts   smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Developer platform ────────────────────────────────────────────────
CREATE TABLE developer_apps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  website       text,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX developer_apps_owner_idx ON developer_apps (owner_id) WHERE deleted_at IS NULL;

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write']::text[] AND cardinality(scopes) > 0),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_app_idx ON api_keys (app_id);

CREATE TABLE webhook_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  url        text NOT NULL,
  events     text[] NOT NULL CHECK (cardinality(events) > 0),
  secret     text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_subscriptions_app_idx ON webhook_subscriptions (app_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        smallint NOT NULL DEFAULT 0,
  response_code   integer,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- ─── Memory ────────────────────────────────────────────────────────────
CREATE TABLE memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  kind        text NOT NULL DEFAULT 'custom' CHECK (kind IN ('event', 'place', 'trip', 'people', 'date', 'community', 'custom')),
  description text NOT NULL DEFAULT '',
  recap       text,
  starts_at   timestamptz,
  ends_at     timestamptz,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'friends', 'selected')),
  source_type text,
  source_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_owner_idx ON memories (owner_id, created_at DESC);
CREATE UNIQUE INDEX memories_source_key ON memories (owner_id, source_type, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE memory_items (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('post', 'moment', 'media', 'event', 'place')),
  item_id   uuid NOT NULL,
  note      text,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, item_type, item_id)
);

CREATE TABLE memory_shares (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, user_id)
);

-- ─── Live ──────────────────────────────────────────────────────────────
CREATE TABLE live_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'followers', 'friends')),
  scheduled_for timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  stream_key_hash text,
  peak_viewers  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_sessions_status_idx ON live_sessions (status, started_at DESC);

CREATE TABLE live_participants (
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'viewer' CHECK (role IN ('host', 'cohost', 'moderator', 'viewer')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  banned     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE live_chat (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'question', 'reaction')),
  body       text NOT NULL,
  answered   boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_chat_session_idx ON live_chat (session_id, created_at);
