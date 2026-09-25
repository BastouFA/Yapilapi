-- 193: Admin (RBAC) support tables and analytics schema hardening.

CREATE TABLE admin_user_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_user_notes_user_idx ON admin_user_notes (user_id, created_at DESC);

-- Analytics events are pseudonymous and property-allowlisted (enforced in the API). `anon_id` is a random client-chosen
-- id for anonymous events; it is never derived from a device fingerprint or IP.
ALTER TABLE analytics_events
  ADD COLUMN anon_id     text CHECK (anon_id IS NULL OR char_length(anon_id) <= 64),
  ADD COLUMN platform    text CHECK (platform IS NULL OR platform IN ('web','ios','android','server')),
  ADD COLUMN source      text NOT NULL DEFAULT 'client' CHECK (source IN ('client','server'));
CREATE INDEX analytics_events_created_idx ON analytics_events (created_at);
CREATE INDEX analytics_events_user_idx ON analytics_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;
