import { describe, expect, it } from 'vitest';
import {
  applyMove,
  CHESS_GLYPHS,
  CHESS_START_FEN,
  chessBoard,
  chessCaptured,
  chessFen,
  chessFromFen,
  chessInCheck,
  chessKingSquare,
  chessLastMoveText,
  chessLegalMoves,
  chessPerft,
  chessSquareIndex,
  chessSquareName,
  chessSquareText,
  chessStatusText,
  drawAction,
  forfeit,
  newGame,
  type ChessMoveInput,
  type ChessState,
} from './index.ts';
import { t as translate, type MessageKey } from '../i18n.ts';

/** Play moves given as "e2e4" or "e7e8q", each by whoever is on turn; every one must be allowed. */
function play(state: ChessState, ...moves: string[]): ChessState {
  let s = state;
  for (const m of moves) {
    const input: ChessMoveInput = { from: m.slice(0, 2), to: m.slice(2, 4), ...(m[4] ? { promotion: m[4] as 'q' } : {}) };
    const r = applyMove(s, s.turn, input);
    if (!r.ok) throw new Error(`${m} refused: ${r.error}`);
    s = r.state as ChessState;
  }
  return s;
}

const start = () => newGame('chess', 2) as ChessState;
const targets = (s: ChessState, from: string) =>
  chessLegalMoves(s)
    .filter((m) => m.from === from)
    .map((m) => m.to)
    .sort();
const sanOf = (s: ChessState, from: string, to: string) => chessLegalMoves(s).find((m) => m.from === from && m.to === to)?.san;

