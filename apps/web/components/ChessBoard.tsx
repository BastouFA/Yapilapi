'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@yapilapi/design-system';
import {
  CHESS_GLYPHS,
  CHESS_PROMOTIONS,
  chessBoard,
  chessCaptured,
  chessColorSeat,
  chessInCheck,
  chessKingSquare,
  chessLegalMoves,
  chessLightSquare,
  chessPieceLabel,
  chessSeatColor,
  chessSquareIndex,
  chessSquareName,
  type ChessColor,
  type ChessMoveInput,
  type ChessPromotion,
  type ChessState,
  type MessageKey,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/**
 * The chess board (web). An 8 by 8 grid you move around with the arrow keys (one square in the tab
 * order at a time); every square says what's on it ("e4, white knight") and what it means right now
 * ("picked up", "move here", "last move"). Click or press Enter or Space on one of your pieces to
 * pick it up, then on a highlighted square to put it down; Escape puts it back. A pawn reaching the
 * last rank asks what it becomes. The board turns round when you play black.
 */

/** Display position (0 = top left) to square (0 = a1), from white's side or black's. */
const squareAt = (d: number, flip: boolean) => {
  const row = Math.floor(d / 8);
  const col = d % 8;
  return flip ? row * 8 + (7 - col) : (7 - row) * 8 + col;
};

export function ChessBoard({
  state,
  moveNumber,
  seat,
  canMove,
  describedBy,
  onMove,
}: {
  state: ChessState;
  moveNumber: number;
  /** Your seat (-1 when watching). */
  seat: number;
  canMove: boolean;
  describedBy: string;
  onMove: (move: ChessMoveInput) => void;
}) {
  const { t } = useSession();
  const mine: ChessColor | null = seat >= 0 ? chessSeatColor(state, seat) : null;
  const flip = mine === 'b';
  const board = useMemo(() => chessBoard(state), [state]);
  const legal = useMemo(() => (canMove ? chessLegalMoves(state) : []), [state, canMove]);
  const [picked, setPicked] = useState<number | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [focus, setFocus] = useState(() => {
    // Start on your king, so the keyboard starts somewhere useful.
    const k = chessKingSquare(state, mine ?? 'w');
    return Array.from({ length: 64 }, (_, d) => d).find((d) => squareAt(d, flip) === k) ?? 0;
  });
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const promoRef = useRef<HTMLDivElement>(null);
  const helpId = useId();

  // A new position (anyone's move) puts down whatever was picked up.
  useEffect(() => {
    setPicked(null);
    setPromotion(null);
  }, [moveNumber]);
  useEffect(() => {
    if (promotion) promoRef.current?.querySelector('button')?.focus();
  }, [promotion]);

  const targets = picked === null ? [] : legal.filter((m) => m.from === chessSquareName(picked));
  const targetSet = new Set(targets.map((m) => chessSquareIndex(m.to)));
  const lastFrom = state.last ? chessSquareIndex(state.last.from) : -1;
  const lastTo = state.last ? chessSquareIndex(state.last.to) : -1;
  const checked = !state.result && chessInCheck(state) ? chessKingSquare(state, state.side) : -1;
  const movable = new Set(legal.map((m) => chessSquareIndex(m.from)));

  function choose(sq: number) {
    if (!canMove) return;
    const piece = board[sq];
    if (picked !== null && targetSet.has(sq)) {
      const from = chessSquareName(picked);
      const to = chessSquareName(sq);
      if (targets.some((m) => m.to === to && m.promotion)) return setPromotion({ from, to });
      setPicked(null);
      return onMove({ from, to });
    }
    if (piece && piece.color === mine && sq !== picked && movable.has(sq)) return setPicked(sq);
    setPicked(null);
  }

  function onKeyDown(e: KeyboardEvent, d: number) {
    if (e.key === 'Escape' && (picked !== null || promotion)) {
      // Put the piece back (and keep the sheet open). The sheet listens on the document, where React
      // does too, so stopping the event going further up isn't enough.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setPicked(null);
      setPromotion(null);
      return;
    }
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 };
    let next = d;
    if (e.key in steps) next = d + steps[e.key]!;
    else if (e.key === 'Home') next = d - (d % 8);
    else if (e.key === 'End') next = d - (d % 8) + 7;
    else return;
    e.preventDefault();
    if (next < 0 || next > 63 || (Math.abs(steps[e.key] ?? 0) === 1 && Math.floor(next / 8) !== Math.floor(d / 8))) return;
    setFocus(next);
    refs.current[next]?.focus();
  }

  const files = flip ? 'hgfedcba' : 'abcdefgh';
  return (
    <div className="chess">
      <div
        role="grid"
        aria-label={t('m.chat.game.board', { game: t('m.chat.game.kind.chess') })}
        aria-describedby={`${describedBy} ${helpId}`}
        className="chess-board"
        dir="ltr"
      >
        {Array.from({ length: 8 }, (_, row) => (
          <div role="row" key={row} className="chess-board__row">
            {Array.from({ length: 8 }, (_, col) => {
              const d = row * 8 + col;
              const sq = squareAt(d, flip);
              const piece = board[sq];
              const target = targetSet.has(sq);
              const notes = [
                picked === sq ? t('m.chat.game.chess.picked') : '',
                target ? t(piece ? 'm.chat.game.chess.canTake' : 'm.chat.game.chess.canMove') : '',
                sq === lastFrom || sq === lastTo ? t('m.chat.game.chess.lastMove') : '',
                sq === checked ? t('m.chat.game.chess.inCheck') : '',
              ].filter(Boolean);
              const label = [chessSquareName(sq), piece ? chessPieceLabel(t, piece.color, piece.type) : t('m.chat.game.empty'), ...notes].join(', ');
              const usable = canMove && (target || (!!piece && piece.color === mine && movable.has(sq)));
              const classes = [
                'chess-sq',
                chessLightSquare(sq) ? 'chess-sq--light' : 'chess-sq--dark',
                sq === lastFrom || sq === lastTo ? 'chess-sq--last' : '',
                picked === sq ? 'chess-sq--picked' : '',
                target ? (piece ? 'chess-sq--take' : 'chess-sq--target') : '',
                sq === checked ? 'chess-sq--check' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div role="gridcell" key={col} className="chess-board__cell">
                  <button
                    ref={(el) => void (refs.current[d] = el)}
                    type="button"
                    className={classes}
                    tabIndex={focus === d ? 0 : -1}
                    aria-label={label}
                    aria-disabled={!usable}
                    onFocus={() => setFocus(d)}
                    onKeyDown={(e) => onKeyDown(e, d)}
                    onClick={() => choose(sq)}
                  >
                    {piece ? (
                      <span className={`chess-piece chess-piece--${piece.color}`} aria-hidden>
                        {CHESS_GLYPHS[piece.color][piece.type]}
                      </span>
                    ) : null}
                    {col === 0 ? (
                      <span className="chess-sq__rank" aria-hidden>
                        {Math.floor(sq / 8) + 1}
                      </span>
                    ) : null}
                    {row === 7 ? (
                      <span className="chess-sq__file" aria-hidden>
                        {files[col]}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {promotion && mine ? (
        <div ref={promoRef} role="group" aria-label={t('m.chat.game.chess.promote')} className="chess-promotion">
          <span className="chess-promotion__label">{t('m.chat.game.chess.promote')}</span>
          <div className="chess-promotion__options">
            {CHESS_PROMOTIONS.map((p: ChessPromotion) => (
              <button
                key={p}
                type="button"
                className="chess-promotion__option"
                onClick={() => {
                  const move = { ...promotion, promotion: p };
                  setPromotion(null);
                  setPicked(null);
                  onMove(move);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  setPromotion(null);
                }}
              >
                <span className={`chess-piece chess-piece--${mine}`} aria-hidden>
                  {CHESS_GLYPHS[mine][p]}
                </span>
                {t(`m.chat.game.chess.promo.${p}` as MessageKey)}
              </button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setPromotion(null)}>
              {t('m.chat.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      <p className="chat-poll__status" id={helpId}>
        {canMove ? t('m.chat.game.chess.help') : ''}
      </p>
    </div>
  );
}

/** Pieces each player has taken, and the moves so far in standard notation. */
export function ChessRecord({ state, names }: { state: ChessState; names: string[] }) {
  const { t } = useSession();
  const captured = chessCaptured(state);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.san.length]);
  // Numbered pairs, white's move then black's: "1. e4 e5".
  const pairs: string[][] = [];
  for (let i = 0; i < state.san.length; i += 2) pairs.push(state.san.slice(i, i + 2));
  return (
    <div className="chess-record">
      {(['w', 'b'] as const).map((color) => {
        // What white has taken is black's pieces, and the other way round.
        const taken = captured[color === 'w' ? 'b' : 'w'];
        if (!taken.length) return null;
        const other: ChessColor = color === 'w' ? 'b' : 'w';
        return (
          <p key={color} className="chess-record__taken">
            <span className="chess-record__who">
              <bdi>{t('m.chat.game.chess.taken', { name: names[chessColorSeat(state, color)] ?? '' })}</bdi>
            </span>{' '}
            <span className={`chess-record__pieces chess-piece--${other}`} aria-hidden>
              {taken.map((p) => CHESS_GLYPHS[other][p]).join('')}
            </span>
            <span className="yp-visually-hidden">{taken.map((p) => chessPieceLabel(t, other, p)).join(', ')}</span>
          </p>
        );
      })}
      <h3 className="chess-record__title">{t('m.chat.game.chess.moves')}</h3>
      {pairs.length ? (
        <ol ref={listRef} className="chess-record__moves" dir="ltr" tabIndex={0} aria-label={t('m.chat.game.chess.moves')}>
          {pairs.map((p, i) => (
            <li key={i}>
              <span>{p[0]}</span>
              {p[1] ? <span>{p[1]}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="chat-poll__status">{t('m.chat.game.chess.noMoves')}</p>
      )}
    </div>
  );
}

/** The position as a small picture for the game's card, from your side of the board. */
export function MiniChess({ state, seat }: { state: ChessState; seat: number }) {
  const flip = seat >= 0 && chessSeatColor(state, seat) === 'b';
  const board = chessBoard(state);
  return (
    <span className="chess-mini" dir="ltr">
      {Array.from({ length: 64 }, (_, d) => {
        const sq = squareAt(d, flip);
        const piece = board[sq];
        return (
          <span key={d} className={`chess-mini__sq ${chessLightSquare(sq) ? 'chess-sq--light' : 'chess-sq--dark'}`}>
            {piece ? CHESS_GLYPHS[piece.color][piece.type] : null}
          </span>
        );
      })}
    </span>
  );
}
