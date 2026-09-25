-- 195: Developer platform: OAuth 2.0 (authorization code + PKCE), API-key metadata, webhook delivery queue, mini app review.
-- Every secret (API keys, client secrets, authorization codes, access/refresh tokens) is stored as a SHA-256 hash only.

ALTER TABLE developer_apps
  ADD COLUMN client_id          text UNIQUE,
  ADD COLUMN client_secret_hash text,                              -- null for public clients (PKCE only)
  ADD COLUMN confidential       boolean NOT NULL DEFAULT true,
  ADD COLUMN homepage_url       text CHECK (homepage_url IS NULL OR homepage_url ~ '^https?://'),
  ADD COLUMN privacy_url        text CHECK (privacy_url IS NULL OR privacy_url ~ '^https?://'),
  ADD COLUMN updated_at         timestamptz NOT NULL DEFAULT now();
CREATE INDEX developer_apps_owner_idx ON developer_apps (owner_id);
CREATE TRIGGER developer_apps_updated BEFORE UPDATE ON developer_apps FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE api_keys
  ADD COLUMN name              text NOT NULL DEFAULT 'default' CHECK (char_length(name) BETWEEN 1 AND 60),
  ADD COLUMN rate_limit_per_min integer NOT NULL DEFAULT 120 CHECK (rate_limit_per_min BETWEEN 1 AND 6000),
  ADD COLUMN expires_at        timestamptz;
CREATE INDEX api_keys_app_idx ON api_keys (app_id);

-- Consent: one row per (app, user). Re-authorizing widens/narrows scopes in place; revoking sets revoked_at.
CREATE TABLE oauth_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (app_id, user_id)
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;

CREATE TABLE oauth_authorization_codes (
  code_hash             text PRIMARY KEY,
  app_id                uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  scopes                text[] NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_authorization_codes_expiry_idx ON oauth_authorization_codes (expires_at);

CREATE TABLE oauth_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id            uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  access_hash         text NOT NULL UNIQUE,
  refresh_hash        text NOT NULL UNIQUE,
  scopes              text[] NOT NULL,
  access_expires_at   timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  refresh_used_at     timestamptz,                                 -- rotation: a used refresh token presented again = theft signal
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);

ALTER TABLE webhook_endpoints
  ADD COLUMN description          text,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN disabled_reason      text;
CREATE INDEX webhook_endpoints_app_idx ON webhook_endpoints (app_id);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  event_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','succeeded','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending','delivering');
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

ALTER TABLE mini_apps
  ADD COLUMN description  text NOT NULL DEFAULT '',
  ADD COLUMN version      text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at  timestamptz,
  ADD COLUMN review_note  text,
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now();
CREATE INDEX mini_apps_status_idx ON mini_apps (status);
CREATE TRIGGER mini_apps_updated BEFORE UPDATE ON mini_apps FOR EACH ROW EXECUTE FUNCTION set_updated_at();
