-- Chapters: keeping stories.
--
-- Expired stories stay in the author's private archive (moments past
-- `expires_at` that aren't deleted; nothing here changes that table). A
-- chapter is a titled collection of stories on a profile, with its own
-- audience. It can be shared (mutual follows add their own stories, credited
-- to them), a time capsule (sealed until a date: nothing but the cover, the
-- date and the count before then), and has a guestbook of one short line per
-- viewer.

CREATE TABLE chapters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  description        text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  -- Minors can't choose 'public' (checked by the API, and a public chapter
  -- of someone under 18 is read as 'followers').
  audience           text NOT NULL DEFAULT 'followers'
                     CHECK (audience IN ('public', 'followers', 'friends', 'close_friends', 'only_me')),
  -- The cover: one of the chapter's stories, or a brand gradient with a symbol.
  cover_moment_id    uuid REFERENCES moments(id) ON DELETE SET NULL,
  cover_gradient     text NOT NULL DEFAULT 'yapi' CHECK (cover_gradient IN ('yapi', 'sunrise', 'saffron', 'dusk', 'lagoon', 'ink')),
  cover_symbol       text NOT NULL DEFAULT 'star'
                     CHECK (cover_symbol IN ('star', 'sparkle', 'heart', 'music', 'globe', 'calendar', 'compass', 'home', 'bookmark', 'image')),
  -- Time capsule: sealed until `opens_at`. Adding stays open until the owner
  -- seals it (`sealed_at`) or the date comes, whichever is first.
  opens_at           timestamptz,
  sealed_at          timestamptz,
  -- Set when the owner and contributors were told it opened.
  opened_notified_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CHECK (sealed_at IS NULL OR opens_at IS NOT NULL)
);
CREATE INDEX chapters_owner_idx ON chapters (owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX chapters_opening_idx ON chapters (opens_at) WHERE opens_at IS NOT NULL AND opened_notified_at IS NULL AND deleted_at IS NULL;

-- Contributors to a shared chapter: invited by the owner (mutual follows),
-- then accepted. Each chooses whether it also shows on their own profile.
CREATE TABLE chapter_members (
  chapter_id      uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted')),
  show_on_profile boolean NOT NULL DEFAULT false,
  invited_at      timestamptz NOT NULL DEFAULT now(),
  joined_at       timestamptz,
  PRIMARY KEY (chapter_id, user_id)
);
CREATE INDEX chapter_members_user_idx ON chapter_members (user_id, status);

-- Stories in a chapter. Everyone adds only their own stories, so the story's
-- author is the credit. Played in the order they were first shared.
CREATE TABLE chapter_items (
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  moment_id  uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chapter_id, moment_id)
);
CREATE INDEX chapter_items_moment_idx ON chapter_items (moment_id);

-- The guestbook: one short line per person per chapter, checked with the
-- text moderation. Lines held for review show only to the person who wrote
-- them; the owner can hide any line.
CREATE TABLE chapter_guestbook (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 140),
  status     text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'review')),
  hidden_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, author_id)
);
CREATE INDEX chapter_guestbook_chapter_idx ON chapter_guestbook (chapter_id, created_at DESC);

-- The archive: your stories past their expiry, newest first.
CREATE INDEX moments_archive_idx ON moments (author_id, expires_at DESC) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
