-- The numbers under posts, reels and stories (docs/product/post-stats.md): views, likes, comments,
-- reposts and shares, a choice to hide like and view counts, milestones their authors are told
-- about, and what the story owner's numbers are counted from.

-- "Hide like and view counts": the account's default, and each post's own choice (NULL: the
-- account's). Others don't get those numbers; the author always does.
ALTER TABLE profiles ADD COLUMN hide_counts boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN hide_counts boolean;

-- Shares people see: times a post was sent to a chat, through the share sheet or as a copied link.
-- `shares` (0080) also counts reposts, for ranking; reposts are shown on their own.
ALTER TABLE post_stats ADD COLUMN sends integer NOT NULL DEFAULT 0 CHECK (sends >= 0);
UPDATE post_stats ps SET sends = x.n
FROM (SELECT post_id, count(*)::int AS n FROM feed_events WHERE kind = 'share' GROUP BY post_id) x
WHERE x.post_id = ps.post_id;

-- Views are the people other than the author who had a post on screen or watched it, each once
-- (post_views). Reels were counted when watched; posts now count when seen too, starting from
-- what the feeds already recorded.
WITH seen AS (
  INSERT INTO post_views (post_id, viewer_id, viewed_at)
  SELECT fe.post_id, fe.user_id, min(fe.created_at)
  FROM feed_events fe JOIN posts p ON p.id = fe.post_id
  WHERE fe.kind = 'impression' AND fe.user_id <> p.author_id
  GROUP BY fe.post_id, fe.user_id
  ON CONFLICT DO NOTHING
  RETURNING post_id
)
UPDATE posts p SET view_count = p.view_count + x.n
FROM (SELECT post_id, count(*)::int AS n FROM seen GROUP BY post_id) x
WHERE p.id = x.post_id;

-- Each milestone a post's views or likes passed (100, 1,000, 10,000, 100,000), so its author is
-- told once. Those already passed are written here without telling anyone.
CREATE TABLE post_milestones (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  metric     text NOT NULL CHECK (metric IN ('views', 'likes')),
  threshold  integer NOT NULL CHECK (threshold > 0),
  reached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, metric, threshold)
);
INSERT INTO post_milestones (post_id, metric, threshold)
SELECT p.id, 'views', m FROM posts p, unnest(ARRAY[100, 1000, 10000, 100000]) m WHERE p.view_count >= m
UNION ALL
SELECT p.id, 'likes', m FROM posts p, unnest(ARRAY[100, 1000, 10000, 100000]) m WHERE p.like_count >= m;

-- A story's numbers for its owner: times it was sent into chats, and the replies it got.
CREATE INDEX messages_story_idx ON messages (story_id) WHERE story_id IS NOT NULL;
CREATE INDEX messages_story_reply_idx ON messages ((meta->'storyReply'->>'storyId')) WHERE meta ? 'storyReply';
