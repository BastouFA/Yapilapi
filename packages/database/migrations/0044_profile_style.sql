-- Profile customisation: an accent and a header style, pronouns and a city, which tabs show and
-- in what order, up to 3 featured posts, and a song. Link icons are fetched on the server and kept
-- per host.

ALTER TABLE profiles
  -- One of the curated accents (packages/shared/src/profile-style.ts); NULL is the brand accent.
  ADD COLUMN accent text CHECK (accent ~ '^[a-z]{2,20}$'),
  -- 'cover': the cover photo, or the accent gradient without one. 'gradient': always the gradient. 'clean': no band.
  ADD COLUMN header_style text NOT NULL DEFAULT 'cover' CHECK (header_style IN ('cover', 'gradient', 'clean')),
  ADD COLUMN pronouns text CHECK (char_length(pronouns) <= 30),
  -- Text only, never a position. Not shown to others on accounts of people under 18.
  ADD COLUMN city text CHECK (char_length(city) <= 60),
  -- Tabs in the order they show; NULL is the default set and order.
  ADD COLUMN tabs text[] CHECK (tabs IS NULL OR (cardinality(tabs) BETWEEN 1 AND 7)),
  -- Your own posts or reels shown first. Checked on save; filtered for each viewer when shown.
  ADD COLUMN featured_post_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(featured_post_ids) <= 3),
  -- The profile song: a sound or a catalogue song (never both) and the part that plays ({startMs, durationMs}).
  ADD COLUMN song_sound_id uuid REFERENCES sounds(id) ON DELETE SET NULL,
  ADD COLUMN song_track_id uuid REFERENCES music_tracks(id) ON DELETE SET NULL,
  ADD COLUMN song_part jsonb,
  ADD CONSTRAINT profiles_one_song CHECK (song_sound_id IS NULL OR song_track_id IS NULL);

-- Site icons for profile links, one per host. Only small PNG, ICO, GIF, JPEG or WebP files, checked
-- by their bytes; `image` is NULL when the site has none (or it couldn't be fetched safely), so we
-- don't ask again until it is a week old.
CREATE TABLE link_icons (
  host       text PRIMARY KEY,
  image      bytea,
  mime       text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
