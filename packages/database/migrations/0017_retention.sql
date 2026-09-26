-- Retention pack: sounds, remix and duet reels, and close friends for stories.

-- A reel's audio becomes a sound other reels can use. The audio is the source
-- reel's own video track (no separate file): players play it from `media_id`.
CREATE TABLE sounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  media_id       uuid REFERENCES media(id) ON DELETE SET NULL,
  duration_ms    integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sounds_source_post_idx ON sounds (source_post_id) WHERE source_post_id IS NOT NULL;
CREATE INDEX sounds_owner_idx ON sounds (owner_id, created_at DESC);

-- Remix and duet reels. `allow_remix` is the author's per-reel setting (on by
-- default). `remix_mode` is 'duet' (played side by side with the original) or
-- 'remix' (reuses the original's sound only).
ALTER TABLE posts ADD COLUMN allow_remix boolean NOT NULL DEFAULT true;
ALTER TABLE posts ADD COLUMN remix_of_post_id uuid REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN remix_mode text CHECK (remix_mode IN ('duet', 'remix'));
ALTER TABLE posts ADD COLUMN sound_id uuid REFERENCES sounds(id) ON DELETE SET NULL;
CREATE INDEX posts_remix_of_idx ON posts (remix_of_post_id, created_at DESC) WHERE remix_of_post_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX posts_sound_idx ON posts (sound_id, created_at DESC) WHERE sound_id IS NOT NULL AND deleted_at IS NULL;

-- Close friends: a short list of people who follow you, for stories only they see.
CREATE TABLE close_friends (
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, friend_id),
  CHECK (owner_id <> friend_id)
);
CREATE INDEX close_friends_friend_idx ON close_friends (friend_id);

ALTER TABLE moments DROP CONSTRAINT moments_visibility_check;
ALTER TABLE moments ADD CONSTRAINT moments_visibility_check
  CHECK (visibility IN ('public', 'followers', 'friends', 'circle', 'selected', 'private', 'close_friends'));
