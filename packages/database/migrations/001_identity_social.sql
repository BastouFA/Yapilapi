-- 001: Identity, profiles, sessions, devices, security events, social graph.
-- Conventions:
--   * uuid primary keys (gen_random_uuid), timestamptz everywhere
--   * CHECK constraints instead of Postgres enums (cheap to evolve)
--   * soft deletion via deleted_at where user-visible content is involved
--   * every mutable table carries created_at / updated_at

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL,
  email_verified_at timestamptz,
  password_hash     text,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deactivated','pending_deletion','deleted')),
  platform_role     text NOT NULL DEFAULT 'user'
                    CHECK (platform_role IN ('user','support','moderator','admin','superadmin')),
  birth_date        date NOT NULL,
  age_band          text NOT NULL CHECK (age_band IN ('teen','adult')),
  locale            text NOT NULL DEFAULT 'en',
  timezone          text NOT NULL DEFAULT 'UTC',
  country_code      text CHECK (country_code IS NULL OR length(country_code) = 2),
  mfa_enabled       boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  deletion_scheduled_for timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_platform_role_idx ON users (platform_role) WHERE platform_role <> 'user';
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Federated / alternative identities (password identity lives on users).
CREATE TABLE identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google','apple','github','oidc')),
  provider_subject text NOT NULL,
  email            citext,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);

-- Multi-factor: TOTP secrets are encrypted at rest (AES-256-GCM, envelope in `secret_enc`).
CREATE TABLE mfa_factors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('totp')),
  label        text NOT NULL DEFAULT 'Authenticator app',
  secret_enc   text NOT NULL,
  verified_at  timestamptz,
  last_used_step bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id);

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- WebAuthn passkeys (credential storage; ceremony endpoints are feature-gated, see docs/security).
CREATE TABLE passkey_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  text NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  device_label   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id);

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint  text NOT NULL,
  label        text,
  platform     text NOT NULL DEFAULT 'web' CHECK (platform IN ('web','ios','android','other')),
  push_token   text,
  trusted      boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  UNIQUE (user_id, fingerprint)
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  token_hash   text NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Pending MFA logins: password was correct, second factor not yet provided.
CREATE TABLE mfa_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  ip          inet,
  user_agent  text,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email','reset_password','cancel_deletion')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX one_time_tokens_user_idx ON one_time_tokens (user_id, purpose);

CREATE TABLE security_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  ip         inet,
  user_agent text,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_idx ON security_events (user_id, created_at DESC);

-- ---------------------------------------------------------------- topics / interests
CREATE TABLE topics (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       citext NOT NULL UNIQUE,
  name       text NOT NULL,
  parent_id  uuid REFERENCES topics(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_interests (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight     real NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 10),
  source     text NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit','inferred')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);
CREATE INDEX user_interests_topic_idx ON user_interests (topic_id);

CREATE TABLE topic_mutes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

-- ---------------------------------------------------------------- profiles
CREATE TABLE profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username       citext NOT NULL,
  display_name   text NOT NULL,
  bio            text NOT NULL DEFAULT '',
  avatar_url     text,
  cover_url      text,
  mode           text NOT NULL DEFAULT 'personal'
                 CHECK (mode IN ('personal','creator','professional','business')),
  links          jsonb NOT NULL DEFAULT '[]'::jsonb,
  location_text  text,
  is_private     boolean NOT NULL DEFAULT false,
  onboarding_completed_at timestamptz,
  follower_count integer NOT NULL DEFAULT 0,
  following_count integer NOT NULL DEFAULT 0,
  friend_count   integer NOT NULL DEFAULT 0,
  search_tsv     tsvector GENERATED ALWAYS AS (
                   to_tsvector('simple', coalesce(display_name,'') || ' ' || coalesce(username::text,'') || ' ' || coalesce(bio,''))
                 ) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username::text ~ '^[a-z0-9_]{3,30}$')
);
CREATE UNIQUE INDEX profiles_username_unique ON profiles (username);
CREATE INDEX profiles_search_idx ON profiles USING gin (search_tsv);
CREATE INDEX profiles_trgm_idx ON profiles USING gin ((username::text) gin_trgm_ops);
CREATE INDEX profiles_display_trgm_idx ON profiles USING gin (display_name gin_trgm_ops);
CREATE INDEX profiles_mode_idx ON profiles (mode);
CREATE TRIGGER profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- social graph
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id, status);

-- Friendships are stored once with user_low < user_high to make the pair unique.
CREATE TABLE friendships (
  user_low     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high),
  CHECK (requester_id = user_low OR requester_id = user_high)
);
CREATE INDEX friendships_high_idx ON friendships (user_high, status);

CREATE TABLE circles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('family','close_friends','work','business','travel','custom')),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE TABLE circle_members (
  circle_id  uuid NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, user_id)
);
CREATE INDEX circle_members_user_idx ON circle_members (user_id);

CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

CREATE TABLE user_mutes (
  muter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id),
  CHECK (muter_id <> muted_id)
);

-- Restriction: the restricted user can still see/comment, but their interactions are
-- hidden from everyone else until the restrictor approves them.
CREATE TABLE user_restrictions (
  restrictor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restricted_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restrictor_id, restricted_id),
  CHECK (restrictor_id <> restricted_id)
);

-- Parent/guardian links for minor-safety controls.
CREATE TABLE guardian_links (
  minor_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guardian_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (minor_id, guardian_id),
  CHECK (minor_id <> guardian_id)
);
