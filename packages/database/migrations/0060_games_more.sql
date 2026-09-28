-- More than one game at a time in a chat. Until now a chat could have one game of each kind going
-- (0046's unique index), so people who wanted a second board hit "already going here". Now a chat
-- can have up to 6 games going at once, and up to 3 of the same kind (GAME_ACTIVE_LIMIT and
-- GAME_KIND_ACTIVE_LIMIT in packages/shared/src/games/types.ts; keep the numbers below the same).
--
-- The limits are checked when a game is inserted, under a lock per chat (a transaction-level
-- advisory lock), so two starts at once can't both take the last place. A game never goes back to
-- 'active' once it has ended, so inserts are the only way in. The API turns the two errors
-- (constraint names chat_games_active_limit and chat_games_kind_limit) into plain messages.

DROP INDEX chat_games_one_active;
-- The games going in a chat (the start sheet lists them; the limits count them).
CREATE INDEX chat_games_active_idx ON chat_games (conversation_id, kind) WHERE status = 'active';

CREATE FUNCTION chat_games_active_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total integer;
  same integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_games:' || NEW.conversation_id::text, 0));
  SELECT count(*), count(*) FILTER (WHERE kind = NEW.kind) INTO total, same
    FROM chat_games WHERE conversation_id = NEW.conversation_id AND status = 'active';
  IF total >= 6 THEN
    RAISE EXCEPTION 'this chat already has 6 games going' USING ERRCODE = 'check_violation', CONSTRAINT = 'chat_games_active_limit';
  END IF;
  IF same >= 3 THEN
    RAISE EXCEPTION 'this chat already has 3 games of this kind going' USING ERRCODE = 'check_violation', CONSTRAINT = 'chat_games_kind_limit';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER chat_games_active_limit BEFORE INSERT ON chat_games
  FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION chat_games_active_limit();
