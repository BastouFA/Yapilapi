import { nextSeat } from './turns.ts';
import type { FourUpState, MoveOutcome } from './types.ts';

/** Four up (connect four): 7 columns, 6 rows, discs fall to the lowest free space. Four in a row wins. */
export const FOUR_UP_COLUMNS = 7;
export const FOUR_UP_ROWS = 6;

export function newFourUp(): FourUpState {
  return { kind: 'four_up', seats: 2, turn: 0, moves: 0, out: [], result: null, cells: Array(FOUR_UP_COLUMNS * FOUR_UP_ROWS).fill(null), last: null };
}

/** The cell a disc dropped in this column lands on, or -1 when the column is full. */
export function fourUpDropCell(cells: readonly (number | null)[], column: number): number {
  for (let row = FOUR_UP_ROWS - 1; row >= 0; row--) {
    const i = row * FOUR_UP_COLUMNS + column;
    if (cells[i] === null) return i;
  }
  return -1;
}

/** Free spaces left in a column. */
export function fourUpFree(cells: readonly (number | null)[], column: number): number {
  let n = 0;
  for (let row = 0; row < FOUR_UP_ROWS; row++) if (cells[row * FOUR_UP_COLUMNS + column] === null) n++;
  return n;
}

/** The seats in a column from the bottom up (the discs in it). */
export function fourUpColumn(cells: readonly (number | null)[], column: number): number[] {
  const out: number[] = [];
  for (let row = FOUR_UP_ROWS - 1; row >= 0; row--) {
    const v = cells[row * FOUR_UP_COLUMNS + column];
    if (v === null || v === undefined) break;
    out.push(v);
  }
  return out;
}

/** The run of four or more through `cell` for the disc on it, or null. */
export function fourUpLine(cells: readonly (number | null)[], cell: number): number[] | null {
  const seat = cells[cell];
  if (seat === null || seat === undefined) return null;
  const row = Math.floor(cell / FOUR_UP_COLUMNS);
  const col = cell % FOUR_UP_COLUMNS;
  const at = (r: number, c: number) => (r >= 0 && r < FOUR_UP_ROWS && c >= 0 && c < FOUR_UP_COLUMNS ? cells[r * FOUR_UP_COLUMNS + c] : undefined);
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    const line = [cell];
    for (let k = 1; at(row + dr * k, col + dc * k) === seat; k++) line.push((row + dr * k) * FOUR_UP_COLUMNS + col + dc * k);
    for (let k = 1; at(row - dr * k, col - dc * k) === seat; k++) line.unshift((row - dr * k) * FOUR_UP_COLUMNS + col - dc * k);
    if (line.length >= 4) return line;
  }
  return null;
}

export function playFourUp(state: FourUpState, seat: number, move: { column: number }): MoveOutcome {
  const { column } = move;
  if (!Number.isInteger(column) || column < 0 || column >= FOUR_UP_COLUMNS) return { ok: false, error: 'bad_column' };
  const cell = fourUpDropCell(state.cells, column);
  if (cell < 0) return { ok: false, error: 'column_full' };
  const cells = state.cells.slice();
  cells[cell] = seat;
  const line = fourUpLine(cells, cell);
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
