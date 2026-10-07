-- The recommender behind For you and Reels (docs/product/recommendations.md): what people do on
-- their feeds, what each person seems to like (learned from it), counts per post, and the ranked
-- list a feed pages through.

-- What happened to posts on screen, sent by the apps in batches (POST /v1/feed/events). Kept 90
-- days (lib/retention.ts). Impressions are counted once per person, post and surface in 30 minutes.
CREATE TABLE feed_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  surface    text NOT NULL CHECK (surface IN ('for_you', 'reels', 'following', 'friends', 'communities', 'profile', 'tag', 'search', 'other')),
  kind       text NOT NULL CHECK (kind IN ('impression', 'dwell', 'watch', 'complete', 'skip', 'share', 'profile_open')),
  value_ms   integer CHECK (value_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_events_user_idx ON feed_events (user_id, created_at DESC);
CREATE INDEX feed_events_post_idx ON feed_events (post_id, created_at DESC);
-- What you already saw or finished, looked up for every feed you open (and to count impressions once).
CREATE INDEX feed_events_seen_idx ON feed_events (user_id, post_id, created_at DESC) WHERE kind IN ('impression', 'complete');
-- The retention sweep: rows only ever arrive in time order.
CREATE INDEX feed_events_created_idx ON feed_events USING brin (created_at);

-- Counts per post, kept up to date as things happen (events, saves, shares, reposts), so ranking
-- reads one row per post instead of counting events. `trend` is the post's engagement momentum:
-- each like, comment, save, share or finished watch adds to it and it fades by e every 6 hours
-- from trend_at (lib/ranking.ts reads it as of the feed's moment).
CREATE TABLE post_stats (
  post_id     uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  impressions integer NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  viewers     integer NOT NULL DEFAULT 0 CHECK (viewers >= 0),
  dwell_ms    bigint NOT NULL DEFAULT 0 CHECK (dwell_ms >= 0),
  watch_ms    bigint NOT NULL DEFAULT 0 CHECK (watch_ms >= 0),
  completes   integer NOT NULL DEFAULT 0 CHECK (completes >= 0),
  skips       integer NOT NULL DEFAULT 0 CHECK (skips >= 0),
  shares      integer NOT NULL DEFAULT 0 CHECK (shares >= 0),
  saves       integer NOT NULL DEFAULT 0 CHECK (saves >= 0),
  trend       real NOT NULL DEFAULT 0,
  trend_at    timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Trending now: posts with recent momentum.
CREATE INDEX post_stats_trend_idx ON post_stats (trend_at DESC) WHERE trend > 0;

-- What each person seems to like, learned from what they do (lib/affinity.ts): a score per topic
-- and per creator that grows with likes, comments, saves, shares and watching, drops with skips
-- and "Not interested", and fades with time (by e every 21 days). Only with Personalization on.
CREATE TABLE user_topic_affinity (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic      text NOT NULL,
  score      real NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);
CREATE TABLE user_creator_affinity (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score      real NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, author_id),
  CHECK (user_id <> author_id)
);
CREATE INDEX user_creator_affinity_author_idx ON user_creator_affinity (author_id);

-- A feed's ranked list, made when its first page is asked for: the next pages read from it, so
-- what you do while scrolling (and the counts it changes) never repeats or skips a post. Kept a
-- day (lib/retention.ts).
CREATE TABLE feed_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface    text NOT NULL CHECK (surface IN ('for_you', 'reels')),
  post_ids   uuid[] NOT NULL,
  reasons    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_sessions_user_idx ON feed_sessions (user_id, surface, created_at DESC);
CREATE INDEX feed_sessions_created_idx ON feed_sessions (created_at);

-- Counts for posts people already saved or reposted.
INSERT INTO post_stats (post_id, saves, shares)
SELECT p.id, (SELECT count(*) FROM saves s WHERE s.post_id = p.id), p.repost_count
FROM posts p
WHERE p.deleted_at IS NULL AND (p.repost_count > 0 OR EXISTS (SELECT 1 FROM saves s WHERE s.post_id = p.id));

-- A warm start: what people did in the last 60 days, faded by age, for everyone who hasn't turned
-- Personalization off. The weights are the ones in lib/affinity.ts (AFFINITY.deltas).
CREATE TEMP TABLE affinity_seed ON COMMIT DROP AS
WITH allowed AS (
  SELECT u.id FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.purpose = 'personalization' AND NOT c.granted)
),
sig AS (
  SELECT r.user_id, r.post_id, 1.0 AS topic_w, 1.0 AS creator_w, r.created_at FROM reactions r WHERE r.created_at > now() - interval '60 days'
  UNION ALL
  SELECT s.user_id, s.post_id, 2.5, 2.5, s.created_at FROM saves s WHERE s.created_at > now() - interval '60 days'
  UNION ALL
  SELECT c.author_id, c.post_id, 2.0, 2.0, c.created_at FROM comments c WHERE c.deleted_at IS NULL AND c.created_at > now() - interval '60 days'
  UNION ALL
  SELECT rp.user_id, rp.post_id, 3.0, 3.0, rp.created_at FROM post_reposts rp WHERE rp.created_at > now() - interval '60 days'
  UNION ALL
  SELECT ff.user_id, ff.post_id,
         CASE ff.signal WHEN 'more_like_this' THEN 2.0 WHEN 'less_like_this' THEN -2.0 ELSE -3.0 END,
         CASE ff.signal WHEN 'not_interested' THEN -3.0 ELSE 0 END,
         ff.created_at
  FROM feed_feedback ff
  WHERE ff.post_id IS NOT NULL AND ff.signal IN ('more_like_this', 'less_like_this', 'not_interested') AND ff.created_at > now() - interval '60 days'
)
SELECT s.user_id, p.author_id, p.topics, s.topic_w, s.creator_w, exp(-extract(epoch FROM now() - s.created_at) / 86400.0 / 21) AS fade
FROM sig s JOIN allowed a ON a.id = s.user_id JOIN posts p ON p.id = s.post_id
WHERE p.author_id <> s.user_id AND p.deleted_at IS NULL;

INSERT INTO user_topic_affinity (user_id, topic, score)
SELECT user_id, t, greatest(-10, least(30, sum(topic_w * fade)))
FROM affinity_seed, unnest(topics) t
GROUP BY user_id, t
HAVING abs(sum(topic_w * fade)) > 0.05;

INSERT INTO user_creator_affinity (user_id, author_id, score)
SELECT user_id, author_id, greatest(-10, least(30, sum(w)))
FROM (
  SELECT user_id, author_id, creator_w * fade AS w FROM affinity_seed
  UNION ALL
  -- Following someone counts for them too.
  SELECT f.follower_id, f.followee_id, 4.0 * exp(-extract(epoch FROM now() - f.created_at) / 86400.0 / 21)
  FROM follows f
  WHERE f.created_at > now() - interval '60 days'
    AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.user_id = f.follower_id AND c.purpose = 'personalization' AND NOT c.granted)
) x
GROUP BY user_id, author_id
HAVING abs(sum(w)) > 0.05;
