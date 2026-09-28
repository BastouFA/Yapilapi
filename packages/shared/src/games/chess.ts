import { nextSeat } from './turns.ts';
import type {
  ChessColor,
  ChessLastMove,
  ChessMoveInput,
  ChessPieceType,
  ChessPromotion,
  ChessState,
  DrawAction,
  DrawReason,
  GameResult,
  MoveOutcome,
} from './types.ts';

/**
 * Chess: the full rules, with no dependencies. Legal moves include castling on both sides (never
 * out of, through or into check), en passant (and the rare case where it would leave your king in
 * check along the rank), and promotion to a queen, rook, bishop or knight. A game ends in checkmate
 * or stalemate, or is drawn by threefold repetition, the fifty-move rule or when neither side has
 * enough pieces left to checkmate; those draws are automatic, as in most online play. Moves are
 * written in standard algebraic notation (Nf3, exd5, O-O, e8=Q+, Qh4#).
 *
 * Squares are numbered 0 (a1) to 63 (h8): index = rank * 8 + file, both from 0.
 */

export const CHESS_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A piece on the board: its colour and type. */
export interface ChessPiece {
  color: ChessColor;
  type: ChessPieceType;
}

/** A legal move, with what the apps need to show it. */
export interface ChessMove {
  from: string;
  to: string;
  piece: ChessPieceType;
  captured?: ChessPieceType;
  promotion?: ChessPromotion;
  castle?: 'k' | 'q';
  enPassant?: true;
  san: string;
}

/**
 * The pieces as text, each followed by U+FE0E (the text presentation selector) so no phone or
 * browser draws them as emoji. White uses the outlined set, black the filled one.
 */
export const CHESS_GLYPHS: Record<ChessColor, Record<ChessPieceType, string>> = {
  w: { k: '♔︎', q: '♕︎', r: '♖︎', b: '♗︎', n: '♘︎', p: '♙︎' },
  b: { k: '♚︎', q: '♛︎', r: '♜︎', b: '♝︎', n: '♞︎', p: '♟︎' },
};

export const CHESS_PROMOTIONS: readonly ChessPromotion[] = ['q', 'r', 'b', 'n'];

const FILES = 'abcdefgh';

/** "e4" for square 28. */
export const chessSquareName = (sq: number): string => `${FILES[sq % 8]}${Math.floor(sq / 8) + 1}`;

/** 28 for "e4"; -1 for anything that isn't a square. */
export function chessSquareIndex(name: string): number {
  if (typeof name !== 'string' || !/^[a-h][1-8]$/.test(name)) return -1;
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

/** A light square (h1 is light, a1 dark). */
export const chessLightSquare = (sq: number): boolean => ((sq >> 3) + (sq & 7)) % 2 === 1;

// ─── Positions ──────────────────────────────────────────────────────────

/** A position while the rules work on it: FEN characters (upper case white) or null per square. */
interface Pos {
  b: (string | null)[];
  side: ChessColor;
  castling: string;
  ep: number | null;
  half: number;
  full: number;
}

/** A move inside the engine. `piece`, `captured` and `promo` are FEN characters. */
interface Mv {
  from: number;
  to: number;
  piece: string;
  captured: string | null;
  promo: string | null;
  flag: 'ep' | 'k' | 'q' | 'double' | null;
}

const colorOf = (p: string): ChessColor => (p === p.toUpperCase() ? 'w' : 'b');
const typeOf = (p: string) => p.toLowerCase() as ChessPieceType;
const other = (c: ChessColor): ChessColor => (c === 'w' ? 'b' : 'w');

function parsePlacement(placement: string): (string | null)[] | null {
  const rows = placement.split('/');
  if (rows.length !== 8) return null;
  const b: (string | null)[] = Array(64).fill(null);
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]!) {
      if (/[1-8]/.test(ch)) f += Number(ch);
      else if (/[prnbqkPRNBQK]/.test(ch) && f < 8) b[(7 - r) * 8 + f++] = ch;
      else return null;
      if (f > 8) return null;
    }
    if (f !== 8) return null;
  }
  return b;
}

