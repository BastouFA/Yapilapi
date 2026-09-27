-- Better comments: likes, threads, a pinned comment, edits, who can comment,
-- and hidden words.

-- ─── Who can comment ───────────────────────────────────────────────────
-- The post's author chooses: everyone who can see the post, people they
-- follow, their followers, or no one. Posts shared before this stay open to
-- everyone who can see them.
ALTER TABLE posts ADD COLUMN comment_policy text NOT NULL DEFAULT 'everyone'
  CHECK (comment_policy IN ('everyone', 'following', 'followers', 'off'));

-- ─── Threads, counts, edits and hidden comments ─────────────────────────
-- One visible level of nesting: parent_id is always the top-level comment of
-- the thread, and reply_to_id the comment that was answered (which can be a
-- reply in the same thread).
ALTER TABLE comments ADD COLUMN reply_to_id uuid REFERENCES comments(id) ON DELETE SET NULL;
ALTER TABLE comments ADD COLUMN like_count integer NOT NULL DEFAULT 0;
-- Top-level comments: replies that everyone can see.
ALTER TABLE comments ADD COLUMN reply_count integer NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN edited_at timestamptz;
-- Hidden because it contains one of the post author's hidden words: only its
-- writer sees it where it was posted, and the post author can review it.
ALTER TABLE comments ADD COLUMN hidden_at timestamptz;
-- The post author let a hidden comment through; their hidden words don't hide it again.
ALTER TABLE comments ADD COLUMN unhidden_at timestamptz;

-- Replies to replies from before threads move up to their top-level comment.
WITH RECURSIVE chain AS (
  SELECT id, id AS root FROM comments WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, chain.root FROM comments c JOIN chain ON c.parent_id = chain.id
)
UPDATE comments c SET reply_to_id = c.parent_id, parent_id = chain.root
FROM chain WHERE chain.id = c.id AND c.parent_id IS NOT NULL;

CREATE INDEX comments_thread_idx ON comments (parent_id, created_at) WHERE parent_id IS NOT NULL;
CREATE INDEX comments_hidden_idx ON comments (post_id) WHERE hidden_at IS NOT NULL AND deleted_at IS NULL;

UPDATE comments c SET reply_count = r.n
FROM (SELECT parent_id, count(*)::int AS n FROM comments
      WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND moderation_status IN ('normal', 'review')
      GROUP BY parent_id) r
WHERE r.parent_id = c.id;

-- Post comment counts leave out removed and held comments.
UPDATE posts p SET comment_count = coalesce(n.n, 0)
FROM (SELECT p2.id, (SELECT count(*)::int FROM comments cm
                     WHERE cm.post_id = p2.id AND cm.deleted_at IS NULL AND cm.moderation_status IN ('normal', 'review')) AS n
      FROM posts p2) n
WHERE n.id = p.id AND p.comment_count IS DISTINCT FROM coalesce(n.n, 0);

-- The post author's pinned comment, shown first. Only a top-level comment can be pinned.
ALTER TABLE posts ADD COLUMN pinned_comment_id uuid REFERENCES comments(id) ON DELETE SET NULL;

-- ─── Likes ─────────────────────────────────────────────────────────────
CREATE TABLE comment_likes (
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_likes_user_idx ON comment_likes (user_id, created_at DESC);

-- ─── Edits ─────────────────────────────────────────────────────────────
-- Earlier texts of an edited comment, for moderators and so that people
-- mentioned before an edit aren't told again.
CREATE TABLE comment_edits (
  id         bigserial PRIMARY KEY,
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_edits_comment_idx ON comment_edits (comment_id, created_at);

-- ─── Hidden words ──────────────────────────────────────────────────────
-- Words and phrases a person doesn't want in comments on their posts, kept in lower case.
CREATE TABLE hidden_words (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word       text NOT NULL CHECK (length(word) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, word)
);
