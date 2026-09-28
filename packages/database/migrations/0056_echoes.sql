-- Echoes: a reply to someone's reel with your own video, shown together in one new reel
-- (packages/shared/src/echoes.ts, apps/api/src/lib/echoes.ts).
--
-- The combined video is made here with ffmpeg from the original's video and yours, in a layout
-- (side by side, top and bottom, or theirs small in a corner), optionally after a cut of up to 15
-- seconds of theirs. It is stored like an upload and goes through the same processing and checks,
-- then the maker posts it as a reel linked to the original.

-- Who may echo a reel: 'everyone', 'following' (people the author follows) or 'nobody'. NULL is the
-- default, worked out when it's read: everyone for public accounts, nobody for private and
-- under-18 accounts. Changing it applies to new echoes; the ones already posted stay.
ALTER TABLE posts ADD COLUMN allow_echoes text CHECK (allow_echoes IN ('everyone', 'following', 'nobody'));

-- An echo reel. `is_echo` stays true when the original goes (a deleted account's posts are removed
-- for good and `echo_of_post_id` becomes NULL): an echo whose original isn't there any more is
-- shown to its author only (lib/visibility.ts, echoShownSql).
ALTER TABLE posts ADD COLUMN is_echo boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN echo_of_post_id uuid REFERENCES posts(id) ON DELETE SET NULL;
CREATE INDEX posts_echo_of_idx ON posts (echo_of_post_id, created_at DESC) WHERE echo_of_post_id IS NOT NULL AND deleted_at IS NULL;

-- Each echo video made, and what it was made from. `result_media_id` is the combined video (empty
-- until it's made; status says where it is). `post_id` is set once it's posted, and an echo video is
-- posted at most once.
CREATE TABLE echoes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_post_id   uuid REFERENCES posts(id) ON DELETE SET NULL,
  original_author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Your video, as uploaded (or recorded in the app).
  source_media_id    uuid REFERENCES media(id) ON DELETE SET NULL,
  result_media_id    uuid REFERENCES media(id) ON DELETE CASCADE,
  post_id            uuid UNIQUE REFERENCES posts(id) ON DELETE SET NULL,
  -- 'side' (side by side), 'stack' (top and bottom) or 'corner' (theirs small in a corner).
  layout             text NOT NULL CHECK (layout IN ('side', 'stack', 'corner')),
  -- "Echo after": this part of their reel plays first (up to 15 seconds).
  cut_start_ms       integer CHECK (cut_start_ms >= 0),
  cut_end_ms         integer,
  -- 0 is only their sound, 100 only yours, 50 both as loud.
  balance            smallint NOT NULL DEFAULT 50 CHECK (balance BETWEEN 0 AND 100),
  -- What is heard of their reel: 'mixed' (their audio, with yours), 'muted' (you turned it off),
  -- 'song' (their catalogue song plays with the echo: its licence allows it), 'dropped' (their song's
  -- licence doesn't allow it, so only your audio) or 'none' (their reel has no sound to use).
  their_audio        text NOT NULL CHECK (their_audio IN ('mixed', 'muted', 'song', 'dropped', 'none')),
  -- With 'song': the song and the part the original plays, carried to the echo reel.
  music_track_id     uuid REFERENCES music_tracks(id) ON DELETE SET NULL,
  music              jsonb,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  error              text,
  width              integer,
  height             integer,
  duration_ms        integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  CHECK ((cut_start_ms IS NULL) = (cut_end_ms IS NULL)),
  CHECK (cut_end_ms IS NULL OR cut_end_ms - cut_start_ms BETWEEN 1000 AND 15000)
);
CREATE INDEX echoes_owner_idx ON echoes (owner_id, created_at DESC);
CREATE INDEX echoes_original_idx ON echoes (original_post_id) WHERE original_post_id IS NOT NULL;
CREATE INDEX echoes_result_idx ON echoes (result_media_id);
