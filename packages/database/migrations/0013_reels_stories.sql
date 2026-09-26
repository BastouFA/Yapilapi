-- Reels (short vertical videos with their own full-screen feed) and stories
-- (moments) with views, likes and processed media.

ALTER TABLE posts ADD COLUMN format text NOT NULL DEFAULT 'post' CHECK (format IN ('post', 'reel'));
CREATE INDEX posts_reels_idx ON posts (created_at DESC, id DESC) WHERE format = 'reel' AND deleted_at IS NULL;

-- Stories keep a link to the uploaded media, so they play the processed versions (poster, HLS).
ALTER TABLE moments ADD COLUMN media_id uuid REFERENCES media(id) ON DELETE SET NULL;

CREATE TABLE moment_views (
  moment_id uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liked     boolean NOT NULL DEFAULT false,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (moment_id, viewer_id)
);
CREATE INDEX moment_views_viewer_idx ON moment_views (viewer_id, viewed_at DESC);
