import { describe, expect, it } from 'vitest';
import {
  applyMove,
  checkRung,
  FOUR_LETTER_WORDS,
  FOUR_UP_COLUMNS,
  forfeit,
  GAME_ACTIVE_LIMIT,
  GAME_KIND_ACTIVE_LIMIT,
  gameStartBlock,
  fourUpColumn,
  fourUpFree,
  ladderCurrent,
  ladderNeighbours,
  ladderSteps,
  newGame,
  nextSeat,
  pickLadder,
  timeOut,
  winnerSeat,
  WORD_LADDER_MAX_RUNGS,
  type FourUpState,
  type GameMove,
  type GameState,
  type NoughtsState,
  type WordLadderState,
} from './index.ts';

/** Play moves in turn order; every one must be allowed. */
function play<S extends GameState>(state: S, moves: GameMove[]): S {
  let s: GameState = state;
  for (const m of moves) {
    const r = applyMove(s, s.turn, m);
    if (!r.ok) throw new Error(`move ${JSON.stringify(m)} refused: ${r.error}`);
    s = r.state;
  }
  return s as S;
}

const cols = (...c: number[]) => c.map((column) => ({ column }));
const cells = (...c: number[]) => c.map((cell) => ({ cell }));

describe('Four up', () => {
  it('starts empty with seat 0 to play, and refuses other player counts', () => {
    const s = newGame('four_up', 2) as FourUpState;
    expect(s.cells).toHaveLength(42);
    expect(s.cells.every((c) => c === null)).toBe(true);
    expect(s).toMatchObject({ turn: 0, moves: 0, result: null });
    expect(() => newGame('four_up', 3)).toThrow();
    expect(() => newGame('four_up', 1)).toThrow();
  });

  it('drops discs to the lowest free space and alternates turns', () => {
    const s = play(newGame('four_up', 2) as FourUpState, cols(3, 3, 3));
    expect(fourUpColumn(s.cells, 3)).toEqual([0, 1, 0]);
    expect(fourUpFree(s.cells, 3)).toBe(3);
    expect(fourUpFree(s.cells, 0)).toBe(6);
    expect(s.turn).toBe(1);
    expect(s.moves).toBe(3);
    // The bottom row is the last row of cells.
    expect(s.cells[5 * FOUR_UP_COLUMNS + 3]).toBe(0);
    expect(s.last).toBe(3 * FOUR_UP_COLUMNS + 3);
  });

  it('wins across, down and on both diagonals', () => {
    const across = play(newGame('four_up', 2) as FourUpState, cols(0, 0, 1, 1, 2, 2, 3));
    expect(across.result).toMatchObject({ type: 'win', winner: 0, by: 'play' });
    expect((across.result as { line: number[] }).line).toEqual([35, 36, 37, 38]);

    const down = play(newGame('four_up', 2) as FourUpState, cols(0, 1, 0, 1, 0, 1, 0));
    expect(down.result).toMatchObject({ type: 'win', winner: 0 });

    // Seat 1 builds a rising diagonal: columns 0..3, heights 1..4.
    const rising = play(newGame('four_up', 2) as FourUpState, cols(6, 0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3));
    expect(rising.result).toMatchObject({ type: 'win', winner: 1 });
    expect((rising.result as { line: number[] }).line).toHaveLength(4);

    // Seat 0: column 3 at height 1 up to column 0 at height 4.
    const falling = play(newGame('four_up', 2) as FourUpState, cols(3, 2, 2, 1, 0, 1, 1, 0, 6, 0, 0));
    expect(winnerSeat(falling)).toBe(0);
    expect([...(falling.result as { line: number[] }).line].sort((a, b) => a - b)).toEqual([14, 22, 30, 38]);
  });

  it('refuses a full column, a column off the board, the wrong turn and moves after the end', () => {
    let s = play(newGame('four_up', 2) as FourUpState, cols(0, 0, 0, 0, 0, 0));
    expect(fourUpFree(s.cells, 0)).toBe(0);
    expect(applyMove(s, s.turn, { column: 0 })).toEqual({ ok: false, error: 'column_full' });
    expect(applyMove(s, s.turn, { column: 7 })).toEqual({ ok: false, error: 'bad_column' });
    expect(applyMove(s, s.turn, { column: -1 })).toEqual({ ok: false, error: 'bad_column' });
    expect(applyMove(s, s.turn, { column: 1.5 })).toEqual({ ok: false, error: 'bad_column' });
    expect(applyMove(s, 1 - s.turn, { column: 1 })).toEqual({ ok: false, error: 'not_your_turn' });
    expect(applyMove(s, 2, { column: 1 })).toEqual({ ok: false, error: 'not_a_player' });
    expect(applyMove(s, s.turn, { cell: 1 })).toEqual({ ok: false, error: 'wrong_move' });
    s = play(s, cols(1, 2, 1, 2, 1, 2, 1));
    expect(s.result?.type).toBe('win');
    expect(applyMove(s, s.turn, { column: 3 })).toEqual({ ok: false, error: 'game_over' });
  });

  it('ends in a draw when the board fills with no four in a row', () => {
    // Every row is 0 0 1 1 repeated, shifted two places per row: no four across, down or diagonally.
    const board = Array.from({ length: 42 }, (_, i) => {
      const r = 5 - Math.floor(i / FOUR_UP_COLUMNS);
      return [0, 0, 1, 1][((i % FOUR_UP_COLUMNS) + 2 * r) % 4]!;
    });
    // All but the top of column 0, which is seat 1's to fill with the last move.
    const before: FourUpState = { ...(newGame('four_up', 2) as FourUpState), cells: board.map((v, i) => (i === 0 ? null : v)), moves: 41, turn: 1 };
    expect(board[0]).toBe(1);
    const r = applyMove(before, 1, { column: 0 });
    expect(r.ok && r.state.result).toEqual({ type: 'draw' });
  });

  it("doesn't change the state it was given", () => {
    const s = newGame('four_up', 2) as FourUpState;
    const copy = JSON.stringify(s);
    applyMove(s, 0, { column: 2 });
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe('Noughts', () => {
  it('takes squares in turn and wins with three in a row', () => {
    const row = play(newGame('noughts', 2) as NoughtsState, cells(0, 3, 1, 4, 2));
    expect(row.result).toEqual({ type: 'win', winner: 0, by: 'play', line: [0, 1, 2] });
    const column = play(newGame('noughts', 2) as NoughtsState, cells(0, 1, 3, 4, 8, 7));
    expect(column.result).toEqual({ type: 'win', winner: 1, by: 'play', line: [1, 4, 7] });
  });

  it('wins on the diagonals', () => {
    expect(play(newGame('noughts', 2) as NoughtsState, cells(0, 1, 4, 2, 8)).result).toMatchObject({ winner: 0, line: [0, 4, 8] });
    expect(play(newGame('noughts', 2) as NoughtsState, cells(0, 2, 1, 4, 8, 6)).result).toMatchObject({ winner: 1, line: [2, 4, 6] });
  });

  it('is a draw when the board fills', () => {
    const s = play(newGame('noughts', 2) as NoughtsState, cells(0, 1, 2, 4, 3, 5, 7, 6, 8));
    expect(s.result).toEqual({ type: 'draw' });
    expect(s.moves).toBe(9);
  });

  it('refuses a taken square, a square off the board and the wrong turn', () => {
    const s = play(newGame('noughts', 2) as NoughtsState, cells(4));
    expect(applyMove(s, 1, { cell: 4 })).toEqual({ ok: false, error: 'cell_taken' });
    expect(applyMove(s, 1, { cell: 9 })).toEqual({ ok: false, error: 'bad_cell' });
    expect(applyMove(s, 0, { cell: 0 })).toEqual({ ok: false, error: 'not_your_turn' });
    expect(applyMove(s, 1, { column: 0 })).toEqual({ ok: false, error: 'wrong_move' });
  });
});

describe('Word ladder', () => {
  it('has a few thousand distinct lower-case four-letter words', () => {
    expect(FOUR_LETTER_WORDS.length).toBeGreaterThan(2000);
    expect(new Set(FOUR_LETTER_WORDS).size).toBe(FOUR_LETTER_WORDS.length);
    expect(FOUR_LETTER_WORDS.every((w) => /^[a-z]{4}$/.test(w))).toBe(true);
    for (const w of ['cold', 'cord', 'card', 'ward', 'warm', 'word', 'game', 'chat']) expect(FOUR_LETTER_WORDS).toContain(w);
  });

  it('knows neighbours and shortest ways', () => {
    expect(ladderNeighbours('cold')).toEqual(expect.arrayContaining(['cord', 'bold', 'colt']));
    expect(ladderNeighbours('cold')).not.toContain('cold');
    expect(ladderSteps('cold', 'cold')).toBe(0);
    expect(ladderSteps('cold', 'cord')).toBe(1);
    expect(ladderSteps('cold', 'warm')).toBeLessThanOrEqual(4);
  });

  it('picks the same solvable start and target for the same seed', () => {
    const a = pickLadder(42);
    expect(pickLadder(42)).toEqual(a);
    for (const seed of [1, 7, 99, 12345, 2 ** 31 - 1]) {
      const l = pickLadder(seed);
      expect(l.start).not.toBe(l.target);
      expect(l.best).toBeGreaterThanOrEqual(3);
      expect(l.best).toBeLessThanOrEqual(5);
      expect(ladderSteps(l.start, l.target)).toBe(l.best);
    }
  });

  /** A ladder from cold to warm for these seats. */
  const coldToWarm = (seats = 2): WordLadderState => ({ ...(newGame('word_ladder', seats, 1) as WordLadderState), start: 'cold', target: 'warm', best: 4 });

  it('takes one-letter changes in turn and ends when someone reaches the target', () => {
    const s = play(coldToWarm(3), [{ word: 'cord' }, { word: ' CARD ' }, { word: 'ward' }]);
    expect(s.rungs).toEqual([
      { word: 'cord', seat: 0 },
      { word: 'card', seat: 1 },
      { word: 'ward', seat: 2 },
    ]);
    expect(ladderCurrent(s)).toBe('ward');
    expect(s.turn).toBe(0);
    const done = play(s, [{ word: 'warm' }]);
    expect(done.result).toEqual({ type: 'win', winner: 0, by: 'play' });
  });

  it('refuses words not in the list, changes of more than one letter and repeats', () => {
    const s = play(coldToWarm(), [{ word: 'cord' }]);
    expect(checkRung(s, 'cor')).toBe('not_four_letters');
    expect(checkRung(s, 'c0rd')).toBe('not_four_letters');
    expect(checkRung(s, 'cxrd')).toBe('not_a_word');
    expect(checkRung(s, 'ward')).toBe('not_one_letter');
    expect(checkRung(s, 'cord')).toBe('not_one_letter');
    expect(checkRung(s, 'cold')).toBe('word_used');
    expect(checkRung(s, 'card')).toBeNull();
    expect(applyMove(s, 1, { word: 'cold' })).toEqual({ ok: false, error: 'word_used' });
    expect(applyMove(s, 1, { word: 'xxxx' })).toEqual({ ok: false, error: 'not_a_word' });
    expect(applyMove(s, 0, { word: 'card' })).toEqual({ ok: false, error: 'not_your_turn' });
    expect(applyMove(s, 1, { column: 2 })).toEqual({ ok: false, error: 'wrong_move' });
  });

  it('lets people pass, and is a draw when everyone passes in a row', () => {
    let s = play(coldToWarm(3), [{ pass: true }, { pass: true }]);
    expect(s.passes).toBe(2);
    expect(s.lastPass).toBe(1);
    expect(s.result).toBeNull();
    // A word starts the count again.
    s = play(s, [{ word: 'cord' }]);
    expect(s.passes).toBe(0);
    s = play(s, [{ pass: true }, { pass: true }, { pass: true }]);
    expect(s.result).toEqual({ type: 'draw' });
  });

  it('is a draw at the longest ladder allowed', () => {
    // Walk back and forth through fresh words far from the target.
    let s: WordLadderState = { ...coldToWarm(), start: 'bake', target: 'zinc', best: 9 };
    let current = 'bake';
    const used = new Set(['bake']);
    for (let i = 0; i < WORD_LADDER_MAX_RUNGS && !s.result; i++) {
      const next = ladderNeighbours(current).find((w) => !used.has(w) && w !== 'zinc');
      if (!next) break;
      used.add(next);
      s = play(s, [{ word: next }]);
      current = next;
    }
    expect(s.rungs).toHaveLength(WORD_LADDER_MAX_RUNGS);
    expect(s.result).toEqual({ type: 'draw' });
  });

  it('takes 2 to 6 players', () => {
    expect(() => newGame('word_ladder', 1, 1)).toThrow();
    expect(() => newGame('word_ladder', 7, 1)).toThrow();
    expect(newGame('word_ladder', 6, 1).seats).toBe(6);
  });
});

describe('Forfeits and time-outs', () => {
  it('in a two-player game, the other player wins', () => {
    const s = play(newGame('noughts', 2) as NoughtsState, cells(4));
    const r = forfeit(s, 1);
    expect(r.ok && r.state.result).toEqual({ type: 'win', winner: 0, by: 'forfeit' });
    // Either player can forfeit, on their turn or not.
    const r2 = forfeit(s, 0);
    expect(r2.ok && r2.state.result).toEqual({ type: 'win', winner: 1, by: 'forfeit' });
  });

  it('in a bigger word ladder, the others play on and the turn skips the seat that left', () => {
    const s = newGame('word_ladder', 3, 5) as WordLadderState;
    const r = forfeit(s, 0);
    if (!r.ok) throw new Error(r.error);
    expect(r.state.result).toBeNull();
    expect(r.state.out).toEqual([0]);
    expect(r.state.turn).toBe(1);
    expect(nextSeat(3, r.state.out, 2)).toBe(1);
    expect(applyMove(r.state, 0, { pass: true })).toEqual({ ok: false, error: 'not_a_player' });
    expect(forfeit(r.state, 0)).toEqual({ ok: false, error: 'not_a_player' });
    // Two passes now end it: only two are playing.
    const after = play(r.state, [{ pass: true }, { pass: true }]);
    expect(after.result).toEqual({ type: 'draw' });
    const last = forfeit(r.state, 2);
    expect(last.ok && last.state.result).toEqual({ type: 'win', winner: 1, by: 'forfeit' });
  });

  it("can't forfeit a finished game; a time-out ends an active one unfinished", () => {
    const won = play(newGame('noughts', 2) as NoughtsState, cells(0, 3, 1, 4, 2));
    expect(forfeit(won, 1)).toEqual({ ok: false, error: 'game_over' });
    expect(timeOut(won)).toBe(won);
    const idle = timeOut(newGame('four_up', 2));
    expect(idle.result).toEqual({ type: 'unfinished' });
    expect(winnerSeat(idle)).toBeNull();
    expect(applyMove(idle, 0, { column: 0 })).toEqual({ ok: false, error: 'game_over' });
  });

  it('states survive a round trip through JSON, as they are stored', () => {
    const s = play(newGame('four_up', 2) as FourUpState, cols(3, 4, 3));
    const back = JSON.parse(JSON.stringify(s)) as FourUpState;
    expect(play(back, cols(4))).toEqual(play(s, cols(4)));
  });
});

describe('Games going at once in a chat', () => {
  it('allows up to 3 of a kind and 6 in all', () => {
    expect(GAME_ACTIVE_LIMIT).toBe(6);
    expect(GAME_KIND_ACTIVE_LIMIT).toBe(3);
    expect(gameStartBlock([], 'chess')).toBeNull();
    expect(gameStartBlock(['chess', 'chess'], 'chess')).toBeNull();
    expect(gameStartBlock(['chess', 'chess', 'chess'], 'chess')).toBe('game_kind_full');
    expect(gameStartBlock(['chess', 'chess', 'chess'], 'noughts')).toBeNull();
    expect(gameStartBlock(['chess', 'chess', 'chess', 'noughts', 'noughts', 'four_up'], 'word_ladder')).toBe('games_full');
    // A full chat says so before a full kind.
    expect(gameStartBlock(['chess', 'chess', 'chess', 'noughts', 'noughts', 'four_up'], 'chess')).toBe('games_full');
  });
});
