-- Reels plus: moment comments, creator highlights and "continue where I left off".
--
-- Moment comments: a top-level comment on a reel can be anchored to a time in
-- the video ("at 0:12"). The API checks it's a reel and the time is within its
-- length; replies and comments on other posts never carry one.
ALTER TABLE comments ADD COLUMN at_ms integer CHECK (at_ms IS NULL OR at_ms >= 0);
CREATE INDEX comments_moment_idx ON comments (post_id, at_ms) WHERE at_ms IS NOT NULL AND deleted_at IS NULL;

-- Highlights: up to five named points the creator marks in their reel, shown
-- as ticks on the scrubber and in a list. Stored on the post as
--   [{ "atMs": 12000, "label": "The drop" }, …] in time order.
ALTER TABLE posts ADD COLUMN highlights jsonb
  CHECK (highlights IS NULL OR (jsonb_typeof(highlights) = 'array' AND jsonb_array_length(highlights) <= 5));

-- Where each person stopped watching a reel, so it can pick up from there.
-- Only mid-way positions are kept: finishing (or barely starting) clears it.
CREATE TABLE reel_resume (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX reel_resume_recent_idx ON reel_resume (user_id, updated_at DESC);