describe('Chess: move generation (perft)', () => {
  it('matches the known counts from the start position', () => {
    expect(chessPerft(CHESS_START_FEN, 1)).toBe(20);
    expect(chessPerft(CHESS_START_FEN, 2)).toBe(400);
    expect(chessPerft(CHESS_START_FEN, 3)).toBe(8902);
  });

  it('matches "Kiwipete", full of castling, en passant, pins and promotions', () => {
    const kiwipete = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    expect(chessPerft(kiwipete, 1)).toBe(48);
    expect(chessPerft(kiwipete, 2)).toBe(2039);
  });

  it('matches the other standard test positions', () => {
    // Position 3: en passant along a rank with the king on it.
    expect(chessPerft('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 1)).toBe(14);
    expect(chessPerft('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 2)).toBe(191);
    expect(chessPerft('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 3)).toBe(2812);
    // Position 4: promotions with capture, castling rights lost to captures.
    expect(chessPerft('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 1)).toBe(6);
    expect(chessPerft('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 2)).toBe(264);
    // Position 5.
    expect(chessPerft('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 1)).toBe(44);
    expect(chessPerft('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 2)).toBe(1486);
  });
});

describe('Chess: the board', () => {
  it('names squares a1 to h8 and reads FEN back as it was', () => {
    expect(chessSquareName(0)).toBe('a1');
    expect(chessSquareName(63)).toBe('h8');
    expect(chessSquareIndex('e4')).toBe(28);
    expect(chessSquareIndex('i9')).toBe(-1);
    expect(chessFen(start())).toBe(CHESS_START_FEN);
    const board = chessBoard(start());
    expect(board[chessSquareIndex('e1')]).toEqual({ color: 'w', type: 'k' });
    expect(board[chessSquareIndex('d8')]).toEqual({ color: 'b', type: 'q' });
    expect(board[chessSquareIndex('e4')]).toBeNull();
    expect(chessKingSquare(start(), 'b')).toBe(60);
  });

  it('draws pieces as text, never emoji', () => {
    for (const set of Object.values(CHESS_GLYPHS)) for (const g of Object.values(set)) expect(g.endsWith('︎')).toBe(true);
  });

  it('white moves first; the starter can play black', () => {
    const s = start();
    expect(s).toMatchObject({ white: 0, turn: 0, side: 'w', moves: 0, result: null });
    const black = newGame('chess', 2, 0, { white: 1 }) as ChessState;
    expect(black).toMatchObject({ white: 1, turn: 1 });
    expect(applyMove(black, 0, { from: 'e2', to: 'e4' })).toEqual({ ok: false, error: 'not_your_turn' });
    expect(play(black, 'e2e4').turn).toBe(0);
    expect(() => newGame('chess', 3)).toThrow();
  });

  it('refuses squares off the board, the other side’s pieces, illegal moves and other games’ moves', () => {
    const s = start();
    expect(applyMove(s, 0, { from: 'e9', to: 'e4' })).toEqual({ ok: false, error: 'bad_square' });
    expect(applyMove(s, 0, { from: 'e4', to: 'e5' })).toEqual({ ok: false, error: 'not_your_piece' });
    expect(applyMove(s, 0, { from: 'e7', to: 'e5' })).toEqual({ ok: false, error: 'not_your_piece' });
    expect(applyMove(s, 0, { from: 'e2', to: 'e5' })).toEqual({ ok: false, error: 'illegal_move' });
    expect(applyMove(s, 0, { from: 'f1', to: 'c4' })).toEqual({ ok: false, error: 'illegal_move' });
    expect(applyMove(s, 0, { from: 'e2', to: 'e4', promotion: 'q' })).toEqual({ ok: false, error: 'bad_promotion' });
    expect(applyMove(s, 0, { column: 3 })).toEqual({ ok: false, error: 'wrong_move' });
    expect(applyMove(s, 1, { from: 'e7', to: 'e5' })).toEqual({ ok: false, error: 'not_your_turn' });
  });

  it('writes moves in standard notation and keeps the move list', () => {
    const s = play(start(), 'e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5a5', 'g1f3');
    expect(s.san).toEqual(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'Nf3']);
    expect(s).toMatchObject({ side: 'b', halfmove: 3, fullmove: 4, moves: 7 });
    expect(s.last).toEqual({ from: 'g1', to: 'f3', piece: 'n' });
    expect(play(s, 'a5c3').last).toEqual({ from: 'a5', to: 'c3', piece: 'q', captured: 'n' });
    expect(chessCaptured(play(s, 'a5c3'))).toEqual({ w: ['n', 'p'], b: ['p'] });
  });

  it('names the file, the rank or both when two pieces could make the same move', () => {
    const knights = chessFromFen('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
    expect(sanOf(knights, 'b1', 'd2')).toBe('Nbd2');
    expect(sanOf(knights, 'f1', 'd2')).toBe('Nfd2');
    expect(sanOf(knights, 'b1', 'a3')).toBe('Na3');
    const rooks = chessFromFen('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1');
    expect(sanOf(rooks, 'a1', 'a3')).toBe('R1a3');
    expect(sanOf(rooks, 'a5', 'a3')).toBe('R5a3');
    const queens = chessFromFen('4k3/8/8/8/8/Q7/8/Q1Q1K3 w - - 0 1');
    expect(sanOf(queens, 'a1', 'b2')).toBe('Qa1b2');
  });
});

describe('Chess: castling', () => {
  const open = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';

  it('castles on both sides, moving the rook too', () => {
    const s = chessFromFen(open);
    expect(sanOf(s, 'e1', 'g1')).toBe('O-O');
    expect(sanOf(s, 'e1', 'c1')).toBe('O-O-O');
    const short = play(s, 'e1g1');
    expect(short.board.endsWith('R4RK1')).toBe(true);
    expect(short.castling).toBe('kq');
    expect(short.last).toMatchObject({ castle: 'k' });
    const long = play(short, 'e8c8');
    expect(long.board.startsWith('2kr3r')).toBe(true);
    expect(long.castling).toBe('-');
    expect(long.san).toEqual(['O-O', 'O-O-O']);
  });

  it('loses the right when the king or a rook moves, or a rook is taken', () => {
    expect(play(chessFromFen(open), 'e1f1', 'e8f8', 'f1e1', 'f8e8').castling).toBe('-');
    const rook = play(chessFromFen(open), 'h1g1', 'a8b8', 'g1h1', 'b8a8');
    expect(rook.castling).toBe('Qk');
    expect(targets(rook, 'e1')).not.toContain('g1');
    expect(targets(rook, 'e1')).toContain('c1');
    // A knight takes the rook on h8: black can't castle that way any more.
    const taken = chessFromFen('r3k2r/pppppp1p/6N1/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    expect(play(taken, 'g6h8').castling).toBe('KQq');
  });

  it('never out of, through or into check, and not with pieces in the way', () => {
    // In check from a rook on e8.
    expect(targets(chessFromFen('4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1')).not.toContain('g1');
    expect(targets(chessFromFen('4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1')).not.toContain('c1');
    // Through check: f1 is attacked, so no short castling; long is fine.
    const through = chessFromFen('5rk1/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(targets(through, 'e1')).not.toContain('g1');
    expect(targets(through, 'e1')).toContain('c1');
    // Into check: g1 is attacked.
    expect(targets(chessFromFen('6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1')).not.toContain('g1');
    // Queenside, b1 may be attacked (the king doesn't cross it), but d1 may not.
    expect(targets(chessFromFen('1r4k1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1')).toContain('c1');
    expect(targets(chessFromFen('3r2k1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1')).not.toContain('c1');
    // A knight in the way.
    expect(targets(chessFromFen('6k1/8/8/8/8/8/8/RN2K1NR w KQ - 0 1'), 'e1')).toEqual(['d1', 'd2', 'e2', 'f1', 'f2']);
  });
});

describe('Chess: en passant', () => {
  it('can take a pawn that just moved two squares, only on the next move', () => {
    const s = play(start(), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    expect(s.ep).toBe('d6');
    expect(sanOf(s, 'e5', 'd6')).toBe('exd6');
    const took = play(s, 'e5d6');
    expect(chessBoard(took)[chessSquareIndex('d5')]).toBeNull();
    expect(took.last).toMatchObject({ enPassant: true, captured: 'p' });
    // A move later, it's gone.
    const late = play(s, 'g1f3', 'a6a5');
    expect(targets(late, 'e5')).not.toContain('d6');
  });

  it('not when it would leave the king in check along the rank', () => {
    // Both pawns leave rank 5 and the rook on h5 would see the king on a5.
    const pinned = chessFromFen('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1');
    expect(targets(pinned, 'e5')).toEqual(['e6']);
    expect(applyMove(pinned, 0, { from: 'e5', to: 'd6' })).toEqual({ ok: false, error: 'illegal_move' });
  });
});

describe('Chess: promotion', () => {
  const near = '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1';

  it('asks which piece, and allows any of the four', () => {
    const s = chessFromFen(near);
    expect(applyMove(s, 0, { from: 'e7', to: 'e8' })).toEqual({ ok: false, error: 'promotion_needed' });
    expect(applyMove(s, 0, { from: 'e7', to: 'e8', promotion: 'k' as 'q' })).toEqual({ ok: false, error: 'bad_promotion' });
    expect(
      chessLegalMoves(s)
        .filter((m) => m.from === 'e7')
        .map((m) => m.san),
    ).toEqual(['e8=Q', 'e8=R', 'e8=B', 'e8=N+']);
    const queen = play(s, 'e7e8q');
    expect(chessBoard(queen)[chessSquareIndex('e8')]).toEqual({ color: 'w', type: 'q' });
    expect(queen.last).toMatchObject({ promotion: 'q' });
    const knight = play(s, 'e7e8n');
    expect(knight.san).toEqual(['e8=N+']);
    expect(chessInCheck(knight)).toBe(true);
  });

  it('promotes when taking, too', () => {
    const s = chessFromFen('3r2k1/4P3/8/8/8/8/8/4K3 w - - 0 1');
    expect(sanOf(s, 'e7', 'd8')?.startsWith('exd8=')).toBe(true);
    expect(play(s, 'e7d8q').san).toEqual(['exd8=Q+']);
  });
});

describe('Chess: how games end', () => {
  it('fool’s mate: black wins by checkmate', () => {
    const s = play(start(), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(s.san.at(-1)).toBe('Qh4#');
    expect(s.result).toEqual({ type: 'win', winner: 1, by: 'play' });
    expect(chessLegalMoves(s)).toEqual([]);
    expect(applyMove(s, 0, { from: 'a2', to: 'a3' })).toEqual({ ok: false, error: 'game_over' });
  });

  it('a back-rank mate, with the starter playing black', () => {
    const s = chessFromFen('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 1);
    const done = play(s, 'a1a8');
    expect(done.san).toEqual(['Ra8#']);
    expect(done.result).toEqual({ type: 'win', winner: 1, by: 'play' });
  });

  it('check is not mate while the king can get out of it', () => {
    const s = play(start(), 'e2e4', 'f7f6', 'd1h5');
    expect(s.san.at(-1)).toBe('Qh5+');
    expect(chessInCheck(s)).toBe(true);
    expect(s.result).toBeNull();
    expect(targets(s, 'g7')).toEqual(['g6']);
  });

  it('stalemate is a draw', () => {
    const s = play(chessFromFen('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1'), 'f1f7');
    expect(s.result).toEqual({ type: 'draw', reason: 'stalemate' });
  });

  it('too few pieces to checkmate is a draw', () => {
    // The king takes the last rook: king and bishop against a king.
    expect(play(chessFromFen('k7/8/8/8/8/8/1r6/KB6 w - - 0 1'), 'a1b2').result).toEqual({ type: 'draw', reason: 'material' });
    // Kings alone.
    expect(play(chessFromFen('k7/8/8/8/8/8/1q6/K7 w - - 0 1'), 'a1b2').result).toEqual({ type: 'draw', reason: 'material' });
    // A knight alone.
    expect(play(chessFromFen('k7/8/8/8/8/8/1q6/KN6 w - - 0 1'), 'a1b2').result).toEqual({ type: 'draw', reason: 'material' });
    // Bishops on the same colour of square: a draw; on different colours, play on.
    expect(play(chessFromFen('k7/8/8/2b5/8/8/1q6/KB6 w - - 0 1'), 'a1b2').result).toBeNull();
    expect(play(chessFromFen('k7/8/8/3b4/8/8/1q6/KB6 w - - 0 1'), 'a1b2').result).toEqual({ type: 'draw', reason: 'material' });
    // Two knights against a lone king could still (in theory) mate with help, and a pawn always can.
    expect(play(chessFromFen('k7/8/8/8/8/8/1q6/KNN5 w - - 0 1'), 'a1b2').result).toBeNull();
    expect(play(chessFromFen('k7/p7/8/8/8/8/1q6/K7 w - - 0 1'), 'a1b2').result).toBeNull();
  });

  it('fifty moves each without a capture or pawn move is a draw, unless the last one mates', () => {
    const quiet = chessFromFen('7k/8/8/8/8/8/8/R5K1 w - - 99 80');
    expect(play(quiet, 'a1a2').result).toEqual({ type: 'draw', reason: 'fifty_moves' });
    expect(play(chessFromFen('7k/8/8/8/8/8/8/R5K1 w - - 98 80'), 'a1a2').result).toBeNull();
    const mate = chessFromFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 99 80');
    expect(play(mate, 'a1a8').result).toEqual({ type: 'win', winner: 0, by: 'play' });
    // A pawn move starts the count again.
    expect(play(chessFromFen('7k/8/8/8/8/8/P7/R5K1 w - - 99 80'), 'a2a3')).toMatchObject({ halfmove: 0, result: null });
  });

  it('the same position three times is a draw', () => {
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const twice = play(start(), ...shuffle);
    expect(twice.result).toBeNull();
    expect(twice.seen).toHaveLength(5);
    const thrice = play(twice, ...shuffle);
    expect(thrice.result).toEqual({ type: 'draw', reason: 'repetition' });
    expect(thrice.san).toHaveLength(8);
  });

  it('positions before a capture or pawn move are forgotten', () => {
    const s = play(start(), 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'e2e4');
    expect(s.seen).toHaveLength(1);
  });

  it('a pawn that could take en passant makes the position different', () => {
    // After ...d5, white's e5 pawn could take on d6: that position isn't the same as a later one with the same pieces.
    let s = play(start(), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    const firstKey = s.seen.at(-1);
    s = play(s, 'g1f3', 'g8f6', 'f3g1', 'f6g8');
    expect(s.seen.at(-1)).not.toBe(firstKey);
    // Without a pawn able to take, the square doesn't count.
    const plain = play(start(), 'e2e4');
    const again = play(plain, 'g8f6', 'g1f3', 'f6g8', 'f3g1');
    expect(again.seen.at(-1)).toBe(again.seen.at(-5));
  });
});

describe('Chess: draw offers and resigning', () => {
  it('offer, then the other player accepts: a draw by agreement', () => {
    const s = play(start(), 'e2e4');
    const offered = drawAction(s, 0, 'offer');
    if (!offered.ok) throw new Error(offered.error);
    expect((offered.state as ChessState).drawOffer).toEqual({ seat: 0, at: 1 });
    expect(drawAction(offered.state, 0, 'accept')).toEqual({ ok: false, error: 'no_draw_offer' });
    expect(drawAction(offered.state, 1, 'offer')).toEqual({ ok: false, error: 'draw_offered' });
    const accepted = drawAction(offered.state, 1, 'accept');
    expect(accepted.ok && accepted.state.result).toEqual({ type: 'draw', reason: 'agreed' });
  });

  it('a declined offer is gone, and the same player can offer again only after a move of their own', () => {
    const s = start();
    const offered = drawAction(s, 0, 'offer');
    if (!offered.ok) throw new Error(offered.error);
    const declined = drawAction(offered.state, 1, 'decline');
    if (!declined.ok) throw new Error(declined.error);
    expect((declined.state as ChessState).drawOffer).toBeNull();
    expect(drawAction(declined.state, 0, 'offer')).toEqual({ ok: false, error: 'draw_too_soon' });
    expect(drawAction(declined.state, 1, 'accept')).toEqual({ ok: false, error: 'no_draw_offer' });
    const later = play(declined.state as ChessState, 'e2e4', 'e7e5');
    expect(drawAction(later, 0, 'offer').ok).toBe(true);
    // The other player hasn't offered yet, so they can.
    expect(drawAction(declined.state, 1, 'offer').ok).toBe(true);
  });

  it('an offer stands through the offerer’s move and lapses after their next one', () => {
    const offered = drawAction(start(), 0, 'offer');
    if (!offered.ok) throw new Error(offered.error);
    const s1 = play(offered.state as ChessState, 'e2e4');
    expect(s1.drawOffer).toEqual({ seat: 0, at: 0 });
    const s2 = play(s1, 'e7e5');
    expect(s2.drawOffer).toEqual({ seat: 0, at: 0 });
    const s3 = play(s2, 'g1f3');
    expect(s3.drawOffer).toBeNull();
    // Offered on the other player's turn: it lapses with the offerer's next move.
    const onTheirTurn = drawAction(play(start(), 'e2e4'), 0, 'offer');
    if (!onTheirTurn.ok) throw new Error(onTheirTurn.error);
    const t1 = play(onTheirTurn.state as ChessState, 'e7e5');
    expect(t1.drawOffer).not.toBeNull();
    expect(play(t1, 'g1f3').drawOffer).toBeNull();
  });

  it('only chess has draw offers; resigning hands the other player the win', () => {
    expect(drawAction(newGame('noughts', 2), 0, 'offer')).toEqual({ ok: false, error: 'wrong_move' });
    expect(drawAction(start(), 2, 'offer')).toEqual({ ok: false, error: 'not_a_player' });
    const offered = drawAction(start(), 1, 'offer');
    if (!offered.ok) throw new Error(offered.error);
    const r = forfeit(offered.state, 0);
    expect(r.ok && r.state.result).toEqual({ type: 'win', winner: 1, by: 'forfeit' });
    expect(r.ok && (r.state as ChessState).drawOffer).toBeNull();
  });

  it('states survive a round trip through JSON, as they are stored', () => {
    const s = play(start(), 'e2e4', 'c7c5', 'g1f3');
    const back = JSON.parse(JSON.stringify(s)) as ChessState;
    expect(play(back, 'd7d6')).toEqual(play(s, 'd7d6'));
  });
});

describe('Chess in words', () => {
  const en = (key: MessageKey, vars?: Record<string, string | number>) => translate(key, 'en', vars);

  it('reads out moves: plain, captures, castling, en passant, promotion, check and mate', () => {
    expect(chessLastMoveText(en, play(start(), 'g1f3'), 'Ada')).toBe('Ada played knight to f3.');
    expect(chessLastMoveText(en, play(start(), 'e2e4', 'd7d5', 'e4d5'), 'Ada')).toBe('Ada played pawn to d5, taking the pawn.');
    expect(chessLastMoveText(en, play(chessFromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), 'e1g1'), 'Ada')).toBe('Ada castled kingside.');
    expect(chessLastMoveText(en, play(start(), 'e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'), 'Ada')).toBe('Ada played pawn to d6, taking the pawn, en passant.');
    expect(chessLastMoveText(en, play(chessFromFen('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1'), 'e7e8n'), 'Ada')).toBe(
      'Ada played pawn to e8, promoted to knight, check.',
    );
    expect(chessLastMoveText(en, play(start(), 'f2f3', 'e7e5', 'g2g4', 'd8h4'), 'Sam')).toBe('Sam played queen to h4, checkmate.');
    expect(chessLastMoveText(en, start(), 'Ada')).toBe('');
  });

  it('labels squares and says where the game stands', () => {
    expect(chessSquareText(en, start(), chessSquareIndex('g1'))).toBe('g1, white knight');
    expect(chessSquareText(en, start(), chessSquareIndex('e4'))).toBe('e4, empty');
    const names = ['You', 'Sam'];
    expect(chessStatusText(en, start(), names, 0)).toBe('White to move');
    expect(chessStatusText(en, play(start(), 'e2e4', 'f7f6', 'd1h5'), names, 0)).toBe('Check. Black to move');
    const mate = play(start(), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(chessStatusText(en, mate, names, 0)).toBe('Checkmate. Sam won.');
    expect(chessStatusText(en, mate, ['Ada', 'You'], 1)).toBe('Checkmate. You won.');
    // Right after the move was read out ("..., checkmate."), it isn't said twice.
    expect(chessStatusText(en, mate, ['Ada', 'You'], 1, true)).toBe('You won');
    expect(chessStatusText(en, play(start(), 'e2e4', 'f7f6', 'd1h5'), names, 0, true)).toBe('Black to move');
    const resigned = forfeit(start(), 1);
    if (!resigned.ok) throw new Error(resigned.error);
    expect(chessStatusText(en, resigned.state as ChessState, names, 0)).toBe('Sam resigned. You won.');
    expect(chessStatusText(en, resigned.state as ChessState, ['Ada', 'You'], 1)).toBe('You resigned. Ada won.');
    expect(chessStatusText(en, resigned.state as ChessState, ['Ada', 'Sam'], -1)).toBe('Sam resigned. Ada won.');
    const stale = play(chessFromFen('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1'), 'f1f7');
    expect(chessStatusText(en, stale, names, 0)).toBe('Draw: stalemate');
  });
});
