-- Record a Yap again (docs/product/yaps.md, "Delete or record again"): within 24 hours of posting,
-- up to 5 times, its author swaps the recording for a new one (PUT /v1/posts/:id/voice). Likes,
-- comments and reposts stay. The Yap shows "Re-recorded", and its history says only when it was
-- recorded again: the old audio is deleted, never kept or shown.

ALTER TABLE posts ADD COLUMN voice_redone_at timestamptz;

CREATE TABLE post_voice_redos (
  post_id   uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  redone_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_voice_redos_post_idx ON post_voice_redos (post_id, redone_at DESC);
