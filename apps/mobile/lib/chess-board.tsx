import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Pressable, Text, useWindowDimensions, View } from 'react-native';
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
  type ChessState,
} from '../../../packages/shared/src/games/index';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Button, useColors, userText } from './ui';

/**
 * The chess board (mobile). Tap one of your pieces to pick it up, then a marked square to put it
 * down; tap it again to put it back. Every square is a button whose label says what's on it and
 * what it means now ("e4, white knight, move here"). The board turns round when you play black and
 * reaches out past the sheet's padding to the screen's edges, so squares are as big as the screen
 * allows: 46 points on a 375-point phone, 48 on a 390, and 39 on a 320 (44 needs a 356-point screen).
 * A pawn reaching the last rank asks what it becomes.
 */

/** The board's own wood colours, the same in light and dark: near-black pieces are 6:1 on the dark squares and 13:1 on the light ones. */
const BOARD = { light: '#f0d9b5', dark: '#b58863', ink: '#1b1b1b', edge: '#6b4a2e', side: '#4a321c', last: 'rgba(205, 210, 106, 0.8)', check: '#d42020' };

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
  threeD = false,
  onMove,
}: {
  state: ChessState;
  moveNumber: number;
  /** Your seat (-1 when watching). */
  seat: number;
  canMove: boolean;
  /**
   * The 3D view: the board lies back towards the camera with a wooden edge, and each piece is drawn
   * twice, a dark copy just below it, so it looks raised. Transforms only; the same squares and labels.
   */
  threeD?: boolean;
  onMove: (move: ChessMoveInput) => void;
}) {
  const { t } = useT();
  const c = useColors();
  const { width } = useWindowDimensions();
  const mine: ChessColor | null = seat >= 0 ? chessSeatColor(state, seat) : null;
  const flip = mine === 'b';
  const board = useMemo(() => chessBoard(state), [state]);
  const legal = useMemo(() => (canMove ? chessLegalMoves(state) : []), [state, canMove]);
  const [picked, setPicked] = useState<number | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const promoRef = useRef<View>(null);
  useEffect(() => {
    setPicked(null);
    setPromotion(null);
  }, [moveNumber]);
  useEffect(() => {
    const node = promotion && promoRef.current ? findNodeHandle(promoRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [promotion]);

  // The sheet's content is its width less 16 points each side. The board takes the whole screen's
  // width (less its 2-point frame each side), reaching into that padding with a negative margin.
  const content = width - space[4] * 2;
  const size = Math.max(28, Math.min(56, Math.floor((width - 4) / 8)));
  const boardWidth = size * 8 + 4;
  const bleed = Math.min(0, (content - boardWidth) / 2);

  const targets = picked === null ? [] : legal.filter((m) => m.from === chessSquareName(picked));
  const targetSet = new Set(targets.map((m) => chessSquareIndex(m.to)));
  const movable = new Set(legal.map((m) => chessSquareIndex(m.from)));
  const lastFrom = state.last ? chessSquareIndex(state.last.from) : -1;
  const lastTo = state.last ? chessSquareIndex(state.last.to) : -1;
  const checked = !state.result && chessInCheck(state) ? chessKingSquare(state, state.side) : -1;

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

  return (
    <View style={{ gap: space[2] }}>
      <View
        accessibilityLabel={t('m.chat.game.board', { game: t('m.chat.game.kind.chess') })}
        style={[
          {
            alignSelf: 'center',
            marginHorizontal: bleed,
            width: boardWidth,
            borderWidth: 2,
            borderColor: BOARD.edge,
            borderRadius: 6,
            overflow: 'hidden',
            direction: 'ltr',
          },
          threeD
            ? {
                borderBottomWidth: 10,
                borderBottomColor: BOARD.side,
                transform: [{ perspective: 1000 }, { rotateX: '22deg' }, { scale: 0.94 }],
                shadowColor: '#000',
                shadowOpacity: 0.35,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: 10 },
                elevation: 10,
              }
            : null,
        ]}
      >
        {Array.from({ length: 8 }, (_, row) => (
          <View key={row} style={{ flexDirection: 'row' }}>
            {Array.from({ length: 8 }, (_, col) => {
              const d = row * 8 + col;
              const sq = squareAt(d, flip);
              const piece = board[sq];
              const target = targetSet.has(sq);
              const last = sq === lastFrom || sq === lastTo;
              const usable = canMove && (target || (!!piece && piece.color === mine && movable.has(sq)));
              const label = [
                chessSquareName(sq),
                piece ? chessPieceLabel(t, piece.color, piece.type) : t('m.chat.game.empty'),
                picked === sq ? t('m.chat.game.chess.picked') : '',
                target ? t(piece ? 'm.chat.game.chess.canTake' : 'm.chat.game.chess.canMove') : '',
                last ? t('m.chat.game.chess.lastMove') : '',
                sq === checked ? t('m.chat.game.chess.inCheck') : '',
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <Pressable
                  key={col}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: picked === sq, disabled: !usable }}
                  onPress={() => choose(sq)}
                  style={{
                    width: size,
                    height: size,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: chessLightSquare(sq) ? BOARD.light : BOARD.dark,
                  }}
                >
                  {last ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: BOARD.last }} /> : null}
                  {sq === checked ? (
                    <View
                      style={{
                        position: 'absolute',
                        width: size * 0.9,
                        height: size * 0.9,
                        borderRadius: size,
                        backgroundColor: BOARD.check,
                        opacity: 0.85,
                      }}
                    />
                  ) : null}
                  {picked === sq ? (
                    <View
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        borderWidth: 3,
                        borderColor: BOARD.ink,
                      }}
                    >
                      <View style={{ flex: 1, borderWidth: 2, borderColor: '#fff' }} />
                    </View>
                  ) : null}
                  {piece && threeD ? (
                    // A dark copy a little lower, then the piece raised above its square: layered glyphs for depth.
                    <Text
                      allowFontScaling={false}
                      style={{
                        position: 'absolute',
                        color: 'rgba(0,0,0,0.35)',
                        fontSize: Math.round(size * 0.78),
                        lineHeight: Math.round(size * 0.9),
                        transform: [{ translateY: size * 0.02 }, { scaleX: 1.04 }],
                      }}
                    >
                      {CHESS_GLYPHS[piece.color][piece.type]}
                    </Text>
                  ) : null}
                  {piece ? (
                    <Text
                      allowFontScaling={false}
                      style={[
                        { color: BOARD.ink, fontSize: Math.round(size * 0.74), lineHeight: Math.round(size * 0.9) },
                        threeD
                          ? {
                              fontSize: Math.round(size * 0.8),
                              transform: [{ translateY: -size * 0.1 }],
                              textShadowColor: 'rgba(0,0,0,0.3)',
                              textShadowOffset: { width: 0, height: 2 },
                              textShadowRadius: 1,
                            }
                          : null,
                      ]}
                    >
                      {CHESS_GLYPHS[piece.color][piece.type]}
                    </Text>
                  ) : null}
                  {target && !piece ? (
                    <View
                      style={{
                        position: 'absolute',
                        width: size * 0.26,
                        height: size * 0.26,
                        borderRadius: size,
                        backgroundColor: BOARD.ink,
                        borderWidth: 2,
                        borderColor: '#fff',
                      }}
                    />
                  ) : null}
                  {target && piece ? (
                    <View
                      style={{
                        position: 'absolute',
                        width: size * 0.92,
                        height: size * 0.92,
                        borderRadius: size,
                        borderWidth: 3,
                        borderColor: BOARD.ink,
                      }}
                    />
                  ) : null}
                  {col === 0 ? (
                    <Text allowFontScaling={false} style={{ position: 'absolute', top: 1, left: 2, color: BOARD.ink, fontSize: 9, fontWeight: '700' }}>
                      {Math.floor(sq / 8) + 1}
                    </Text>
                  ) : null}
                  {row === 7 ? (
                    <Text allowFontScaling={false} style={{ position: 'absolute', bottom: 1, right: 2, color: BOARD.ink, fontSize: 9, fontWeight: '700' }}>
                      {'abcdefgh'[sq % 8]}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      {promotion && mine ? (
        <View
          ref={promoRef}
          accessible={false}
          style={{ gap: space[2], padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.line, backgroundColor: c.surfaceSunken }}
        >
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {t('m.chat.game.chess.promote')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {CHESS_PROMOTIONS.map((p) => (
              <Pressable
                key={p}
                accessibilityRole="button"
                accessibilityLabel={t(`m.chat.game.chess.promo.${p}` as MessageKey)}
                onPress={() => {
                  const move = { ...promotion, promotion: p };
                  setPromotion(null);
                  setPicked(null);
                  onMove(move);
                }}
                style={({ pressed }) => ({
                  minHeight: 48,
                  minWidth: 64,
                  paddingHorizontal: space[3],
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.lineStrong,
                  backgroundColor: pressed ? c.yapiSoft : c.surface,
                })}
              >
                <Text allowFontScaling={false} style={{ color: c.ink, fontSize: 28 }}>
                  {CHESS_GLYPHS[mine][p]}
                </Text>
                <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{t(`m.chat.game.chess.promo.${p}` as MessageKey)}</Text>
              </Pressable>
            ))}
          </View>
          <Button label={t('m.chat.cancel')} size="sm" variant="ghost" onPress={() => setPromotion(null)} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : null}
      {canMove ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.chat.game.chess.helpTouch')}</Text> : null}
    </View>
  );
}

/** Pieces each player has taken, and the moves so far in standard notation ("1. e4 e5  2. Nf3"). */
export function ChessRecord({ state, names }: { state: ChessState; names: string[] }) {
  const { t } = useT();
  const c = useColors();
  const captured = chessCaptured(state);
  const pairs: string[] = [];
  for (let i = 0; i < state.san.length; i += 2) pairs.push(`${i / 2 + 1}. ${state.san.slice(i, i + 2).join(' ')}`);
  return (
    <View style={{ gap: 4 }}>
      {(['w', 'b'] as const).map((color) => {
        const other: ChessColor = color === 'w' ? 'b' : 'w';
        const taken = captured[other];
        if (!taken.length) return null;
        return (
          <View
            key={color}
            accessible
            accessibilityLabel={`${t('m.chat.game.chess.taken', { name: names[chessColorSeat(state, color)] ?? '' })}: ${taken.map((p) => chessPieceLabel(t, other, p)).join(', ')}`}
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}
          >
            <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
              {t('m.chat.game.chess.taken', { name: names[chessColorSeat(state, color)] ?? '' })}
            </Text>
            <Text allowFontScaling={false} style={{ color: c.ink, fontSize: 20, letterSpacing: 1 }}>
              {taken.map((p) => CHESS_GLYPHS[other][p]).join('')}
            </Text>
          </View>
        );
      })}
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 14, fontWeight: '700' }}>
        {t('m.chat.game.chess.moves')}
      </Text>
      <Text
        selectable
        style={{ color: pairs.length ? c.ink : c.inkMuted, fontSize: 14, lineHeight: 21, fontVariant: ['tabular-nums'], writingDirection: 'ltr' }}
      >
        {pairs.length ? pairs.join('   ') : t('m.chat.game.chess.noMoves')}
      </Text>
    </View>
  );
}

/** The position as a small picture for the game's card, from your side of the board. */
export function MiniChess({ state, seat }: { state: ChessState; seat: number }) {
  const flip = seat >= 0 && chessSeatColor(state, seat) === 'b';
  const board = chessBoard(state);
  return (
    <View style={{ borderWidth: 1, borderColor: BOARD.edge, direction: 'ltr' }}>
      {Array.from({ length: 8 }, (_, row) => (
        <View key={row} style={{ flexDirection: 'row' }}>
          {Array.from({ length: 8 }, (_, col) => {
            const sq = squareAt(row * 8 + col, flip);
            const piece = board[sq];
            return (
              <View
                key={col}
                style={{
                  width: 15,
                  height: 15,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: chessLightSquare(sq) ? BOARD.light : BOARD.dark,
                }}
              >
                {piece ? (
                  <Text allowFontScaling={false} style={{ color: BOARD.ink, fontSize: 12, lineHeight: 14 }}>
                    {CHESS_GLYPHS[piece.color][piece.type]}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
