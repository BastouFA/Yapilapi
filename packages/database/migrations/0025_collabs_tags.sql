-- Collab posts and reels, people tagged in photos, and hashtags in comments.
--
-- Collabs: the author of a post or reel invites up to 3 co-authors (people they
-- follow who follow them back). Each invitee accepts or declines; once accepted
-- the post shows as by both, sits on each co-author's profile, reaches their
-- followers' Following feeds and counts in their stats. The post's audience is
-- still set by its author: postVisibleSql runs for every listing, so a co-author
-- never widens who can see it. A co-author can leave (status 'left'); only the
-- original author can change or delete the post.
CREATE TABLE post_collaborators (
  post_id      uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'left', 'removed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  PRIMARY KEY (post_id, user_id)
);
-- A person's co-authored posts (profile listing, Following feed) and their open invites.
CREATE INDEX post_collaborators_user_idx ON post_collaborators (user_id, status);

-- People tagged in a photo of a post, at a spot given as fractions of the
-- photo's width and height. Only the post's author adds tags; the tagged person
-- or the author can remove one.
CREATE TABLE photo_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tagged_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  x          real NOT NULL CHECK (x >= 0 AND x <= 1),
  y          real NOT NULL CHECK (y >= 0 AND y <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, media_id, user_id)
);
CREATE INDEX photo_tags_post_idx ON photo_tags (post_id);
-- The Tagged tab on a profile.
CREATE INDEX photo_tags_user_idx ON photo_tags (user_id, created_at DESC);

-- Who may tag you in photos: anyone, only people you follow, or no one.
ALTER TABLE profiles ADD COLUMN tag_permission text NOT NULL DEFAULT 'everyone'
  CHECK (tag_permission IN ('everyone', 'following', 'nobody'));

-- Hashtags used in a comment, normalised like a post's topics, so a tag's page can count them.
ALTER TABLE comments ADD COLUMN topics text[] NOT NULL DEFAULT '{}';
CREATE INDEX comments_topics_idx ON comments USING gin (topics) WHERE deleted_at IS NULL;
