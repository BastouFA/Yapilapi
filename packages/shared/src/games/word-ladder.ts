import { activeSeats, nextSeat } from './turns.ts';
import type { GameError, MoveOutcome, WordLadderState } from './types.ts';
import { FOUR_LETTER_WORDS } from './words.ts';

/**
 * Word ladder: players take turns changing one letter of the current word to make another word
 * from the list, starting at `start`, until someone reaches `target`. A player who can't think of
 * one can pass; when everyone still playing passes in a row, or the ladder reaches 30 rungs, it's
 * a draw. Words can't repeat, so a ladder never goes round in circles.
 */
export const WORD_LADDER_MAX_RUNGS = 30;
/** Start and target words are this many steps apart at best. */
export const WORD_LADDER_MIN_STEPS = 3;
export const WORD_LADDER_MAX_STEPS = 5;

const WORDS = new Set(FOUR_LETTER_WORDS);
let buckets: Map<string, string[]> | null = null;

/** Words grouped by pattern ("c_ld" holds cold, cord is under "co_d"...), built once. */
function patterns(): Map<string, string[]> {
  if (buckets) return buckets;
  buckets = new Map();
  for (const w of FOUR_LETTER_WORDS)
    for (let i = 0; i < 4; i++) {
      const key = `${w.slice(0, i)}_${w.slice(i + 1)}`;
      const list = buckets.get(key);
      if (list) list.push(w);
      else buckets.set(key, [w]);
    }
  return buckets;
}

/** A word as typed, ready to check: trimmed and lower case. */
export const normalizeWord = (word: string) => word.trim().toLowerCase();

export const isLadderWord = (word: string) => WORDS.has(normalizeWord(word));

/** Words one letter away from `word`. */
export function ladderNeighbours(word: string): string[] {
  const p = patterns();
  const out = new Set<string>();
  for (let i = 0; i < 4; i++) for (const w of p.get(`${word.slice(0, i)}_${word.slice(i + 1)}`) ?? []) if (w !== word) out.add(w);
  return [...out];
}

/** Two words of the same length that differ in exactly one letter. */
export function oneLetterApart(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n === 1;
}

/** The fewest steps from one word to another through the list, or null when there is no way (or it's longer than `limit`). */
export function ladderSteps(from: string, to: string, limit = 12): number | null {
  if (from === to) return 0;
  let frontier = [from];
  const seen = new Set(frontier);
  for (let d = 1; d <= limit && frontier.length; d++) {
    const next: string[] = [];
    for (const w of frontier)
      for (const n of ladderNeighbours(w)) {
        if (n === to) return d;
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    frontier = next;
  }
  return null;
}

/** A small seeded random number generator (mulberry32): the same seed always gives the same ladder. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let starts: string[] | null = null;

/** A start and a target 3 to 5 steps apart, chosen from `seed`. */
export function pickLadder(seed: number): { start: string; target: string; best: number } {
  const rand = random(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  // Well-connected words make friendlier starts.
  starts ??= FOUR_LETTER_WORDS.filter((w) => ladderNeighbours(w).length >= 4);
  for (let attempt = 0; attempt < 100; attempt++) {
    const start = pick(starts);
    const dist = new Map<string, number>([[start, 0]]);
    let frontier = [start];
    for (let d = 1; d <= WORD_LADDER_MAX_STEPS; d++) {
      const next: string[] = [];
      for (const w of frontier)
        for (const n of ladderNeighbours(w))
          if (!dist.has(n)) {
            dist.set(n, d);
            next.push(n);
          }
      frontier = next;
    }
    const targets = [...dist].filter(([, d]) => d >= WORD_LADDER_MIN_STEPS).map(([w]) => w);
    if (targets.length) {
      const target = pick(targets);
      return { start, target, best: dist.get(target)! };
    }
  }
  return { start: 'cold', target: 'warm', best: ladderSteps('cold', 'warm') ?? 4 };
}

export function newWordLadder(seats: number, seed: number): WordLadderState {
  const { start, target, best } = pickLadder(seed);
  return { kind: 'word_ladder', seats, turn: 0, moves: 0, out: [], result: null, start, target, rungs: [], passes: 0, best, lastPass: null };
}

/** The word the next rung changes. */
export const ladderCurrent = (state: WordLadderState) => state.rungs.at(-1)?.word ?? state.start;

/** Why this word can't be the next rung, or null when it can. The apps check before sending; the server checks again. */
export function checkRung(state: WordLadderState, word: string): Extract<GameError, 'not_four_letters' | 'not_a_word' | 'not_one_letter' | 'word_used'> | null {
  const w = normalizeWord(word);
  if (!/^[a-z]{4}$/.test(w)) return 'not_four_letters';
  if (!WORDS.has(w)) return 'not_a_word';
  if (!oneLetterApart(ladderCurrent(state), w)) return 'not_one_letter';
  if (w === state.start || state.rungs.some((r) => r.word === w)) return 'word_used';
  return null;
}

export function playWordLadder(state: WordLadderState, seat: number, move: { word: string } | { pass: true }): MoveOutcome {
  const next = nextSeat(state.seats, state.out, seat);
  if ('pass' in move) {
    const passes = state.passes + 1;
    const everyone = passes >= activeSeats(state.seats, state.out).length;
    return { ok: true, state: { ...state, moves: state.moves + 1, passes, lastPass: seat, turn: next, result: everyone ? { type: 'draw' } : null } };
  }
  const error = checkRung(state, move.word);
  if (error) return { ok: false, error };
  const word = normalizeWord(move.word);
  const rungs = [...state.rungs, { word, seat }];
  const result =
    word === state.target ? ({ type: 'win', winner: seat, by: 'play' } as const) : rungs.length >= WORD_LADDER_MAX_RUNGS ? ({ type: 'draw' } as const) : null;
  return { ok: true, state: { ...state, rungs, moves: state.moves + 1, passes: 0, lastPass: null, turn: next, result } };
}
