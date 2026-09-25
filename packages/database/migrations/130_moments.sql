-- 130: Moments (temporary content): hot-path indexes and view/reaction lookups.
CREATE INDEX moments_media_idx ON moments (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX moment_views_viewer_idx ON moment_views (viewer_id, moment_id);
CREATE INDEX moment_views_moment_idx ON moment_views (moment_id, viewed_at DESC);
CREATE INDEX moment_audience_user_idx ON moment_audience (user_id);
