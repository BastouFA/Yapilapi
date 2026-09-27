-- Music catalogue: songs from outside providers (Creative Commons, a licensed catalogue, dev tones),
-- and music on posts (photo, carousel and text) as well as on reels and stories.
--
-- Nothing here stores a song. A row keeps a provider's metadata (title, artist, cover, the URL the
-- provider serves the preview or stream from) and the licence it came with, so the API can check
-- again at publish time and at view time whether a use is allowed. Posts and stories keep a
-- reference to the part they play (start and length), never a copy of the audio.

CREATE TABLE music_tracks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'dev', 'jamendo' or 'licensed' (in-app sounds stay in `sounds`).
  provider     text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  external_id  text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  title        text NOT NULL,
  artist       text NOT NULL,
  album        text,
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  cover_url    text,
  -- Where the provider serves the audio from (players ask it directly: nothing is proxied or kept here).
  preview_url  text,
  -- { name, url, commercialUse, regions, excludedRegions, maxClipSeconds, attribution, expiresAt, cacheAllowed }
  licence      jsonb NOT NULL,
  -- 'withdrawn': the provider took it down (posts keep going, silently, with a note).
  -- 'paused': its provider is switched off here; it comes back when the provider is on again.
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'paused')),
  withdrawn_at timestamptz,
  -- When the metadata and licence were last read from the provider.
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX music_tracks_refresh_idx ON music_tracks (fetched_at) WHERE status <> 'withdrawn';

-- Songs and sounds people saved for later in the music picker: one of the two.
CREATE TABLE music_saves (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   uuid REFERENCES music_tracks(id) ON DELETE CASCADE,
  sound_id   uuid REFERENCES sounds(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((track_id IS NULL) <> (sound_id IS NULL))
);
CREATE UNIQUE INDEX music_saves_track_key ON music_saves (user_id, track_id) WHERE track_id IS NOT NULL;
CREATE UNIQUE INDEX music_saves_sound_key ON music_saves (user_id, sound_id) WHERE sound_id IS NOT NULL;
CREATE INDEX music_saves_user_idx ON music_saves (user_id, created_at DESC);

-- Music on posts. A photo, carousel or text post plays part of a sound (posts.sound_id, as reels
-- already have) or of a catalogue song (music_track_id); a reel can play part of a catalogue song
-- instead of its own audio. `music` is the part and its sticker, validated by the API:
--   { "startMs": 30000, "durationMs": 15000, "style": "compact" }
ALTER TABLE posts
  ADD COLUMN music_track_id uuid REFERENCES music_tracks(id) ON DELETE SET NULL,
  ADD COLUMN music          jsonb;
CREATE INDEX posts_music_track_idx ON posts (music_track_id, created_at DESC) WHERE music_track_id IS NOT NULL AND deleted_at IS NULL;

-- Stories can play a catalogue song too (moments.music holds the part, as for sounds).
ALTER TABLE moments ADD COLUMN music_track_id uuid REFERENCES music_tracks(id) ON DELETE SET NULL;
CREATE INDEX moments_music_track_idx ON moments (music_track_id, created_at DESC) WHERE music_track_id IS NOT NULL AND deleted_at IS NULL;
