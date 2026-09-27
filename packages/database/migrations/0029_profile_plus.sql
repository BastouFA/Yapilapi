-- Profile cover photos and "Now" statuses.
--
-- Cover photo: always one of the person's own uploaded photos, processed and not
-- blocked by the automated check. profiles.cover_url keeps the address shown
-- (a processed size); cover_media_id says which upload it came from, so a later
-- moderation decision on that photo can take the cover down too.
ALTER TABLE profiles ADD COLUMN cover_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
-- Describes the cover for screen readers.
ALTER TABLE profiles ADD COLUMN cover_alt text;

-- "Now": a short line like "Studying for exams", with an optional icon from a
-- fixed set, shown on the profile and in chat headers. It ends 24 hours after
-- it was set, or sooner when cleared. Audience: 'everyone' (anyone who can see
-- the profile), 'followers', or 'close_friends' (people on the close friends
-- list who follow you).
CREATE TABLE profile_statuses (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  text       text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 60),
  icon       text,
  audience   text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'followers', 'close_friends')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX profile_statuses_expires_idx ON profile_statuses (expires_at);
