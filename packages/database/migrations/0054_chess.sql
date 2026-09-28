-- Chess joins the games in chats (0046). The rules live in packages/shared/src/games/chess.ts; the
-- board is stored in `state` like the other games (a FEN-like position, the move list in standard
-- notation, position hashes for repetition, and any standing draw offer). Draw offers and answers
-- are rows in chat_game_moves ({"draw": "offer" | "accept" | "decline"}), like forfeits.
ALTER TABLE chat_games DROP CONSTRAINT chat_games_kind_check;
ALTER TABLE chat_games ADD CONSTRAINT chat_games_kind_check CHECK (kind IN ('four_up', 'noughts', 'word_ladder', 'chess'));