function placementOf(b: readonly (string | null)[]): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = b[r * 8 + f];
      if (!p) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += p;
      }
    }
    rows.push(empty ? row + empty : row);
  }
  return rows.join('/');
}

function parseFen(fen: string): Pos {
  const [placement = '', side = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const b = parsePlacement(placement);
  if (!b) throw new RangeError(`Not a chess position: ${fen}`);
  return {
    b,
    side: side === 'b' ? 'b' : 'w',
    castling: castling === '-' ? '' : castling,
    ep: ep === '-' ? null : chessSquareIndex(ep),
    half: Number(half) || 0,
    full: Number(full) || 1,
  };
}

const posOf = (s: ChessState): Pos => ({
  b: parsePlacement(s.board)!,
  side: s.side,
  castling: s.castling === '-' ? '' : s.castling,
  ep: s.ep ? chessSquareIndex(s.ep) : null,
  half: s.halfmove,
  full: s.fullmove,
});

// ─── Attacks and moves ──────────────────────────────────────────────────

const KNIGHT: readonly [number, number][] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const KING: readonly [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
const ROOK_DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const BISHOP_DIRS: readonly [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** The square `df` files and `dr` ranks from `sq`, or -1 off the board. */
function step(sq: number, df: number, dr: number): number {
  const f = (sq & 7) + df;
  const r = (sq >> 3) + dr;
  return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f;
}

/** Whether `by` attacks square `sq`. */
function attacked(b: readonly (string | null)[], sq: number, by: ChessColor): boolean {
  const is = (s: number, p: string) => s >= 0 && b[s] === (by === 'w' ? p.toUpperCase() : p);
  // A white pawn attacks from one rank below; a black pawn from one rank above.
  const pr = by === 'w' ? -1 : 1;
  if (is(step(sq, -1, pr), 'p') || is(step(sq, 1, pr), 'p')) return true;
  for (const [df, dr] of KNIGHT) if (is(step(sq, df, dr), 'n')) return true;
  for (const [df, dr] of KING) if (is(step(sq, df, dr), 'k')) return true;
  const slide = (dirs: readonly [number, number][], a: string, q: string) => {
    for (const [df, dr] of dirs) {
      let s = step(sq, df, dr);
      while (s >= 0) {
        const p = b[s];
        if (p) {
          if (is(s, a) || is(s, q)) return true;
          break;
        }
        s = step(s, df, dr);
      }
    }
    return false;
  };
  return slide(ROOK_DIRS, 'r', 'q') || slide(BISHOP_DIRS, 'b', 'q');
}

const kingSquare = (b: readonly (string | null)[], c: ChessColor) => b.indexOf(c === 'w' ? 'K' : 'k');

const inCheck = (p: Pos, c: ChessColor = p.side) => {
  const k = kingSquare(p.b, c);
  return k >= 0 && attacked(p.b, k, other(c));
};

/** Moves that follow how each piece moves, before checking they leave the king safe. */
function pseudoMoves(p: Pos): Mv[] {
  const out: Mv[] = [];
  const { b, side } = p;
  const mine = (x: string | null) => !!x && colorOf(x) === side;
  const theirs = (x: string | null) => !!x && colorOf(x) !== side;
  const add = (from: number, to: number, flag: Mv['flag'] = null) => out.push({ from, to, piece: b[from]!, captured: b[to] ?? null, promo: null, flag });
  const promoRank = side === 'w' ? 7 : 0;
  const addPawn = (from: number, to: number, captured: string | null) => {
    if (to >> 3 === promoRank)
      for (const q of CHESS_PROMOTIONS) out.push({ from, to, piece: b[from]!, captured, promo: side === 'w' ? q.toUpperCase() : q, flag: null });
    else out.push({ from, to, piece: b[from]!, captured, promo: null, flag: null });
  };
  for (let sq = 0; sq < 64; sq++) {
    const piece = b[sq];
    if (!mine(piece ?? null)) continue;
    const t = typeOf(piece!);
    if (t === 'p') {
      const dr = side === 'w' ? 1 : -1;
      const one = step(sq, 0, dr);
      if (one >= 0 && !b[one]) {
        addPawn(sq, one, null);
        const two = step(sq, 0, 2 * dr);
        if (sq >> 3 === (side === 'w' ? 1 : 6) && !b[two]) add(sq, two, 'double');
      }
      for (const df of [-1, 1]) {
        const to = step(sq, df, dr);
        if (to < 0) continue;
        if (theirs(b[to] ?? null)) addPawn(sq, to, b[to]!);
        else if (to === p.ep && !b[to]) out.push({ from: sq, to, piece: piece!, captured: side === 'w' ? 'p' : 'P', promo: null, flag: 'ep' });
      }
    } else if (t === 'n' || t === 'k') {
      for (const [df, dr] of t === 'n' ? KNIGHT : KING) {
        const to = step(sq, df, dr);
        if (to >= 0 && !mine(b[to] ?? null)) add(sq, to);
      }
    } else {
      const dirs = t === 'r' ? ROOK_DIRS : t === 'b' ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const [df, dr] of dirs) {
        let to = step(sq, df, dr);
        while (to >= 0) {
          if (mine(b[to] ?? null)) break;
          add(sq, to);
          if (b[to]) break;
          to = step(to, df, dr);
        }
      }
    }
  }
  // Castling: the rights are still there, the king and rook stand on their squares, nothing is
  // between them, and the king isn't in check, doesn't cross an attacked square and doesn't land on one.
  const home = side === 'w' ? 0 : 56;
  const K = side === 'w' ? 'K' : 'k';
  const R = side === 'w' ? 'R' : 'r';
  const enemy = other(side);
  if (b[home + 4] === K && !attacked(b, home + 4, enemy)) {
    const [kRight, qRight] = side === 'w' ? ['K', 'Q'] : ['k', 'q'];
    if (p.castling.includes(kRight) && b[home + 7] === R && !b[home + 5] && !b[home + 6] && !attacked(b, home + 5, enemy) && !attacked(b, home + 6, enemy))
      out.push({ from: home + 4, to: home + 6, piece: K, captured: null, promo: null, flag: 'k' });
    if (
      p.castling.includes(qRight) &&
      b[home] === R &&
      !b[home + 1] &&
      !b[home + 2] &&
      !b[home + 3] &&
      !attacked(b, home + 3, enemy) &&
      !attacked(b, home + 2, enemy)
    )
      out.push({ from: home + 4, to: home + 2, piece: K, captured: null, promo: null, flag: 'q' });
  }
  return out;
}

/** Castling rights lost when a piece leaves or arrives on each corner (or the king moves). */
const CORNER_RIGHTS: Record<number, string> = { 0: 'Q', 7: 'K', 56: 'q', 63: 'k' };

function make(p: Pos, m: Mv): Pos {
  const b = p.b.slice();
  b[m.from] = null;
  b[m.to] = m.promo ?? m.piece;
  if (m.flag === 'ep') b[m.to + (p.side === 'w' ? -8 : 8)] = null;
  if (m.flag === 'k') {
    b[m.from + 1] = b[m.from + 3]!;
    b[m.from + 3] = null;
  } else if (m.flag === 'q') {
    b[m.from - 1] = b[m.from - 4]!;
    b[m.from - 4] = null;
  }
  let castling = p.castling;
  if (m.piece === 'K') castling = castling.replace(/[KQ]/g, '');
  if (m.piece === 'k') castling = castling.replace(/[kq]/g, '');
  for (const sq of [m.from, m.to]) if (CORNER_RIGHTS[sq]) castling = castling.replace(CORNER_RIGHTS[sq]!, '');
  const pawn = typeOf(m.piece) === 'p';
  return {
    b,
    side: other(p.side),
    castling,
    ep: m.flag === 'double' ? (m.from + m.to) / 2 : null,
    half: pawn || m.captured ? 0 : p.half + 1,
    full: p.full + (p.side === 'b' ? 1 : 0),
  };
}

/** Every legal move for the side to move. */
function legalMoves(p: Pos): Mv[] {
  return pseudoMoves(p).filter((m) => !inCheck(make(p, m), p.side));
}

/** Count the positions `depth` moves ahead (perft), to check move generation against known totals. */
export function chessPerft(fen: string, depth: number): number {
  const walk = (p: Pos, d: number): number => {
    const moves = legalMoves(p);
    if (d <= 1) return moves.length;
    let n = 0;
    for (const m of moves) n += walk(make(p, m), d - 1);
    return n;
  };
  return depth < 1 ? 1 : walk(parseFen(fen), depth);
}

// ─── Notation and draws ─────────────────────────────────────────────────

function san(p: Pos, m: Mv, all: readonly Mv[]): string {
  let s: string;
  if (m.flag === 'k') s = 'O-O';
  else if (m.flag === 'q') s = 'O-O-O';
  else {
    const t = typeOf(m.piece);
    const to = chessSquareName(m.to);
    if (t === 'p') {
      s = (m.captured ? `${FILES[m.from & 7]}x` : '') + to + (m.promo ? `=${m.promo.toUpperCase()}` : '');
    } else {
      // Name the file, the rank, or both, when another piece of the same kind could go there too.
      const rivals = all.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
      let which = '';
      if (rivals.length) {
        if (!rivals.some((o) => (o.from & 7) === (m.from & 7))) which = FILES[m.from & 7]!;
        else if (!rivals.some((o) => o.from >> 3 === m.from >> 3)) which = String((m.from >> 3) + 1);
        else which = chessSquareName(m.from);
      }
      s = t.toUpperCase() + which + (m.captured ? 'x' : '') + to;
    }
  }
  const after = make(p, m);
  if (inCheck(after)) s += legalMoves(after).length ? '+' : '#';
  return s;
}

/** Not enough pieces for either side to checkmate: kings alone, a king and one minor piece against a king, or only bishops all on one colour of square. */
function insufficient(b: readonly (string | null)[]): boolean {
  const rest: [string, number][] = [];
  b.forEach((p, sq) => {
    if (p && typeOf(p) !== 'k') rest.push([typeOf(p), sq]);
  });
  if (!rest.length) return true;
  if (rest.some(([t]) => t === 'p' || t === 'q' || t === 'r')) return false;
  if (rest.length === 1) return true;
  return rest.every(([t]) => t === 'b') && new Set(rest.map(([, sq]) => chessLightSquare(sq))).size === 1;
}

/**
 * A short, stable hash of a string (53 bits, as base 36). Positions are compared by their hash;
 * with at most a hundred positions kept per game, a clash is vanishingly unlikely.
 */
function hash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The position's identity for repetition: the pieces, the side to move, castling rights, and the
 * en passant square only when an en passant capture is actually possible (as the rules say).
 */
function positionKey(p: Pos, moves: readonly Mv[]): string {
  const ep = p.ep !== null && moves.some((m) => m.flag === 'ep') ? chessSquareName(p.ep) : '-';
  return hash(`${placementOf(p.b)} ${p.side} ${p.castling || '-'} ${ep}`);
}

// ─── The game ───────────────────────────────────────────────────────────

/** A game from a FEN position (the start position by default). `white` is the seat playing white. */
export function chessFromFen(fen: string = CHESS_START_FEN, white = 0): ChessState {
  const p = parseFen(fen);
  const moves = legalMoves(p);
  const toMove = p.side === 'w' ? white : 1 - white;
  return {
    kind: 'chess',
    seats: 2,
    turn: toMove,
    moves: 0,
    out: [],
    result: null,
    white,
    board: placementOf(p.b),
    side: p.side,
    castling: p.castling || '-',
    ep: p.ep === null ? null : chessSquareName(p.ep),
    halfmove: p.half,
    fullmove: p.full,
    seen: [positionKey(p, moves)],
    san: [],
    last: null,
    drawOffer: null,
    offeredAt: [-2, -2],
  };
}

/** A new game; `white` is the seat that plays white (and moves first). */
export const newChess = (white = 0): ChessState => chessFromFen(CHESS_START_FEN, white === 1 ? 1 : 0);

/** The position as FEN. */
export const chessFen = (s: ChessState): string => `${s.board} ${s.side} ${s.castling || '-'} ${s.ep ?? '-'} ${s.halfmove} ${s.fullmove}`;

/** The colour a seat plays. */
export const chessSeatColor = (s: Pick<ChessState, 'white'>, seat: number): ChessColor => (seat === s.white ? 'w' : 'b');

/** The seat playing a colour. */
export const chessColorSeat = (s: Pick<ChessState, 'white'>, color: ChessColor): number => (color === 'w' ? s.white : 1 - s.white);

/** The 64 squares (a1 first), each a piece or null. */
export function chessBoard(s: ChessState): (ChessPiece | null)[] {
  return parsePlacement(s.board)!.map((p) => (p ? { color: colorOf(p), type: typeOf(p) } : null));
}

/** Every legal move for the side to move (none once the game is over). */
export function chessLegalMoves(s: ChessState): ChessMove[] {
  if (s.result) return [];
  const p = posOf(s);
  const all = legalMoves(p);
  return all.map((m) => ({
    from: chessSquareName(m.from),
    to: chessSquareName(m.to),
    piece: typeOf(m.piece),
    ...(m.captured ? { captured: typeOf(m.captured) } : {}),
    ...(m.promo ? { promotion: typeOf(m.promo) as ChessPromotion } : {}),
    ...(m.flag === 'k' || m.flag === 'q' ? { castle: m.flag } : {}),
    ...(m.flag === 'ep' ? { enPassant: true as const } : {}),
    san: san(p, m, all),
  }));
}

/** The side to move is in check. */
export const chessInCheck = (s: ChessState): boolean => inCheck(posOf(s));

/** Where a colour's king stands (-1 if it has none, which a real game never has). */
export const chessKingSquare = (s: ChessState, color: ChessColor): number => kingSquare(parsePlacement(s.board)!, color);

const START_COUNT: Record<ChessPieceType, number> = { k: 1, q: 1, r: 2, b: 2, n: 2, p: 8 };
const VALUE_ORDER: ChessPieceType[] = ['q', 'r', 'b', 'n', 'p'];

/**
 * Pieces of each colour that have been taken, most valuable first. Counted against the starting
 * set, so a promoted pawn makes its new piece look present and the pawn missing, as on a real board.
 */
export function chessCaptured(s: ChessState): Record<ChessColor, ChessPieceType[]> {
  const on: Record<ChessColor, Record<ChessPieceType, number>> = { w: { k: 0, q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { k: 0, q: 0, r: 0, b: 0, n: 0, p: 0 } };
  for (const piece of chessBoard(s)) if (piece) on[piece.color][piece.type]++;
  const gone = (c: ChessColor) => {
    // Promotions: a side with more of a piece than it started with used up that many pawns.
    let extra = 0;
    for (const t of VALUE_ORDER) if (t !== 'p') extra += Math.max(0, on[c][t] - START_COUNT[t]);
    const list: ChessPieceType[] = [];
    for (const t of VALUE_ORDER) {
      const missing = t === 'p' ? START_COUNT.p - on[c].p - extra : START_COUNT[t] - on[c][t];
      for (let i = 0; i < missing; i++) list.push(t);
    }
    return list;
  };
  return { w: gone('w'), b: gone('b') };
}

/** Play a chess move for `seat` (already known to be on turn and in the game). */
export function playChess(state: ChessState, seat: number, move: ChessMoveInput): MoveOutcome {
  const from = chessSquareIndex(move.from);
  const to = chessSquareIndex(move.to);
  if (from < 0 || to < 0) return { ok: false, error: 'bad_square' };
  if (move.promotion !== undefined && !CHESS_PROMOTIONS.includes(move.promotion)) return { ok: false, error: 'bad_promotion' };
  const p = posOf(state);
  const piece = p.b[from];
  if (!piece || colorOf(piece) !== p.side) return { ok: false, error: 'not_your_piece' };
  const all = legalMoves(p);
  const options = all.filter((m) => m.from === from && m.to === to);
  if (!options.length) return { ok: false, error: 'illegal_move' };
  const promotes = options[0]!.promo !== null;
  if (promotes && !move.promotion) return { ok: false, error: 'promotion_needed' };
  if (!promotes && move.promotion) return { ok: false, error: 'bad_promotion' };
  const m = promotes ? options.find((o) => typeOf(o.promo!) === move.promotion)! : options[0]!;

  const notation = san(p, m, all);
  const next = make(p, m);
  const replies = legalMoves(next);
  const key = positionKey(next, replies);
  const seen = next.half === 0 ? [key] : [...state.seen, key];
  let result: GameResult | null = null;
  const draw = (reason: DrawReason): GameResult => ({ type: 'draw', reason });
  if (!replies.length) result = inCheck(next) ? { type: 'win', winner: seat, by: 'play' } : draw('stalemate');
  else if (insufficient(next.b)) result = draw('material');
  else if (next.half >= 100) result = draw('fifty_moves');
  else if (seen.filter((k) => k === key).length >= 3) result = draw('repetition');

  const last: ChessLastMove = {
    from: move.from,
    to: move.to,
    piece: typeOf(m.piece),
    ...(m.captured ? { captured: typeOf(m.captured) } : {}),
    ...(m.promo ? { promotion: typeOf(m.promo) as ChessPromotion } : {}),
    ...(m.flag === 'k' || m.flag === 'q' ? { castle: m.flag } : {}),
    ...(m.flag === 'ep' ? { enPassant: true as const } : {}),
  };
  // A draw offer lapses once the player who made it moves again (the move they offered on doesn't count).
  const offer = state.drawOffer;
  const drawOffer = offer && offer.seat === seat && state.moves > offer.at ? null : offer;
  return {
    ok: true,
    state: {
      ...state,
      board: placementOf(next.b),
      side: next.side,
      castling: next.castling || '-',
      ep: next.ep === null ? null : chessSquareName(next.ep),
      halfmove: next.half,
      fullmove: next.full,
      seen,
      san: [...state.san, notation],
      last,
      moves: state.moves + 1,
      turn: nextSeat(state.seats, state.out, seat),
      drawOffer: result ? null : drawOffer,
      result,
    },
  };
}

/**
 * Offer a draw, or accept or decline the other player's offer. You can offer at any point in the
 * game, once per move of your own; accepting ends it in a draw.
 */
export function chessDraw(state: ChessState, seat: number, action: DrawAction): MoveOutcome {
  const offer = state.drawOffer;
  if (action === 'offer') {
    // One offer at a time: when the other player has offered, accept theirs instead.
    if (offer) return { ok: false, error: 'draw_offered' };
    if (state.moves < (state.offeredAt[seat] ?? -2) + 2) return { ok: false, error: 'draw_too_soon' };
    const offeredAt = state.offeredAt.slice();
    offeredAt[seat] = state.moves;
    return { ok: true, state: { ...state, drawOffer: { seat, at: state.moves }, offeredAt } };
  }
  if (!offer || offer.seat === seat) return { ok: false, error: 'no_draw_offer' };
  if (action === 'decline') return { ok: true, state: { ...state, drawOffer: null } };
  return { ok: true, state: { ...state, drawOffer: null, result: { type: 'draw', reason: 'agreed' } } };
}
