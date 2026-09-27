import { nextSeat } from './turns.ts';
import type { MoveOutcome, NoughtsState } from './types.ts';

/** Noughts (noughts and crosses): a 3 by 3 board. Three in a row wins; a full board is a draw. */
export const NOUGHTS_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function newNoughts(): NoughtsState {
  return { kind: 'noughts', seats: 2, turn: 0, moves: 0, out: [], result: null, cells: Array(9).fill(null), last: null };
}

/** The line of three through `cell` held by its seat, or null. */
export function noughtsLine(cells: readonly (number | null)[], cell: number): number[] | null {
  const seat = cells[cell];
  if (seat === null || seat === undefined) return null;
  const line = NOUGHTS_LINES.find((l) => l.includes(cell) && l.every((i) => cells[i] === seat));
  return line ? [...line] : null;
}

export function playNoughts(state: NoughtsState, seat: number, move: { cell: number }): MoveOutcome {
  const { cell } = move;
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { ok: false, error: 'bad_cell' };
  if (state.cells[cell] !== null) return { ok: false, error: 'cell_taken' };
  const cells = state.cells.slice();
  cells[cell] = seat;
  const line = noughtsLine(cells, cell);
  const full = cells.every((c) => c !== null);
  return {
    ok: true,
    state: {
      ...state,
      cells,
      last: cell,
      moves: state.moves + 1,
      turn: nextSeat(state.seats, state.out, seat),
      result: line ? { type: 'win', winner: seat, by: 'play', line } : full ? { type: 'draw' } : null,
    },
  };
}
