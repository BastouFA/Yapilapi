-- Follow requests: following a private account asks it first. The request waits here until the
-- account accepts (it becomes a row in follows) or declines (the row goes). Making the account
-- public accepts everyone still waiting.
CREATE TABLE follow_requests (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follow_requests_followee_idx ON follow_requests (followee_id, created_at DESC);
