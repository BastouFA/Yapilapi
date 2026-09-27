/** The games you can play in a chat. */
export const GAME_KINDS = ['four_up', 'noughts', 'word_ladder'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/** The games' names in English: the body of a game's message, so previews and search read sensibly. The apps show their own translations. */
export const GAME_NAMES: Record<GameKind, string> = { four_up: 'Four up', noughts: 'Noughts', word_ladder: 'Word ladder' };

/** How many people play each game (seats). */
export const GAME_PLAYERS: Record<GameKind, { min: number; max: number }> = {
  four_up: { min: 2, max: 2 },
  noughts: { min: 2, max: 2 },
  word_ladder: { min: 2, max: 6 },
};

/** A game with no move for this long ends unfinished. */
export const GAME_IDLE_HOURS = 24;

/**
 * How a game ended. Players are seats: 0 is whoever started it, then the others in turn.
 * `line` is the winning cells on a board (Four up, Noughts).
 */
export type GameResult = { type: 'win'; winner: number; by: 'play' | 'forfeit'; line?: number[] } | { type: 'draw' } | { type: 'unfinished' };

interface GameBase {
  /** Seats in the game (2 for Four up and Noughts, 2 to 6 for Word ladder). */
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

export type GameState = FourUpState | NoughtsState | WordLadderState;

/** A move: a column (Four up, 0 to 6), a cell (Noughts, 0 to 8), a word or a pass (Word ladder). */
export type GameMove = { column: number } | { cell: number } | { word: string } | { pass: true };

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
  | 'word_used';

export type MoveOutcome = { ok: true; state: GameState } | { ok: false; error: GameError };
