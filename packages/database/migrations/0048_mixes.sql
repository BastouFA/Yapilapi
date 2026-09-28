-- Mixes: song lists people make and share (packages/shared/src/mixes.ts).
--
-- A mix holds up to 100 songs from anywhere the music picker offers: in-app sounds (sounds) and
-- catalogue songs (music_tracks, with the licence each came with). Nothing about a song's audio is
-- kept here; listeners get each song's allowed part, checked for them when they look (lib/mixes.ts).

CREATE TABLE mixes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  -- 'private' (only me), 'friends', 'followers' or 'public' (everyone; a private account's
  -- followers; an under-18's followers).
  visibility        text NOT NULL DEFAULT 'followers' CHECK (visibility IN ('private', 'friends', 'followers', 'public')),
  like_count        integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  -- Reports: a moderator can restrict a mix (only its owner sees it) or remove it.
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX mixes_owner_idx ON mixes (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

-- The songs, in order. `added_by` becomes NULL when that person's account is deleted: the song
-- stays, "added by a former member".
CREATE TABLE mix_songs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id     uuid NOT NULL REFERENCES mixes(id) ON DELETE CASCADE,
  track_id   uuid REFERENCES music_tracks(id) ON DELETE CASCADE,
  sound_id   uuid REFERENCES sounds(id) ON DELETE CASCADE,
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  position   integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((track_id IS NULL) <> (sound_id IS NULL))
);
-- Each song once per mix.
CREATE UNIQUE INDEX mix_songs_track_key ON mix_songs (mix_id, track_id) WHERE track_id IS NOT NULL;
CREATE UNIQUE INDEX mix_songs_sound_key ON mix_songs (mix_id, sound_id) WHERE sound_id IS NOT NULL;
CREATE INDEX mix_songs_order_idx ON mix_songs (mix_id, position, id);
CREATE INDEX mix_songs_added_by_idx ON mix_songs (added_by) WHERE added_by IS NOT NULL;
-- Catalogue songs in mixes are kept current by the music refresh job.
CREATE INDEX mix_songs_track_idx ON mix_songs (track_id) WHERE track_id IS NOT NULL;

-- A mix shared into a chat (one-to-one or group): its card is a message there (kind 'message',
-- meta {"mixId": ...}). While the card is in the chat and the owner is still in it, everyone in
-- the chat can add and reorder songs. Unsending the card, or the chat deleting it, ends that.
CREATE TABLE mix_chats (
  mix_id          uuid NOT NULL REFERENCES mixes(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  shared_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mix_id, conversation_id)
);
CREATE INDEX mix_chats_conversation_idx ON mix_chats (conversation_id);

CREATE TABLE mix_likes (
  mix_id     uuid NOT NULL REFERENCES mixes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mix_id, user_id)
);
CREATE INDEX mix_likes_user_idx ON mix_likes (user_id);

CREATE TABLE mix_saves (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mix_id     uuid NOT NULL REFERENCES mixes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mix_id)
);
CREATE INDEX mix_saves_user_idx ON mix_saves (user_id, created_at DESC);

-- "Ada added 3 songs to Road trip": the latest line by one person about one mix in a chat.
CREATE INDEX messages_mix_line_idx ON messages (conversation_id, sender_id, (meta->>'mixId'), created_at DESC)
  WHERE kind = 'system' AND meta->>'type' = 'mix';

-- A mix shared as a post (a card in the post).
ALTER TABLE posts ADD COLUMN mix_id uuid REFERENCES mixes(id) ON DELETE SET NULL;
CREATE INDEX posts_mix_idx ON posts (mix_id) WHERE mix_id IS NOT NULL;

-- Mixes can be reported (by their owner).
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live', 'question', 'answer', 'drop', 'mix'));

-- Profiles can show a Mixes tab (packages/shared/src/profile-style.ts PROFILE_TABS).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tabs_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_tabs_check CHECK (tabs IS NULL OR (cardinality(tabs) BETWEEN 1 AND 9));
