-- Ask the city (docs/product/ask-the-city.md, packages/shared/src/ask-city.ts,
-- apps/api/src/lib/ask-city.ts): questions to people nearby, answered by voice or text.
--
-- A question is a post (a Yap or a text post, shared with everyone) with a row here saying what
-- it's about and where. Answers are its comments (voice replies included), so moderation,
-- reports, blocks, translation and deletion work for them as for any comment. Where is an area,
-- never where the asker is: a city, and a place page (public already) or the middle of the part
-- of the map they were looking at, moved to a 2 km grid.

CREATE TABLE ask_city_questions (
  post_id    uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic      text NOT NULL CHECK (topic IN ('food', 'traffic', 'services', 'safety', 'events', 'shopping', 'other')),
  -- The city as written, and the key it's matched by (trimmed, lower case).
  city       text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 60),
  city_key   text NOT NULL,
  -- The part of the city: a place's name or a neighbourhood. Null for the whole city.
  area       text CHECK (char_length(area) <= 120),
  place_id   uuid REFERENCES places(id) ON DELETE SET NULL,
  -- The area's point for the map: a place page's, or the map's middle on the 2 km grid. Null when
  -- only a city is known (then the question is listed for the city, not on the map).
  lat        double precision,
  lng        double precision,
  -- When it stops being open; null: open for ASK_OPEN_DAYS.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX ask_city_questions_city_idx ON ask_city_questions (city_key, created_at DESC);
CREATE INDEX ask_city_questions_point_idx ON ask_city_questions (lat, lng) WHERE lat IS NOT NULL;
CREATE INDEX ask_city_questions_author_idx ON ask_city_questions (author_id, created_at DESC);

-- Answers the asker found helpful. The answerer and the city are kept for "Helped 12 people in
-- Lagos" on their profile; un-marking deletes the row, and so does deleting the answer.
CREATE TABLE ask_city_helpful (
  comment_id uuid PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES ask_city_questions(post_id) ON DELETE CASCADE,
  helper_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asker_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city       text NOT NULL,
  city_key   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ask_city_helpful_post_idx ON ask_city_helpful (post_id);
CREATE INDEX ask_city_helpful_helper_idx ON ask_city_helpful (helper_id, city_key);

-- "Help answer questions near me" (off unless there is a row): the city and the topics.
CREATE TABLE ask_city_helpers (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city       text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 60),
  city_key   text NOT NULL,
  topics     text[] NOT NULL CHECK (cardinality(topics) BETWEEN 1 AND 7),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ask_city_helpers_city_idx ON ask_city_helpers (city_key);

-- Who was told about which question: never twice, and at most ASK_NOTIFY_PER_DAY a day each.
CREATE TABLE ask_city_notified (
  post_id    uuid NOT NULL REFERENCES ask_city_questions(post_id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX ask_city_notified_user_idx ON ask_city_notified (user_id, created_at DESC);
