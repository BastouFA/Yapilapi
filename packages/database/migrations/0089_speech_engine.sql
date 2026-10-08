-- Speak any language, step 2: voice messages everyone understands, and the speech engine
-- (docs/product/speech-engine.md, docs/product/speak-any-language.md).

-- "Transcribe my voice messages" (Settings > Privacy > AI helpers), on unless the person turns it
-- off. Off: no transcript is made of their voice messages, and the ones made before are deleted.
ALTER TABLE user_preferences ADD COLUMN transcribe_voice boolean NOT NULL DEFAULT true;

-- The words of a voice message in a chat (a voice note or a Yap), made by the speech-to-text
-- provider in a job: 'pending' until then, 'ready' with the words and their language, 'empty'
-- when nothing was said, 'failed' when the provider couldn't. Never made for view-once or
-- disappearing messages. Only members of the chat read it, through the message's own checks.
CREATE TABLE message_transcripts (
  message_id   uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'empty', 'failed')),
  body         text,
  lang         text,
  provider     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- A transcript is translated like a message (kind 'transcript', item_id the message's id).
ALTER TABLE translations DROP CONSTRAINT translations_kind_check;
ALTER TABLE translations ADD CONSTRAINT translations_kind_check CHECK (kind IN ('post', 'comment', 'story', 'message', 'caption', 'transcript'));

-- Spoken clips (text-to-speech), one per text, language, voice and model, shared by everyone who
-- listens. text_hash is a SHA-256 of the text; the text itself is never stored here.
CREATE TABLE speech_clips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text_hash    text NOT NULL,
  lang         text NOT NULL,
  voice        text NOT NULL,
  model        text NOT NULL,
  provider     text NOT NULL,
  storage_key  text NOT NULL,
  url          text NOT NULL,
  mime         text NOT NULL,
  chars        integer NOT NULL,
  size_bytes   integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (text_hash, lang, voice, model)
);

-- What each clip is for (a transcript's translation, say). A clip nothing is for any more is
-- deleted with its file by the worker's sweep (sweepSpeech).
CREATE TABLE speech_clip_uses (
  clip_id     uuid NOT NULL REFERENCES speech_clips(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  item_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, kind, item_id)
);
CREATE INDEX speech_clip_uses_item_idx ON speech_clip_uses (kind, item_id);

-- Characters spoken in new clips per day (UTC), for everyone together, against TTS_DAILY_CHAR_LIMIT.
CREATE TABLE speech_budget (
  day    date PRIMARY KEY,
  chars  integer NOT NULL DEFAULT 0 CHECK (chars >= 0)
);

-- A transcript that goes takes its translations and spoken clips with it.
CREATE FUNCTION forget_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM translations WHERE kind = 'transcript' AND item_id = OLD.message_id;
  DELETE FROM speech_clip_uses WHERE kind = 'transcript' AND item_id = OLD.message_id;
  RETURN NULL;
END $$;
CREATE TRIGGER message_transcripts_forget AFTER DELETE ON message_transcripts FOR EACH ROW EXECUTE FUNCTION forget_transcript();
CREATE TRIGGER message_transcripts_forget_on_change AFTER UPDATE OF body ON message_transcripts FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body) EXECUTE FUNCTION forget_transcript();

-- An unsent or deleted message takes its transcript with it (a message deleted outright, when it
-- disappears, does through the foreign key).
CREATE FUNCTION forget_message_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM message_transcripts WHERE message_id = OLD.id;
  RETURN NULL;
END $$;
CREATE TRIGGER messages_forget_transcript AFTER UPDATE OF deleted_at, unsent_at ON messages FOR EACH ROW
  WHEN ((NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) OR (NEW.unsent_at IS NOT NULL AND OLD.unsent_at IS NULL))
  EXECUTE FUNCTION forget_message_transcript();
