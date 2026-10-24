-- Stash (docs/product/stash.md, packages/shared/src/stash.ts, apps/api/src/lib/stash.ts): hide
-- something at a real place; it only opens for someone who is there.
--
-- The exact point (lat, lng) is kept for opening and is never sent to anyone but the person who hid
-- it (and moderators). Everyone else gets the area: area_lat/area_lng, a point a random distance
-- (up to STASH_AREA_OFFSET_METRES) and direction from it, chosen once when it's hidden, so the
-- point isn't the area's middle and asking again never narrows it down.

CREATE TABLE stashes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Hidden by the YAPILAPI team for launch (seed mode): shown as "Hidden by YAPILAPI", no person's name.
  seeded          boolean NOT NULL DEFAULT false,
  kind            text NOT NULL CHECK (kind IN ('text', 'photo', 'video', 'song', 'voice', 'gift')),
  title           text CHECK (char_length(title) <= 60),
  hint            text CHECK (char_length(hint) <= 140),
  body            text CHECK (char_length(body) <= 500),
  gift_code       text CHECK (char_length(gift_code) <= 64),
  -- A photo, a video or a voice note (a voice clip's media).
  media_id        uuid REFERENCES media(id) ON DELETE SET NULL,
  -- A song: a library sound or a catalogue song, and the part that plays.
  sound_id        uuid REFERENCES sounds(id) ON DELETE SET NULL,
  music_track_id  uuid REFERENCES music_tracks(id) ON DELETE SET NULL,
  music_start_ms  integer,
  music_ms        integer,
  lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng             double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy        real,
  area_lat        double precision NOT NULL,
  area_lng        double precision NOT NULL,
  -- The city it's in (a launch city, the nearest place page's, or the hider's), for explorer lists.
  city            text CHECK (char_length(city) <= 60),
  city_key        text,
  audience        text NOT NULL CHECK (audience IN ('person', 'friends', 'squad', 'everyone')),
  recipient_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  squad_id        uuid REFERENCES squads(id) ON DELETE CASCADE,
  first_only      boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  -- Words are checked like a post's: anything but 'normal' isn't findable (a voice note also waits for its words).
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((audience = 'person') = (recipient_id IS NOT NULL)),
  CHECK ((audience = 'squad') = (squad_id IS NOT NULL)),
  CHECK (NOT seeded OR audience = 'everyone')
);
CREATE INDEX stashes_area_idx ON stashes (area_lat, area_lng) WHERE deleted_at IS NULL;
CREATE INDEX stashes_owner_idx ON stashes (owner_id, created_at DESC);
CREATE INDEX stashes_recipient_idx ON stashes (recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX stashes_city_idx ON stashes (city_key, created_at DESC) WHERE deleted_at IS NULL;

-- Who opened which stash, and what they sent back. The city is the stash's, for explorer lists.
CREATE TABLE stash_finds (
  stash_id    uuid NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
  finder_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_key    text,
  reaction    text CHECK (reaction IN ('thanks', 'love', 'laugh', 'wow')),
  thanks      text CHECK (char_length(thanks) <= 140),
  thanked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stash_id, finder_id)
);
CREATE INDEX stash_finds_finder_idx ON stash_finds (finder_id, created_at DESC);
CREATE INDEX stash_finds_city_idx ON stash_finds (city_key, created_at DESC);

-- The last few positions someone hid or opened from, only to refuse impossible jumps (faster than
-- STASH_MAX_SPEED_KMH). Deleted after STASH_SAMPLE_MINUTES (the job worker's minute sweep).
CREATE TABLE stash_location_samples (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy    real NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stash_location_samples_user_idx ON stash_location_samples (user_id, created_at DESC);
CREATE INDEX stash_location_samples_created_idx ON stash_location_samples (created_at);

-- Settings: counts on your profile (on), explorer lists (on for adults; always off under 18) and
-- "new stashes near me" (off), with when that was last sent (at most once a day).
ALTER TABLE user_preferences ADD COLUMN stash_show_counts boolean NOT NULL DEFAULT true;
ALTER TABLE user_preferences ADD COLUMN stash_explorer_lists boolean NOT NULL DEFAULT true;
ALTER TABLE user_preferences ADD COLUMN stash_nearby_notify boolean NOT NULL DEFAULT false;
ALTER TABLE user_preferences ADD COLUMN stash_nearby_sent_at timestamptz;

-- Stashes can be reported (by people who can find them).
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live', 'question', 'answer', 'drop', 'mix', 'together_item', 'listing', 'stash'));
