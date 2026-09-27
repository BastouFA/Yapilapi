-- "Ask me": a question box on profiles. People turn it on with an optional prompt, choose who can
-- ask and whether askers may hide their name from the public; answers show on an Answers tab and
-- can be shared as a post that quotes the question.

-- One row per person who has set up their box. `allow_hidden_names` is never honoured for people
-- under 18 (checked in the API, which also refuses to turn it on for them).
CREATE TABLE ask_boxes (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  prompt             text CHECK (char_length(prompt) <= 120),
  audience           text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'following', 'friends')),
  allow_hidden_names boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Questions and their answers. A question asked "without your name shown" is never anonymous to
-- us: `asker_id` is always stored, blocks and limits apply to it and moderators see it. The API
-- never gives it to anyone else, the person asked included.
--
-- State for the person asked: new (answered_at and hidden_at NULL), answered, or hidden. Held
-- questions (moderation_status 'review' or 'restricted' before an answer) don't reach them.
CREATE TABLE ask_questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asker_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
  hide_name         boolean NOT NULL DEFAULT false,
  answer            text CHECK (char_length(answer) BETWEEN 1 AND 1000),
  answered_at       timestamptz,
  hidden_at         timestamptz,
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK ((answer IS NULL) = (answered_at IS NULL)),
  CHECK (asker_id <> recipient_id)
);
CREATE INDEX ask_questions_inbox_idx ON ask_questions (recipient_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ask_questions_answers_idx ON ask_questions (recipient_id, answered_at DESC) WHERE answered_at IS NOT NULL AND deleted_at IS NULL;
-- Pace per asker (all their questions, and to one person) and repeated text.
CREATE INDEX ask_questions_asker_idx ON ask_questions (asker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ask_questions_deleted_idx ON ask_questions (deleted_at) WHERE deleted_at IS NOT NULL;

-- "Block by question": the person asked blocks whoever asked one of their questions without
-- learning who it is. It stops that person asking them anything and hides their box and answers
-- from them. A named question is blocked with an ordinary block instead. One row per question
-- blocked from (never merged per asker), so blocking from one question says nothing about the
-- others: the owner can't tell two questions came from the same person.
CREATE TABLE ask_blocks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asker_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The question it was made from, so it can be undone from there.
  question_id  uuid REFERENCES ask_questions(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, question_id)
);
CREATE INDEX ask_blocks_pair_idx ON ask_blocks (recipient_id, asker_id);

-- An answer shared as a post quotes its question.
ALTER TABLE posts ADD COLUMN question_id uuid REFERENCES ask_questions(id) ON DELETE SET NULL;
CREATE INDEX posts_question_idx ON posts (question_id) WHERE question_id IS NOT NULL;

-- Questions (by their asker) and answer cards (by the person who answered) can be reported.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live', 'question', 'answer'));

-- Profiles can show an Answers tab (packages/shared/src/profile-style.ts PROFILE_TABS).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tabs_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_tabs_check CHECK (tabs IS NULL OR (cardinality(tabs) BETWEEN 1 AND 8));
