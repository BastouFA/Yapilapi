-- Saved posts, boards and notes.
--
-- Saves (0001) stay the source of "everything you saved". A board is a named
-- collection on top of them: private to its owner (default), shared with
-- collaborators the owner invites (they see the board and add to it), or
-- public on the owner's profile. Deleting a board never touches saves.
--
-- A board only ever stores post ids. What a viewer gets back is decided when
-- it's read: every listing and count runs postVisibleSql and postUnlockedSql
-- for that viewer, so a board never shows a post its viewer can't see.

-- A private note on a save ("try this on Sunday"). Only ever returned to the
-- person who saved the post.
ALTER TABLE saves ADD COLUMN note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 280);
ALTER TABLE saves ADD COLUMN note_updated_at timestamptz;
-- The Saved page: your saves, newest first.
CREATE INDEX saves_user_idx ON saves (user_id, created_at DESC, post_id DESC);

CREATE TABLE boards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 160),
  -- private: only the owner. shared: the owner and collaborators.
  -- public: also on the owner's profile, for anyone who can see that profile.
  -- People under 18 can't make a board public (checked by the API, and a
  -- public board of someone under 18 is read as shared).
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared', 'public')),
  -- The cover the owner chose; when empty, gone or not visible to a viewer,
  -- the first item that viewer can see is the cover.
  cover_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boards_owner_idx ON boards (owner_id, updated_at DESC);
CREATE INDEX boards_public_idx ON boards (owner_id, created_at DESC) WHERE visibility = 'public';

-- Collaborators: invited by the owner (friends or mutual follows), then they
-- accept or decline. They can see and add to the board while it is shared or
-- public, remove what they added, and leave at any time.
CREATE TABLE board_members (
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at  timestamptz,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_members_user_idx ON board_members (user_id, status);

-- Posts on a board, in the board's order (lowest position first; new items
-- go to the top). Who added each one is kept for credit and for "remove what
-- you added".
CREATE TABLE board_items (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position integer NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, post_id)
);
CREATE INDEX board_items_order_idx ON board_items (board_id, position, post_id);
CREATE INDEX board_items_post_idx ON board_items (post_id);
