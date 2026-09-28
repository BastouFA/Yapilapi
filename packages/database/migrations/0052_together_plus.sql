-- Together, grown into a shared album for a trip, a wedding, a party or an event.
--
-- An album (togethers) has a title, a description, a cover chosen from its photos,
-- and a window for adding: open until `closes_at`, or until a host closes it
-- (`closes_at` NULL). Its people are the host (role 'creator'), co-hosts and
-- members. It can come from a group chat (a card is posted there) or an event.
--
-- Guests can ask to join with an invite link (`invite_code`, on while
-- `invite_enabled`); a host approves each request (together_requests).
--
-- Items (together_contributions) are photos and videos, each with the time it
-- was taken (from the file's date when the app knew it, else when it was added)
-- and an optional caption. Anyone in it can star an item, react with one of the
-- room reactions, and leave short comments. The best of an album is picked from
-- stars and reactions (packages/shared/src/together.ts, pickBestOf).
--
-- `closing_notified_at` and `closed_notified_at` make the "closes in an hour"
-- and "closed" notices go out once per closing (reopening clears them);
-- `closed_by` is the host who closed it early (NULL when its time came), and
-- `opened_at` when the current window began (made, reopened or given a new end).

ALTER TABLE togethers
  ADD COLUMN description         text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  ADD COLUMN cover_item_id       uuid REFERENCES together_contributions(id) ON DELETE SET NULL,
  ADD COLUMN conversation_id     uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN invite_code         text UNIQUE,
  ADD COLUMN invite_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN opened_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN closed_at           timestamptz,
  ADD COLUMN closed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN closing_notified_at timestamptz,
  ADD COLUMN closed_notified_at  timestamptz,
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at          timestamptz;
CREATE INDEX togethers_closing_idx ON togethers (closes_at) WHERE status = 'open' AND deleted_at IS NULL AND closes_at IS NOT NULL;
CREATE INDEX togethers_closed_idx ON togethers (closed_at) WHERE status = 'closed' AND closed_notified_at IS NULL AND deleted_at IS NULL;

ALTER TABLE together_members DROP CONSTRAINT IF EXISTS together_members_role_check;
ALTER TABLE together_members ADD CONSTRAINT together_members_role_check CHECK (role IN ('creator', 'cohost', 'member'));
ALTER TABLE together_members ADD COLUMN added_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Whether `captured_at` came from the file ('file') or is when it was added ('added').
ALTER TABLE together_contributions ADD COLUMN taken_source text NOT NULL DEFAULT 'added' CHECK (taken_source IN ('file', 'added'));
CREATE INDEX together_contributions_user_idx ON together_contributions (user_id);

CREATE TABLE together_requests (
  together_id uuid NOT NULL REFERENCES togethers(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  PRIMARY KEY (together_id, user_id)
);
CREATE INDEX together_requests_pending_idx ON together_requests (together_id, created_at) WHERE status = 'pending';

CREATE TABLE together_stars (
  item_id    uuid NOT NULL REFERENCES together_contributions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX together_stars_user_idx ON together_stars (user_id);

CREATE TABLE together_reactions (
  item_id    uuid NOT NULL REFERENCES together_contributions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('heart', 'star', 'sparkle', 'check', 'music')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX together_reactions_user_idx ON together_reactions (user_id);

CREATE TABLE together_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES together_contributions(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX together_comments_item_idx ON together_comments (item_id, created_at);
CREATE INDEX together_comments_author_idx ON together_comments (author_id);

-- A recap video can be made from an album's best photos and videos.
ALTER TABLE recaps DROP CONSTRAINT IF EXISTS recaps_source_type_check;
ALTER TABLE recaps ADD CONSTRAINT recaps_source_type_check CHECK (source_type IN ('memory', 'on_this_day', 'chapter', 'together'));

-- Photos and videos in an album can be reported.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live', 'question', 'answer', 'drop', 'mix', 'together_item'));
