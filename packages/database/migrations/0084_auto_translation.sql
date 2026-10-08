-- Speak any language, step 1: translation becomes automatic (docs/product/speak-any-language.md).

-- "Translate automatically" is on by default. It was off by default and there's no telling a
-- choice from the default, so everyone starts with it on; the switch is in Settings > Language.
ALTER TABLE user_preferences ALTER COLUMN auto_translate SET DEFAULT true;
UPDATE user_preferences SET auto_translate = true WHERE NOT auto_translate;

-- Caption tracks can be translated too: one translation per track, target language and version
-- of the track (content_hash of its WebVTT), body is the translated WebVTT.
ALTER TABLE translations DROP CONSTRAINT translations_kind_check;
ALTER TABLE translations ADD CONSTRAINT translations_kind_check CHECK (kind IN ('post', 'comment', 'story', 'message', 'caption'));

-- Translations of a track go when it gets a new file or is deleted (a new file has a new key).
CREATE TRIGGER caption_tracks_forget_translations AFTER UPDATE OF storage_key ON caption_tracks FOR EACH ROW
  WHEN (OLD.storage_key IS DISTINCT FROM NEW.storage_key)
  EXECUTE FUNCTION forget_translations('caption');
CREATE TRIGGER caption_tracks_forget_translations_on_delete AFTER DELETE ON caption_tracks FOR EACH ROW
  EXECUTE FUNCTION forget_translations('caption');

-- Pseudo-translations from the offline stand-in provider were never real translations: none is
-- kept, so none is ever served once a translation model is set up.
DELETE FROM translations WHERE provider = 'dev';

-- New automatic translations made per day (UTC), for everyone together, against
-- AUTO_TRANSLATE_DAILY_LIMIT. A slot is taken before the model is asked.
CREATE TABLE translation_budget (
  day   date PRIMARY KEY,
  used  integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);
