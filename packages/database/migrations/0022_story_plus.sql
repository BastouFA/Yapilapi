-- Stories+: sharing stories to chats, resharing into your own story, @mentions,
-- #hashtags and interactive stickers (poll, question, emoji slider, countdown,
-- link, place).

-- Stickers are stored on the story as JSON (validated by the API), with positions
-- relative to the frame (0–1). Tags come from the text and hashtag stickers;
-- mentions are the people named in the text or on mention stickers.
ALTER TABLE moments
  ADD COLUMN stickers      jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN tags          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN mentions      uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN reshare_of    uuid REFERENCES moments(id) ON DELETE SET NULL,
  ADD COLUMN allow_reshare boolean NOT NULL DEFAULT true;

-- Tag pages and trending read active public stories by tag.
CREATE INDEX moments_tags_idx ON moments USING gin (tags) WHERE deleted_at IS NULL AND visibility = 'public';
CREATE INDEX moments_reshare_of_idx ON moments (reshare_of) WHERE reshare_of IS NOT NULL;

-- A message can carry a story card. Whether it opens is decided for each reader.
ALTER TABLE messages ADD COLUMN story_id uuid REFERENCES moments(id) ON DELETE SET NULL;

-- Viewers' responses to interactive stickers.
--   poll:     choice (0 or 1), once per person
--   slider:   value (0–1), once per person
--   question: answer text, seen only by the author
--   reminder: a countdown reminder, sent at remind_at
CREATE TABLE story_responses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id   uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  sticker_id  text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('poll', 'slider', 'question', 'reminder')),
  choice      smallint CHECK (choice IN (0, 1)),
  value       real CHECK (value >= 0 AND value <= 1),
  answer      text CHECK (char_length(answer) <= 300),
  remind_at   timestamptz,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX story_responses_once_idx ON story_responses (moment_id, sticker_id, user_id) WHERE kind IN ('poll', 'slider', 'reminder');
CREATE INDEX story_responses_sticker_idx ON story_responses (moment_id, sticker_id, created_at DESC);
CREATE INDEX story_responses_due_idx ON story_responses (remind_at) WHERE kind = 'reminder' AND notified_at IS NULL;
