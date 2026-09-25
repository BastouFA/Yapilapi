-- 191: Privacy center: data export archives, advertising preferences, request bookkeeping.

-- The archive itself is stored gzip-compressed and served only through a short-lived, authorised download.
CREATE TABLE privacy_exports (
  request_id   uuid PRIMARY KEY REFERENCES privacy_requests(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_gz   bytea NOT NULL,
  size_bytes   integer NOT NULL,
  sha256       text NOT NULL,
  -- Download links: only the hash is stored; each link is single-use-window (expires) and requires the owner's session too.
  link_hash    text,
  link_expires_at timestamptz,
  downloaded_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,            -- the archive is purged after this
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_exports_expiry_idx ON privacy_exports (expires_at);
CREATE INDEX privacy_exports_user_idx ON privacy_exports (user_id);

ALTER TABLE privacy_requests ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX privacy_requests_due_idx ON privacy_requests (kind, status);

CREATE TABLE ad_preferences (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hidden_topics   text[] NOT NULL DEFAULT '{}',
  limit_sensitive boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ad_preferences_updated BEFORE UPDATE ON ad_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
