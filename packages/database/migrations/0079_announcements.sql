-- Announcements: a short note from the team to everyone signed in, shown as a banner at the top of
-- the app (web and phone) until it ends or the person closes it. Written by an admin, shown as written.
CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  link_url text CHECK (link_url IS NULL OR char_length(link_url) <= 2000),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS announcements_starts_idx ON announcements (starts_at DESC);

-- Who closed which: a closed announcement doesn't come back for that person.
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS announcement_dismissals_user_idx ON announcement_dismissals (user_id);
