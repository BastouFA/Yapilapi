-- Reposts: share someone's public post or reel with your followers.
CREATE TABLE post_reposts (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX post_reposts_recent_idx ON post_reposts (user_id, created_at DESC);
CREATE INDEX post_reposts_post_idx ON post_reposts (post_id);
ALTER TABLE posts ADD COLUMN repost_count integer NOT NULL DEFAULT 0 CHECK (repost_count >= 0);
