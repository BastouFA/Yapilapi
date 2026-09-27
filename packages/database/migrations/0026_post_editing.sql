-- Editing posts, drafts and scheduled posts.
--
-- A post is a draft, scheduled or published. Drafts and scheduled posts belong
-- to their author alone: postVisibleSql only lets published posts through, so
-- they never reach feeds, profiles, search, tags, counts or notifications.
-- Publishing (now, or at the scheduled time through the jobs table) sets
-- created_at to the moment it goes out, so it sits in feeds as a new post.
ALTER TABLE posts ADD COLUMN status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'scheduled', 'published'));
ALTER TABLE posts ADD COLUMN scheduled_at timestamptz;
ALTER TABLE posts ADD CONSTRAINT posts_scheduled_check CHECK ((status = 'scheduled') = (scheduled_at IS NOT NULL));
-- When the text last changed after publishing ("Edited" next to the time).
ALTER TABLE posts ADD COLUMN edited_at timestamptz;
-- An author's drafts and scheduled posts.
CREATE INDEX posts_unpublished_idx ON posts (author_id, updated_at DESC) WHERE status <> 'published' AND deleted_at IS NULL;

-- The text a post had before each edit: `body` is what it said until `edited_at`.
-- Anyone who can see and open the post can read its history.
CREATE TABLE post_edits (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id   uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  body      text NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_edits_post_idx ON post_edits (post_id, edited_at);
