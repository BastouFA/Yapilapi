-- Reel and post views (one per person, not counting the author) and a pinned
-- post at the top of each profile.

CREATE TABLE post_views (
  post_id   uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, viewer_id)
);
CREATE INDEX post_views_viewer_idx ON post_views (viewer_id, viewed_at DESC);

ALTER TABLE posts ADD COLUMN view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0);

ALTER TABLE profiles ADD COLUMN pinned_post_id uuid REFERENCES posts(id) ON DELETE SET NULL;
