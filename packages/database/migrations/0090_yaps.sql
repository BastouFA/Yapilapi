-- Yaps: "the social network you speak" (docs/product/yaps.md, packages/shared/src/voice.ts,
-- apps/api/src/lib/voice.ts).
--
-- A Yap is a post (format 'yap', kind 'audio') whose one media item is a voice clip of up to 60
-- seconds, so feeds, audiences (squads included), place tags, comments, reports, stats, export and
-- deletion work for it as for any post. The same clips also answer posts by voice (a comment's
-- voice_media_id) and introduce people on their profile (profiles.voice_intro_media_id, up to 15
-- seconds).

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_format_check;
ALTER TABLE posts ADD CONSTRAINT posts_format_check CHECK (format IN ('post', 'reel', 'yap'));
-- The Yaps filter on Pulse, newest first.
CREATE INDEX posts_yaps_idx ON posts (created_at DESC, id DESC) WHERE format = 'yap' AND deleted_at IS NULL;

-- One row per recorded clip, next to its media row (the audio file itself, stored small: AAC mono
-- at about 32 kbit/s, so a full minute is about 240 KB). Made by POST /v1/voice before it is
-- attached; a clip goes on one post, comment or profile only.
CREATE TABLE voice_clips (
  media_id          uuid PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose           text NOT NULL CHECK (purpose IN ('yap', 'comment', 'intro')),
  -- Measured on the server from the stored file, never taken from the app.
  duration_ms       integer NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 61000),
  -- Loudness bars for drawing the waveform (0 to 100, evenly spaced over the clip).
  peaks             smallint[] NOT NULL DEFAULT '{}',
  -- pending: being transcribed; ready: words below; unavailable: no speech-to-text is set up;
  -- failed: the provider failed or heard no words. Moderation then relies on reports.
  transcript_status text NOT NULL DEFAULT 'pending' CHECK (transcript_status IN ('pending', 'ready', 'unavailable', 'failed')),
  transcript        text,
  -- Timed lines when the provider gives them: [{ "start": 0.0, "end": 1.5, "text": "..." }], seconds.
  segments          jsonb,
  -- The language the words are in (ISO 639-1), detected from them.
  lang              text,
  -- The words went through the same text checks as a post's: 'passed', or 'held' (the post or
  -- comment was held for review or restricted). Null until there are words to check.
  screened          text CHECK (screened IN ('passed', 'held')),
  transcribed_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Transcripts are found by search like a post's own words.
  search            tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(transcript, ''))) STORED
);
CREATE INDEX voice_clips_owner_idx ON voice_clips (owner_id, created_at DESC);
CREATE INDEX voice_clips_search_idx ON voice_clips USING gin (search);
CREATE INDEX voice_clips_pending_idx ON voice_clips (created_at) WHERE transcript_status = 'pending';

-- Talk back: a comment (or reply) can be a voice clip, with or without words of its own.
ALTER TABLE comments ADD COLUMN voice_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX comments_voice_idx ON comments (voice_media_id) WHERE voice_media_id IS NOT NULL;

-- A voice intro of up to 15 seconds, played from the profile header.
ALTER TABLE profiles ADD COLUMN voice_intro_media_id uuid REFERENCES media(id) ON DELETE SET NULL;

-- Listening, for ranking and the author's numbers: listen_start (once per person and surface in 30
-- minutes), listen (how long it played, value_ms) and listen_complete (played to the end).
ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_kind_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_kind_check
  CHECK (kind IN ('impression', 'dwell', 'watch', 'complete', 'skip', 'share', 'profile_open', 'listen_start', 'listen', 'listen_complete'));
ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_surface_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_surface_check
  CHECK (surface IN ('for_you', 'reels', 'following', 'friends', 'communities', 'profile', 'tag', 'search', 'other', 'yaps', 'squad', 'place'));
ALTER TABLE feed_sessions DROP CONSTRAINT IF EXISTS feed_sessions_surface_check;
ALTER TABLE feed_sessions ADD CONSTRAINT feed_sessions_surface_check CHECK (surface IN ('for_you', 'reels', 'yaps'));
ALTER TABLE post_stats ADD COLUMN listens integer NOT NULL DEFAULT 0 CHECK (listens >= 0);
ALTER TABLE post_stats ADD COLUMN listen_ms bigint NOT NULL DEFAULT 0 CHECK (listen_ms >= 0);
ALTER TABLE post_stats ADD COLUMN listen_completes integer NOT NULL DEFAULT 0 CHECK (listen_completes >= 0);

-- A transcript is translated like a post's words (kind 'voice', item_id the clip's media id) and its
-- translation can be heard ("Listen in …", spoken clips for kind 'voice': lib/speech.ts). Both go as
-- soon as the words change or the clip is deleted. Every existing kind is kept (0089 added 'transcript').
ALTER TABLE translations DROP CONSTRAINT translations_kind_check;
ALTER TABLE translations ADD CONSTRAINT translations_kind_check CHECK (kind IN ('post', 'comment', 'story', 'message', 'caption', 'transcript', 'voice'));
CREATE FUNCTION forget_voice_translations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM translations WHERE kind = 'voice' AND item_id = OLD.media_id;
  DELETE FROM speech_clip_uses WHERE kind = 'voice' AND item_id = OLD.media_id;
  RETURN NULL;
END $$;
CREATE TRIGGER voice_clips_forget_translations AFTER UPDATE OF transcript ON voice_clips FOR EACH ROW
  WHEN (OLD.transcript IS DISTINCT FROM NEW.transcript)
  EXECUTE FUNCTION forget_voice_translations();
CREATE TRIGGER voice_clips_forget_translations_on_delete AFTER DELETE ON voice_clips FOR EACH ROW
  EXECUTE FUNCTION forget_voice_translations();
