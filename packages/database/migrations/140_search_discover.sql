-- 140: Search & discovery support.
--   * search_history: per-user recent searches (only written when the user has personalization enabled; deletable;
--     bounded per user and purged after 90 days by the search module).
--   * trigram indexes so typeahead / typo-tolerant search is index-backed for the remaining searchable entities.
--   * partial/time indexes used by trending (engagement velocity) and geo discovery.

CREATE TABLE search_history (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_query text NOT NULL CHECK (length(normalized_query) BETWEEN 2 AND 200),
  query            text NOT NULL CHECK (length(query) BETWEEN 2 AND 200),
  search_count     integer NOT NULL DEFAULT 1,
  last_searched_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, normalized_query)
);
CREATE INDEX search_history_recent_idx ON search_history (user_id, last_searched_at DESC);
CREATE INDEX search_history_retention_idx ON search_history (last_searched_at);

CREATE INDEX search_events_title_trgm_idx ON events     USING gin (title gin_trgm_ops);
CREATE INDEX search_products_title_trgm_idx ON products  USING gin (title gin_trgm_ops);
CREATE INDEX search_businesses_name_trgm_idx ON businesses USING gin (name gin_trgm_ops);
CREATE INDEX search_topics_name_trgm_idx ON topics  USING gin (name gin_trgm_ops);

-- Engagement velocity: reactions/comments/shares/saves inside a recent window.
CREATE INDEX search_reactions_post_recent_idx ON reactions (created_at DESC) WHERE target_type = 'post';
CREATE INDEX search_comments_recent_idx ON comments  (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX search_shares_recent_idx ON shares    (created_at DESC);
CREATE INDEX search_saves_post_recent_idx ON saves     (created_at DESC) WHERE target_type = 'post';

-- Geo discovery (events geo/status indexes come with migration 150).
CREATE INDEX search_posts_public_geo_idx ON posts (latitude, longitude) WHERE latitude IS NOT NULL AND deleted_at IS NULL AND visibility = 'public';
CREATE INDEX search_posts_video_idx ON posts (created_at DESC, id DESC) WHERE kind = 'video' AND deleted_at IS NULL;
