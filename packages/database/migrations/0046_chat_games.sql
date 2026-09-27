-- Games in chats (one-to-one and groups): Four up, Noughts and Word ladder.
--
-- A game is a message (kind 'message'; its body is the game's name, so previews and
-- search read sensibly) with a row here keyed by the message, like polls and lists
-- (0036). The rules live in packages/shared/src/games: `state` is the board exactly as
-- those functions return it, and the API checks every move with them.
--
-- Everything cascades from the message: unsending the card or a disappearing chat
-- deleting it takes the game and its moves with it.

CREATE TABLE chat_games (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('four_up', 'noughts', 'word_ladder')),
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Seat order: players[1] moves first (whoever started it; in a rematch, the next one along).
  players         uuid[] NOT NULL CHECK (cardinality(players) BETWEEN 2 AND 6),
  state           jsonb NOT NULL,
  -- Moves applied so far, forfeits included. A move names the number it expects (optimistic concurrency).
  move_number     integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'won', 'draw', 'unfinished')),
  winner_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_move_at    timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  rematch_of      uuid REFERENCES chat_games(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- One game of each kind going at a time in a chat.
CREATE UNIQUE INDEX chat_games_one_active ON chat_games (conversation_id, kind) WHERE status = 'active';
-- One rematch per game (asking twice gets the same one).
CREATE UNIQUE INDEX chat_games_rematch_key ON chat_games (rematch_of) WHERE rematch_of IS NOT NULL;
-- The quiet per-chat tally of wins.
CREATE INDEX chat_games_tally_idx ON chat_games (conversation_id, kind, winner_id) WHERE status = 'won';

-- Every move played, in order. A retry of the same move (same client move id) finds its row
-- and isn't played again.
CREATE TABLE chat_game_moves (
  game_id        uuid NOT NULL REFERENCES chat_games(id) ON DELETE CASCADE,
  number         integer NOT NULL,
  player_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- {"column": 3}, {"cell": 4}, {"word": "cord"}, {"pass": true} or {"forfeit": true}.
  move           jsonb NOT NULL,
  client_move_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, number)
);
CREATE UNIQUE INDEX chat_game_moves_client_key ON chat_game_moves (game_id, player_id, client_move_id) WHERE client_move_id IS NOT NULL;
