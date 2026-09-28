/** The games you can play in a chat. */
export const GAME_KINDS = ['four_up', 'noughts', 'word_ladder', 'chess'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/** The games' names in English: the body of a game's message, so previews and search read sensibly. The apps show their own translations. */
export const GAME_NAMES: Record<GameKind, string> = { four_up: 'Four up', noughts: 'Noughts', word_ladder: 'Word ladder', chess: 'Chess' };

/** How many people play each game (seats). */
export const GAME_PLAYERS: Record<GameKind, { min: number; max: number }> = {
  four_up: { min: 2, max: 2 },
  noughts: { min: 2, max: 2 },
  word_ladder: { min: 2, max: 6 },
  chess: { min: 2, max: 2 },
};

/** A game with no move for this long ends unfinished. */
export const GAME_IDLE_HOURS = 24;

/**
 * Games going at once in one chat: 6 in all, and 3 of the same kind (migration 0060 checks the same
 * numbers when a game starts).
 */
export const GAME_ACTIVE_LIMIT = 6;
export const GAME_KIND_ACTIVE_LIMIT = 3;

/** Whether another game of `kind` can start in a chat with these games going (`kinds`: one per game). */
export function gameStartBlock(kinds: readonly GameKind[], kind: GameKind): 'games_full' | 'game_kind_full' | null {
  if (kinds.length >= GAME_ACTIVE_LIMIT) return 'games_full';
  if (kinds.filter((k) => k === kind).length >= GAME_KIND_ACTIVE_LIMIT) return 'game_kind_full';
  return null;
}

/**
 * Why a game of chess was drawn: no legal move and not in check, the same position three times,
 * fifty moves each without a capture or a pawn move, too few pieces left for anyone to checkmate,
 * or both players agreed.
 */
export type DrawReason = 'stalemate' | 'repetition' | 'fifty_moves' | 'material' | 'agreed';

/**
 * How a game ended. Players are seats: 0 is whoever started it, then the others in turn.
 * `line` is the winning cells on a board (Four up, Noughts). In chess, a win 'by play' is checkmate
 * and 'by forfeit' is a resignation; a draw says why.
 */
export type GameResult =
  { type: 'win'; winner: number; by: 'play' | 'forfeit'; line?: number[] } | { type: 'draw'; reason?: DrawReason } | { type: 'unfinished' };

interface GameBase {
  /** Seats in the game (2 for Four up, Noughts and Chess, 2 to 6 for Word ladder). */
  seats: number;
  /** Whose turn it is (a seat). Meaningless once `result` is set. */
  turn: number;
  /** Moves played on the board (a pass counts). */
  moves: number;
  /** Seats that forfeited and are out of the game. */
  out: number[];
  result: GameResult | null;
}

/** Four up: a 7 by 6 board. `cells` is row by row from the top (index = row * 7 + column); each is a seat or null. */
export interface FourUpState extends GameBase {
  kind: 'four_up';
  cells: (number | null)[];
  /** The cell of the last disc dropped. */
  last: number | null;
}

/** Noughts: a 3 by 3 board, row by row from the top. Seat 0 plays X, seat 1 plays O. */
export interface NoughtsState extends GameBase {
  kind: 'noughts';
  cells: (number | null)[];
  last: number | null;
}

export interface LadderRung {
  word: string;
  seat: number;
}

/** Word ladder: from `start`, change one letter at a time until someone reaches `target`. */
export interface WordLadderState extends GameBase {
  kind: 'word_ladder';
  start: string;
  target: string;
  /** Words added so far, in order (the last one is the current word). */
  rungs: LadderRung[];
  /** Passes in a row since the last word: when everyone still playing passes, it's a draw. */
  passes: number;
  /** The fewest steps from start to target. */
  best: number;
  /** The last move was a pass by this seat (null after a word). */
  lastPass: number | null;
}

export type ChessColor = 'w' | 'b';
export type ChessPieceType = 'k' | 'q' | 'r' | 'b' | 'n' | 'p';
/** What a pawn reaching the far side becomes. */
export type ChessPromotion = 'q' | 'r' | 'b' | 'n';

/** A chess move as the apps send it: squares by name ("e2", "e4"), and the piece a pawn becomes on the last rank. */
export interface ChessMoveInput {
  from: string;
  to: string;
  promotion?: ChessPromotion;
}

/** The last move on a chess board, for highlighting it and reading it out. */
export interface ChessLastMove {
  from: string;
  to: string;
  piece: ChessPieceType;
  captured?: ChessPieceType;
  promotion?: ChessPromotion;
  /** Castling: 'k' kingside (O-O), 'q' queenside (O-O-O). */
  castle?: 'k' | 'q';
  enPassant?: true;
}

/**
 * Chess, stored compactly like FEN: `board` is the piece placement from rank 8 down to rank 1
 * ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"), then the side to move, castling rights ("KQkq"
 * or "-"), the en passant target square, and the half-move clock and move number. `seen` holds a
 * short hash of each position since the last capture or pawn move (for threefold repetition), and
 * `san` the moves in standard algebraic notation. `white` is the seat playing white.
 */
export interface ChessState extends GameBase {
  kind: 'chess';
  white: number;
  board: string;
  side: ChessColor;
  castling: string;
  ep: string | null;
  halfmove: number;
  fullmove: number;
  seen: string[];
  san: string[];
  last: ChessLastMove | null;
  /** A standing draw offer: who made it, and `moves` when they did. It lapses after the offerer's next move. */
  drawOffer: { seat: number; at: number } | null;
  /** For each seat, `moves` at its last draw offer (one offer per move of your own). */
  offeredAt: number[];
}

export type GameState = FourUpState | NoughtsState | WordLadderState | ChessState;

/** A move: a column (Four up, 0 to 6), a cell (Noughts, 0 to 8), a word or a pass (Word ladder), squares (Chess). */
export type GameMove = { column: number } | { cell: number } | { word: string } | { pass: true } | ChessMoveInput;

/** What a chess player can do about a draw: offer one, or accept or decline the other player's offer. */
export type DrawAction = 'offer' | 'accept' | 'decline';

export type GameError =
  | 'game_over'
  | 'not_your_turn'
  | 'not_a_player'
  | 'wrong_move'
  | 'bad_column'
  | 'column_full'
  | 'bad_cell'
  | 'cell_taken'
  | 'not_four_letters'
  | 'not_a_word'
  | 'not_one_letter'
  | 'word_used'
  | 'bad_square'
  | 'not_your_piece'
  | 'illegal_move'
  | 'promotion_needed'
  | 'bad_promotion'
  | 'no_draw_offer'
  | 'draw_offered'
  | 'draw_too_soon';

export type MoveOutcome = { ok: true; state: GameState } | { ok: false; error: GameError };
