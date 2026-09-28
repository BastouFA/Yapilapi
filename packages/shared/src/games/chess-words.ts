import type { MessageKey } from '../i18n-core.ts';
import { chessBoard, chessInCheck, chessSquareName } from './chess.ts';
import type { ChessColor, ChessPieceType, ChessState, DrawReason } from './types.ts';

/**
 * Chess in words, for the web and the phone alike: what each square holds ("e4, white knight"),
 * what the last move was ("Ada played knight to f3, check."), and where the game stands ("Check.
 * Black to move", "Checkmate. Ada won."). Names come in already chosen ("You" for yourself).
 */

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** "white knight". */
export const chessPieceLabel = (t: Tr, color: ChessColor, type: ChessPieceType): string => t(`m.chat.game.chess.name.${color}${type}` as MessageKey);

/** "White" or "Black". */
export const chessSideLabel = (t: Tr, color: ChessColor): string => t(`m.chat.game.chess.side.${color}` as MessageKey);

/** Why a chess game was drawn, as the end of a sentence: "stalemate", "agreed by both players". */
export const chessDrawReason = (t: Tr, reason: DrawReason): string => t(`m.chat.game.chess.reason.${reason}` as MessageKey);

/** "e4, white knight" or "e4, empty". */
export function chessSquareText(t: Tr, state: ChessState, sq: number): string {
  const piece = chessBoard(state)[sq];
  return `${chessSquareName(sq)}, ${piece ? chessPieceLabel(t, piece.color, piece.type) : t('m.chat.game.empty')}`;
}

/** The last move in words, with `mover` as the name of whoever played it: "Ada played knight to f3, check." */
export function chessLastMoveText(t: Tr, state: ChessState, mover: string): string {
  const last = state.last;
  if (!last) return '';
  const piece = (type: ChessPieceType) => t(`m.chat.game.chess.piece.${type}` as MessageKey);
  const parts = [
    last.castle
      ? t(last.castle === 'k' ? 'm.chat.game.chess.castledShort' : 'm.chat.game.chess.castledLong', { name: mover })
      : last.captured
        ? t('m.chat.game.chess.playedTake', { name: mover, piece: piece(last.piece), square: last.to, captured: piece(last.captured) })
        : t('m.chat.game.chess.played', { name: mover, piece: piece(last.piece), square: last.to }),
  ];
  if (last.enPassant) parts.push(t('m.chat.game.chess.enPassant'));
  if (last.promotion) parts.push(t('m.chat.game.chess.promotedTo', { piece: piece(last.promotion) }));
  const san = state.san.at(-1) ?? '';
  if (san.endsWith('#')) parts.push(t('m.chat.game.chess.mateWord'));
  else if (san.endsWith('+')) parts.push(t('m.chat.game.chess.checkWord'));
  return `${parts.join(', ')}.`;
}

/**
 * Where the game stands. `names` are the players' names by seat; `me` is your seat (-1 when you're
 * watching). "White to move", "Check. Black to move", "Checkmate. You won.", "Sam resigned. You
 * won.", "Draw: stalemate". `afterMove`: the last move has just been read out (and said "check" or
 * "checkmate"), so this doesn't say it again: "Black to move", "You won".
 */
export function chessStatusText(t: Tr, state: ChessState, names: string[], me: number, afterMove = false): string {
  const r = state.result;
  if (!r) {
    const toMove = t(`m.chat.game.chess.toMove.${state.side}` as MessageKey);
    return chessInCheck(state) && !afterMove ? `${t('m.chat.game.chess.check')}. ${toMove}` : toMove;
  }
  if (r.type === 'draw') return r.reason ? t('m.chat.game.chess.drawBy', { reason: chessDrawReason(t, r.reason) }) : t('m.chat.game.draw');
  if (r.type === 'unfinished') return t('m.chat.game.unfinished');
  const winner = names[r.winner] ?? '';
  const loser = names[1 - r.winner] ?? '';
  if (r.by === 'play' && afterMove) return r.winner === me ? t('m.chat.game.youWon') : t('m.chat.game.won', { name: winner });
  if (r.by === 'play') return r.winner === me ? t('m.chat.game.chess.mateYou') : t('m.chat.game.chess.mate', { name: winner });
  if (me === r.winner) return t('m.chat.game.chess.theyResigned', { name: loser });
  if (me === 1 - r.winner) return t('m.chat.game.chess.youResigned', { name: winner });
  return t('m.chat.game.chess.resigned', { loser, name: winner });
}
