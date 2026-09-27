-- "See translation".
--
-- The language of a post, comment, story text or chat message is detected when
-- it's written or edited (ISO 639-1, NULL when it couldn't be told). Apps compare
-- it with the reader's languages to offer "See translation".
ALTER TABLE posts ADD COLUMN lang text;
ALTER TABLE comments ADD COLUMN lang text;
ALTER TABLE moments ADD COLUMN lang text;
ALTER TABLE messages ADD COLUMN lang text;

-- "Languages I understand" (besides the app's language, which always counts) and
-- "Translate automatically" (off unless the person turns it on).
ALTER TABLE user_preferences
  ADD COLUMN languages text[] NOT NULL DEFAULT '{}',
  ADD COLUMN auto_translate boolean NOT NULL DEFAULT false;

-- Machine translations, one per item, target language and version of the text
-- (content_hash is a SHA-256 of the text that was translated), so an edit never
-- serves an old translation. Anyone who can see the item may read its cached
-- translation; the API checks that on every request before looking here.
CREATE TABLE translations (
  kind          text NOT NULL CHECK (kind IN ('post', 'comment', 'story', 'message')),
  item_id       uuid NOT NULL,
  target        text NOT NULL,
  content_hash  text NOT NULL,
  source_lang   text NOT NULL,
  body          text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, item_id, target, content_hash)
);

-- Translations go as soon as the text changes, the item is deleted or a message is
-- unsent, so no copy of words someone removed is kept.
CREATE FUNCTION forget_translations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM translations WHERE kind = TG_ARGV[0] AND item_id = OLD.id;
  RETURN NULL;
END $$;

CREATE TRIGGER posts_forget_translations AFTER UPDATE OF body, deleted_at ON posts FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION forget_translations('post');
CREATE TRIGGER posts_forget_translations_on_delete AFTER DELETE ON posts FOR EACH ROW EXECUTE FUNCTION forget_translations('post');

CREATE TRIGGER comments_forget_translations AFTER UPDATE OF body, deleted_at ON comments FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION forget_translations('comment');
CREATE TRIGGER comments_forget_translations_on_delete AFTER DELETE ON comments FOR EACH ROW EXECUTE FUNCTION forget_translations('comment');

CREATE TRIGGER moments_forget_translations AFTER UPDATE OF body, deleted_at ON moments FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION forget_translations('story');
CREATE TRIGGER moments_forget_translations_on_delete AFTER DELETE ON moments FOR EACH ROW EXECUTE FUNCTION forget_translations('story');

CREATE TRIGGER messages_forget_translations AFTER UPDATE OF body, deleted_at, unsent_at ON messages FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) OR (NEW.unsent_at IS NOT NULL AND OLD.unsent_at IS NULL))
  EXECUTE FUNCTION forget_translations('message');
CREATE TRIGGER messages_forget_translations_on_delete AFTER DELETE ON messages FOR EACH ROW EXECUTE FUNCTION forget_translations('message');

-- The per-person translation limit counts recent translate calls in the AI audit log.
CREATE INDEX ai_tool_calls_user_task_idx ON ai_tool_calls (user_id, task, created_at DESC);
