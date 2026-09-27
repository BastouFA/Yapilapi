import { newFourUp, playFourUp } from './four-up.ts';
import { newNoughts, playNoughts } from './noughts.ts';
import { activeSeats, nextSeat } from './turns.ts';
import { GAME_PLAYERS, type GameKind, type GameMove, type GameState, type MoveOutcome } from './types.ts';
import { newWordLadder, playWordLadder } from './word-ladder.ts';

/**
 * Games in chats: Four up, Noughts and Word ladder. Everything here is pure and deterministic, so
 * the server checks every move with the same rules the apps use to draw the board. A game's state
 * is plain JSON (stored as is); players are seats, 0 being whoever started it.
 */
export * from './types.ts';
export * from './turns.ts';
export * from './four-up.ts';
export * from './noughts.ts';
export * from './word-ladder.ts';
export { FOUR_LETTER_WORDS } from './words.ts';

/** A new game for `seats` players. `seed` picks Word ladder's words (the others don't use it). */
export function newGame(kind: GameKind, seats: number, seed = 0): GameState {
  const { min, max } = GAME_PLAYERS[kind];
  if (!Number.isInteger(seats) || seats < min || seats > max) throw new RangeError(`${kind} takes ${min} to ${max} players`);
  if (kind === 'four_up') return newFourUp();
  if (kind === 'noughts') return newNoughts();
  return newWordLadder(seats, seed);
}

/** Play a move for `seat`. Nothing changes when it isn't allowed; the error says why. */
export function applyMove(state: GameState, seat: number, move: GameMove): MoveOutcome {
  if (state.result) return { ok: false, error: 'game_over' };
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.seats || state.out.includes(seat)) return { ok: false, error: 'not_a_player' };
  if (seat !== state.turn) return { ok: false, error: 'not_your_turn' };
  if (state.kind === 'four_up') return 'column' in move ? playFourUp(state, seat, move) : { ok: false, error: 'wrong_move' };
  if (state.kind === 'noughts') return 'cell' in move ? playNoughts(state, seat, move) : { ok: false, error: 'wrong_move' };
  return 'word' in move || 'pass' in move ? playWordLadder(state, seat, move) : { ok: false, error: 'wrong_move' };
}

/**
 * `seat` gives up. With one player left, they win; otherwise (Word ladder with three or more) the
 * others play on without them.
 */
export function forfeit(state: GameState, seat: number): MoveOutcome {
  if (state.result) return { ok: false, error: 'game_over' };
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.seats || state.out.includes(seat)) return { ok: false, error: 'not_a_player' };
  const out = [...state.out, seat];
  const left = activeSeats(state.seats, out);
  const turn = state.turn === seat ? nextSeat(state.seats, out, seat) : state.turn;
  const result = left.length === 1 ? ({ type: 'win', winner: left[0]!, by: 'forfeit' } as const) : null;
  // Word ladder: the count of passes in a row starts again with the players still in.
  const extra = state.kind === 'word_ladder' ? { passes: 0 } : {};
  return { ok: true, state: { ...state, ...extra, out, turn, result } as GameState };
}

/** Nobody moved for a day: the game ends without a winner. */
export function timeOut(state: GameState): GameState {
  return state.result ? state : { ...state, result: { type: 'unfinished' } };
}

/** The seat that won, or null (still playing, a draw, or unfinished). */
export const winnerSeat = (state: GameState): number | null => (state.result?.type === 'win' ? state.result.winner : null);
