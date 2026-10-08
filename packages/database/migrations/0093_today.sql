-- Yapilapi Today: a short daily spoken briefing of what your people and your city are talking
-- about (docs/product/yapilapi-today.md, apps/api/src/lib/today.ts). 0091 and 0092 belong to
-- Yap Radio and Ask the city.

-- Settings → Yapilapi Today. NULL means the default: on, at 7:00 in the person's time zone, with
-- their city, and no notification.
ALTER TABLE user_preferences
  ADD COLUMN today        boolean,
  ADD COLUMN today_hour   smallint CHECK (today_hour BETWEEN 5 AND 11),
  ADD COLUMN today_city   boolean,
  ADD COLUMN today_notify boolean;

-- The city part of a day's briefing, made once per city, local day and language and shared by
-- everyone there who reads that language. Only public posts by adults go in; each reader then
-- gets only the segments whose every source they can see (blocks, mutes, regional rules).
CREATE TABLE today_city_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_key   text NOT NULL CHECK (char_length(city_key) BETWEEN 1 AND 60),
  day        date NOT NULL,
  lang       text NOT NULL,
  -- [{ "text": "...", "sources": ["<post id>", ...], "audioUrl": "..." }]
  segments   jsonb NOT NULL DEFAULT '[]',
  provider   text NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_key, day, lang)
);

-- One briefing per person and local day. `empty`: there was nothing to say (nothing is shown).
CREATE TABLE today_briefings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          date NOT NULL,
  timezone     text NOT NULL,
  lang         text NOT NULL,
  -- [{ "kind": "people" | "city", "text": "...", "sources": ["<post id>", ...], "audioUrl": "..." }]
  segments     jsonb NOT NULL DEFAULT '[]',
  empty        boolean NOT NULL DEFAULT false,
  -- Segments the person said "Not interested in this" to (their positions in `segments`).
  hidden       smallint[] NOT NULL DEFAULT '{}',
  provider     text NOT NULL,
  model        text NOT NULL,
  dismissed_at timestamptz,
  notified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);
CREATE INDEX today_briefings_created_idx ON today_briefings (created_at);

-- "Not interested in this": the posts and people a segment was about stay out of that person's
-- next briefings for 30 days (lib/today.ts). Nothing else (feeds, recommendations) changes.
CREATE TABLE today_feedback (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX today_feedback_user_idx ON today_feedback (user_id, created_at);

-- New model calls per day (UTC) for everyone together, against TODAY_DAILY_LIMIT, and characters
-- read out for Today, against TODAY_TTS_DAILY_CHAR_LIMIT (on top of TTS_DAILY_CHAR_LIMIT).
CREATE TABLE today_budget (
  day   date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  chars integer NOT NULL DEFAULT 0 CHECK (chars >= 0)
);

-- A briefing's spoken clips are for it (and a city part's for that part): when it goes, so do
-- they, and the worker's speech sweep deletes clips nothing is for any more.
CREATE FUNCTION today_forget_speech() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM speech_clip_uses WHERE kind = TG_ARGV[0] AND item_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER today_briefings_forget AFTER DELETE ON today_briefings FOR EACH ROW EXECUTE FUNCTION today_forget_speech('today');
CREATE TRIGGER today_city_forget AFTER DELETE ON today_city_segments FOR EACH ROW EXECUTE FUNCTION today_forget_speech('today_city');
