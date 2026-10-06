import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Animated, Easing, Keyboard, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import {
  applyMove,
  CHESS_GLYPHS,
  chessColorSeat,
  chessLastMoveText,
  chessSeatColor,
  chessSideLabel,
  chessStatusText,
  checkRung,
  FOUR_UP_COLUMNS,
  FOUR_UP_ROWS,
  fourUpColumn,
  fourUpFree,
  GAME_ACTIVE_LIMIT,
  GAME_KIND_ACTIVE_LIMIT,
  GAME_KINDS,
  GAME_PLAYERS,
  gameStartBlock,
  ladderCurrent,
  type ChessState,
  type DrawAction,
  type FourUpState,
  type GameKind,
  type GameMove,
  type GameState,
  type NoughtsState,
  type WordLadderState,
} from '../../../packages/shared/src/games/index';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { ChatGame, Conversation, Message, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { ChessBoard, ChessRecord, MiniChess } from './chess-board';
import { useGame3D } from './game-view';
import { useT } from './i18n';
import { useReducedMotion } from './motion';
import { radius, space } from './theme';
import { BottomSheet, Button, Icon, useColors, userText } from './ui';

/**
 * Games in a chat (mobile): the card in the chat, the board in a sheet, and the sheet to start one
 * (the chess board itself is in chess-board.tsx).
 * Every column (Four up) and square (Noughts) is a button with a full label ("Column 4, 2 free
 * spaces"); what just happened is a live region, and is also announced on iOS. Moves are checked with
 * the same rules as the server, shown at once, and sent with the board's move number and an id, so
 * a double tap plays once.
 */

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const LADDER_ERRORS: string[] = ['not_four_letters', 'not_a_word', 'not_one_letter', 'word_used'];

export const gameName = (t: T, kind: GameKind) => t(`m.chat.game.kind.${kind}` as MessageKey);

const nameOf = (t: T, u: PublicUser | undefined, meId?: string) =>
  !u ? t('m.calls.someone') : u.id === meId ? t('m.chat.you') : u.displayName || t('m.calls.someone');

/** The players' names by seat, as you see them ("You" for yourself). */
const namesOf = (t: T, game: ChatGame, meId?: string) => game.players.map((p) => nameOf(t, p, meId));

/** "Your turn", "Ada to play", "Sam won", "A draw"… (chess once it's over: "Checkmate. Ada won.", "Draw: stalemate"). */
export function gameStatus(t: T, game: ChatGame, meId?: string): string {
  if (game.state.kind === 'chess' && game.status !== 'active')
    return chessStatusText(
      t,
      game.state,
      namesOf(t, game, meId),
      game.players.findIndex((p) => p.id === meId),
    );
  const winner = game.players.find((p) => p.id === game.winnerId);
  const forfeitWin = game.state.result?.type === 'win' && game.state.result.by === 'forfeit';
  if (game.status === 'won')
    return winner?.id === meId
      ? t(forfeitWin ? 'm.chat.game.youWonForfeit' : 'm.chat.game.youWon')
      : t(forfeitWin ? 'm.chat.game.wonForfeit' : 'm.chat.game.won', { name: nameOf(t, winner, meId) });
  if (game.status === 'draw') return t('m.chat.game.draw');
  if (game.status === 'unfinished') return t('m.chat.game.unfinished');
  if (game.turnId === meId) return t('m.chat.game.yourTurn');
  return t('m.chat.game.theirTurn', {
    name: nameOf(
      t,
      game.players.find((p) => p.id === game.turnId),
      meId,
    ),
  });
}

function lastMoveText(t: T, game: ChatGame, meId?: string): string {
  const s = game.state;
  const who = (seat: number | null | undefined) => nameOf(t, seat === null || seat === undefined ? undefined : game.players[seat], meId);
  if (s.kind === 'four_up' && s.last !== null) return t('m.chat.game.dropped', { name: who(s.cells[s.last]), n: (s.last % FOUR_UP_COLUMNS) + 1 });
  if (s.kind === 'noughts' && s.last !== null)
    return t('m.chat.game.took', { name: who(s.cells[s.last]), row: Math.floor(s.last / 3) + 1, col: (s.last % 3) + 1 });
  // Chess: whoever isn't to move now made the last move.
  if (s.kind === 'chess') return chessLastMoveText(t, s, who(chessColorSeat(s, s.side === 'w' ? 'b' : 'w')));
  if (s.kind === 'word_ladder') {
    if (s.lastPass !== null) return t('m.chat.game.passed', { name: who(s.lastPass) });
    const rung = s.rungs.at(-1);
    if (rung) return t('m.chat.game.added', { name: who(rung.seat), word: rung.word.toUpperCase() });
  }
  return '';
}

function tallyText(t: T, game: ChatGame, meId?: string) {
  if (!game.tally.some((x) => x.wins)) return null;
  return t('m.chat.game.tally', {
    tally: game.tally
      .map(
        (x) =>
          `${nameOf(
            t,
            game.players.find((p) => p.id === x.userId),
            meId,
          )} ${x.wins}`,
      )
      .join(', '),
  });
}

/** The game as it will be once the server takes this move: shown straight away, replaced by the server's copy. */
function afterMove(game: ChatGame, state: GameState): ChatGame {
  const r = state.result;
  return {
    ...game,
    state,
    moveNumber: game.moveNumber + 1,
    status: !r ? 'active' : r.type === 'win' ? 'won' : r.type === 'draw' ? 'draw' : 'unfinished',
    winnerId: r?.type === 'win' ? (game.players[r.winner]?.id ?? null) : null,
    turnId: r ? null : (game.players[state.turn]?.id ?? null),
  };
}

/** Announce a change to screen reader users (live regions cover Android; iOS needs this). */
function useAnnounce(text: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (Platform.OS === 'ios' && text) AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

// ─── The card in the chat ───────────────────────────────────────────────

export function GameCard({ message, meId, tint, onOpen: openBoard }: { message: Message; meId?: string; tint: string; onOpen: () => void }) {
  // The board needs the whole screen: the message keyboard goes away rather than covering it.
  const onOpen = () => {
    Keyboard.dismiss();
    openBoard();
  };
  const { t } = useT();
  const c = useColors();
  const game = message.game!;
  const playing = game.players.some((p) => p.id === meId);
  const yourTurn = game.status === 'active' && game.turnId === meId;
  const label = yourTurn ? t('m.chat.game.yourTurn') : playing || game.status !== 'active' ? t('m.chat.game.open') : t('m.chat.game.watch');
  const names = game.players.map((p) => nameOf(t, p, meId)).join(', ');
  return (
    <View style={{ gap: space[2], minWidth: 220 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="game-controller-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>{t('m.chat.game.label')}</Text>
      </View>
      <Text accessibilityRole="header" style={{ color: tint, fontSize: 16, fontWeight: '700' }}>
        {gameName(t, game.kind)}
      </Text>
      {/* The board picture sits on its own panel, so it reads the same in anyone's bubble colour.
          Tapping it opens the game too; screen readers use the button below. */}
      <Pressable
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        onPress={onOpen}
        // A word ladder's board is one line of text, 34pt tall; the touch area reaches 44.
        hitSlop={{ top: 5, bottom: 5 }}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          padding: space[2],
          borderRadius: radius.md,
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: c.line,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <MiniBoard game={game} meId={meId} />
      </Pressable>
      <Text style={[{ color: tint, fontSize: 12, opacity: 0.85 }, userText]}>{t('m.chat.game.playersList', { names })}</Text>
      <Text style={{ color: tint, fontSize: 14, fontWeight: '700' }}>{gameStatus(t, game, meId)}</Text>
      <Pressable
        accessibilityRole="button"
        // A chat can have several games of a kind going: the players tell them apart.
        accessibilityLabel={`${label}: ${gameName(t, game.kind)}, ${names}`}
        onPress={onOpen}
        style={{
          minHeight: 44,
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[1],
          paddingHorizontal: space[3],
          borderRadius: radius.full,
          borderWidth: yourTurn ? 2 : 1,
          borderColor: tint,
        }}
      >
        <Icon name="game-controller-outline" size={18} color={tint} />
        <Text style={{ color: tint, fontSize: 14, fontWeight: '800' }}>{label}</Text>
      </Pressable>
    </View>
  );
}

function MiniBoard({ game, meId }: { game: ChatGame; meId?: string }) {
  const c = useColors();
  const s = game.state;
  if (s.kind === 'chess') return <MiniChess state={s} seat={game.players.findIndex((p) => p.id === meId)} />;
  if (s.kind === 'word_ladder')
    return (
      <Text style={{ color: c.ink, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'], letterSpacing: 0.5, writingDirection: 'ltr' }}>
        {s.start.toUpperCase()} → {ladderCurrent(s) !== s.start ? `${ladderCurrent(s).toUpperCase()} → ` : ''}
        {s.target.toUpperCase()}
      </Text>
    );
  const cols = s.kind === 'four_up' ? FOUR_UP_COLUMNS : 3;
  const size = s.kind === 'four_up' ? 18 : 26;
  const rows = Math.ceil(s.cells.length / cols);
  return (
    <View style={{ gap: 3, direction: 'ltr' }}>
      {Array.from({ length: rows }, (_, r) => (
        <View key={r} style={{ flexDirection: 'row', gap: 3 }}>
          {Array.from({ length: cols }, (_, col) => {
            const v = s.cells[r * cols + col] ?? null;
            return s.kind === 'four_up' ? (
              <Disc key={col} seat={v} size={size} />
            ) : (
              <View
                key={col}
                style={{ width: size, height: size, borderRadius: 6, backgroundColor: c.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}
              >
                {v !== null ? (
                  <Text maxFontSizeMultiplier={1.3} style={{ color: v === 0 ? c.yapi : c.ink, fontWeight: '800', fontSize: 16 }}>
                    {v === 0 ? 'X' : 'O'}
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

/** A Four up disc: seat 0 in the brand colour, seat 1 in saffron with a ring, so they differ by more than colour. */
function Disc({ seat, size, mark }: { seat: number | null; size: number; mark?: 'line' | 'last' }) {
  const c = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: seat === null ? c.surface : seat === 0 ? c.yapi : c.saffron,
        borderWidth: seat === null ? 1 : seat === 1 ? 3 : 0,
        borderColor: seat === null ? c.lineStrong : c.ink,
        outlineColor: mark ? c.ink : undefined,
        outlineWidth: mark === 'line' ? 3 : mark === 'last' ? 2 : 0,
        outlineStyle: mark === 'last' ? 'dashed' : 'solid',
        outlineOffset: 1,
      }}
    />
  );
}

/** "3D view": a switch above the board, remembered on this phone. */
function View3DToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const { t } = useT();
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={t('m.chat.game.view3d')}
      onPress={() => onChange(!on)}
      style={({ pressed }) => ({
        alignSelf: 'flex-end',
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        paddingHorizontal: space[3],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: on ? c.yapi : c.line,
        backgroundColor: on ? c.yapiSoft : pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      <Icon name="cube-outline" size={18} color={on ? c.yapi : c.inkMuted} />
      <Text style={{ color: c.ink, fontSize: 14, fontWeight: '700' }}>{t('m.chat.game.view3d')}</Text>
      <Icon name={on ? 'toggle' : 'toggle-outline'} size={22} color={on ? c.yapi : c.inkMuted} />
    </Pressable>
  );
}

/**
 * The 3D view's tilt (perspective and a turn about the x axis, and y for Four up's rack). Only
 * transforms and shadows, so nothing runs per frame; the same buttons and labels as the flat board.
 */
const tilt = (x: number, y = 0, scale = 1) => ({
  transform: [{ perspective: 900 }, { rotateX: `${x}deg` }, ...(y ? [{ rotateY: `${y}deg` }] : []), ...(scale !== 1 ? [{ scale }] : [])],
});

/** A soft shadow under something raised (iOS shadow, Android elevation). */
const lifted = (depth: number) => ({
  shadowColor: '#000',
  shadowOpacity: 0.3,
  shadowRadius: depth,
  shadowOffset: { width: 0, height: depth / 2 },
  elevation: depth,
});

/** A disc in the 3D rack: a lighter spot and a darker lower rim give it volume; the newest one drops into place (`drop` rows). */
function Disc3D({ seat, size, mark, drop }: { seat: number | null; size: number; mark?: 'line' | 'last'; drop: number }) {
  const c = useColors();
  const reduce = useReducedMotion();
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!drop || reduce || seat === null) return;
    y.setValue(-drop * (size + 3));
    Animated.timing(y, { toValue: 0, duration: 360, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
  }, [reduce, seat, drop, size, y]);
  if (seat === null)
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.surface,
          borderWidth: 1,
          borderTopWidth: 4,
          borderColor: c.lineStrong,
        }}
      />
    );
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: seat === 0 ? c.yapi : c.saffron,
        borderWidth: seat === 1 ? 3 : 0,
        borderBottomWidth: seat === 1 ? 5 : 4,
        borderColor: seat === 1 ? c.ink : 'rgba(0,0,0,0.3)',
        outlineColor: mark ? c.ink : undefined,
        outlineWidth: mark === 'line' ? 3 : mark === 'last' ? 2 : 0,
        outlineStyle: mark === 'last' ? 'dashed' : 'solid',
        outlineOffset: 1,
        transform: [{ translateY: y }],
        ...lifted(4),
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: size * 0.12,
          left: size * 0.18,
          width: size * 0.3,
          height: size * 0.2,
          borderRadius: size,
          backgroundColor: 'rgba(255,255,255,0.4)',
        }}
      />
    </Animated.View>
  );
}

function FourUpBoard({
  game,
  state: s,
  meId,
  canMove,
  threeD,
  onColumn,
}: {
  game: ChatGame;
  state: FourUpState;
  meId?: string;
  canMove: boolean;
  threeD: boolean;
  onColumn: (column: number) => void;
}) {
  const { t, tp } = useT();
  const c = useColors();
  const line = s.result?.type === 'win' ? (s.result.line ?? []) : [];
  return (
    <View
      accessibilityLabel={t('m.chat.game.board', { game: gameName(t, 'four_up') })}
      style={[
        { alignSelf: 'center', flexDirection: 'row', gap: 2, padding: 4, borderRadius: radius.md, backgroundColor: c.surfaceSunken, direction: 'ltr' },
        // An upright rack seen a little from the side, with a thick edge.
        threeD ? { ...tilt(8, -10, 0.95), borderRightWidth: 6, borderBottomWidth: 6, borderColor: c.lineStrong, marginBottom: space[2], ...lifted(10) } : null,
      ]}
    >
      {Array.from({ length: FOUR_UP_COLUMNS }, (_, col) => {
        const free = fourUpFree(s.cells, col);
        const discs = fourUpColumn(s.cells, col);
        const label = [
          t('m.chat.game.column', { n: col + 1 }),
          free ? tp('m.chat.game.free', free) : t('m.chat.game.full'),
          discs.length ? t('m.chat.game.fromBottom', { discs: discs.map((d) => nameOf(t, game.players[d], meId)).join(', ') }) : '',
        ]
          .filter(Boolean)
          .join(', ');
        const disabled = !canMove || !free;
        return (
          <Pressable
            key={col}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            onPress={() => !disabled && onColumn(col)}
            style={({ pressed }) => ({
              minWidth: 44,
              alignItems: 'center',
              gap: 3,
              paddingVertical: 4,
              borderRadius: radius.sm,
              backgroundColor: pressed && !disabled ? c.yapiSoft : 'transparent',
            })}
          >
            {Array.from({ length: FOUR_UP_ROWS }, (_, r) => {
              const i = r * FOUR_UP_COLUMNS + col;
              const mark = line.includes(i) ? 'line' : s.last === i ? 'last' : undefined;
              return threeD ? (
                <Disc3D key={r} seat={s.cells[i] ?? null} size={34} mark={mark} drop={s.last === i ? r + 1 : 0} />
              ) : (
                <Disc key={r} seat={s.cells[i] ?? null} size={34} mark={mark} />
              );
            })}
          </Pressable>
        );
      })}
    </View>
  );
}

function NoughtsBoard({
  game,
  state: s,
  meId,
  canMove,
  threeD,
  onCell,
}: {
  game: ChatGame;
  state: NoughtsState;
  meId?: string;
  canMove: boolean;
  threeD: boolean;
  onCell: (cell: number) => void;
}) {
  const { t } = useT();
  const c = useColors();
  return (
    <View
      accessibilityLabel={t('m.chat.game.board', { game: gameName(t, 'noughts') })}
      style={[
        { alignSelf: 'center', gap: 4, direction: 'ltr' },
        // A board lying back, with a thick edge; the marks stand proud of it.
        threeD
          ? {
              ...tilt(26),
              padding: 6,
              borderRadius: radius.lg,
              backgroundColor: c.surfaceSunken,
              borderBottomWidth: 8,
              borderColor: c.lineStrong,
              ...lifted(10),
            }
          : null,
      ]}
    >
      {[0, 1, 2].map((r) => (
        <View key={r} style={{ flexDirection: 'row', gap: 4 }}>
          {[0, 1, 2].map((col) => {
            const i = r * 3 + col;
            const v = s.cells[i] ?? null;
            const inLine = s.result?.type === 'win' && (s.result.line ?? []).includes(i);
            const disabled = !canMove || v !== null;
            return (
              <Pressable
                key={col}
                accessibilityRole="button"
                accessibilityLabel={`${t('m.chat.game.square', { row: r + 1, col: col + 1 })}, ${v === null ? t('m.chat.game.empty') : `${v === 0 ? 'X' : 'O'}, ${nameOf(t, game.players[v], meId)}`}`}
                accessibilityState={{ disabled }}
                onPress={() => !disabled && onCell(i)}
                style={{
                  width: 76,
                  height: 76,
                  borderRadius: radius.md,
                  borderWidth: inLine ? 3 : 1,
                  borderBottomWidth: threeD ? 5 : inLine ? 3 : 1,
                  borderColor: inLine ? c.ink : c.lineStrong,
                  backgroundColor: inLine ? c.yapiSoft : c.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {/* The squares are a fixed size, so the mark grows with the text size only so far (the label says it anyway). */}
                {v !== null ? <Mark seat={v} threeD={threeD} fresh={s.last === i} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** An X or an O; in 3D a raised token with a darker side, lifting into place when it's new. */
function Mark({ seat, threeD, fresh }: { seat: number; threeD: boolean; fresh: boolean }) {
  const c = useColors();
  const reduce = useReducedMotion();
  const lift = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!threeD || !fresh || reduce) return;
    lift.setValue(0);
    Animated.timing(lift, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [threeD, fresh, reduce, lift]);
  const text = (
    <Text
      maxFontSizeMultiplier={1.3}
      style={[
        { color: seat === 0 ? c.yapi : c.ink, fontSize: 40, fontWeight: '800' },
        threeD ? { textShadowColor: 'rgba(0,0,0,0.45)', textShadowOffset: { width: 0, height: 4 }, textShadowRadius: 1 } : null,
      ]}
    >
      {seat === 0 ? 'X' : 'O'}
    </Text>
  );
  if (!threeD) return text;
  return (
    <Animated.View
      style={{
        opacity: lift,
        transform: [
          { translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [-24, -4] }) },
          { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1.3, 1] }) },
        ],
      }}
    >
      {text}
    </Animated.View>
  );
}

// ─── The board ──────────────────────────────────────────────────────────

export function GameSheet({
  game,
  meId,
  onClose,
  onGame,
  onRematch,
}: {
  game: ChatGame | null;
  meId?: string;
  onClose: () => void;
  onGame: (game: ChatGame) => void;
  onRematch: (message: Message) => void;
}) {
  const { t, tp, dateTime } = useT();
  const c = useColors();
  const [threeD, setThreeD] = useGame3D();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const last = game ? lastMoveText(t, game, meId) : '';
  const seatHere = game ? game.players.findIndex((p) => p.id === meId) : -1;
  const headline = !game
    ? ''
    : game.state.kind === 'chess'
      ? chessStatusText(t, game.state, namesOf(t, game, meId), seatHere, !!last)
      : gameStatus(t, game, meId);
  const status = game ? `${last ? `${last} ` : ''}${headline}` : '';
  useAnnounce(status);
  useEffect(() => setProblem(null), [game?.id, game?.moveNumber]);
  if (!game) return null;
  const seat = game.players.findIndex((p) => p.id === meId);
  const out = seat >= 0 && game.state.out.includes(seat);
  const active = game.status === 'active';
  const canMove = active && seat >= 0 && !out && game.turnId === meId && !busy;
  const s = game.state;

  async function play(move: GameMove) {
    if (!game || !canMove) return;
    const local = applyMove(game.state, seat, move);
    if (!local.ok) {
      if (LADDER_ERRORS.includes(local.error)) setProblem(t(`m.chat.game.err.${local.error}` as MessageKey));
      return;
    }
    const before = game;
    const id = newId();
    setBusy(true);
    setProblem(null);
    onGame(afterMove(game, local.state));
    try {
      const api = await client();
      const send = () => api.games.move(before.id, before.moveNumber, move, id);
      // A dropped connection is tried once more with the same id: it can't play twice.
      const r = await send().catch((e) => (e instanceof ApiError && e.status === 0 ? send() : Promise.reject(e)));
      onGame(r.game);
    } catch (e) {
      onGame(before);
      if (e instanceof ApiError && e.code === 'game_moved_on') {
        setProblem(t('m.chat.game.moved'));
        const fresh = await (await client()).games.get(before.id).catch(() => null);
        if (fresh) onGame(fresh.game);
      } else setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const tally = tallyText(t, game, meId);
  return (
    <BottomSheet visible onClose={onClose} title={gameName(t, game.kind)} maxHeight="92%">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {game.players.map((p, i) => (
          // One stop per player for screen readers: "X, Ada".
          <View
            key={p.id}
            accessible
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: space[2],
              paddingVertical: 4,
              borderRadius: radius.full,
              backgroundColor: game.turnId === p.id ? c.yapiSoft : 'transparent',
            }}
          >
            {s.kind === 'four_up' ? <Disc seat={i} size={16} /> : null}
            {s.kind === 'chess' ? (
              <Text allowFontScaling={false} importantForAccessibility="no" accessibilityElementsHidden style={{ color: c.ink, fontSize: 20 }}>
                {CHESS_GLYPHS[chessSeatColor(s, i)].k}
              </Text>
            ) : null}
            {s.kind === 'noughts' ? <Text style={{ color: i === 0 ? c.yapi : c.ink, fontWeight: '800', fontSize: 16 }}>{i === 0 ? 'X' : 'O'}</Text> : null}
            <Text style={[{ color: c.ink, fontSize: 14, fontWeight: game.turnId === p.id ? '800' : '500' }, userText]}>
              {s.out.includes(i) ? t('m.chat.game.out', { name: nameOf(t, p, meId) }) : nameOf(t, p, meId)}
            </Text>
            {s.kind === 'chess' ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{chessSideLabel(t, chessSeatColor(s, i))}</Text> : null}
          </View>
        ))}
      </View>
      <Text accessibilityLiveRegion="polite" style={[{ color: c.ink, fontSize: 15, lineHeight: 22 }, userText]}>
        {last ? `${last} ` : ''}
        <Text style={{ fontWeight: '800' }}>{headline}</Text>
      </Text>
      <View3DToggle on={threeD} onChange={setThreeD} />
      {s.kind === 'chess' ? (
        <>
          <ChessBoard state={s} moveNumber={game.moveNumber} seat={seat} canMove={canMove} threeD={threeD} onMove={(m) => void play(m)} />
          {active ? (
            <DrawOffer
              state={s}
              seat={out ? -1 : seat}
              names={namesOf(t, game, meId)}
              busy={busy}
              onAction={(action) => run(async () => onGame((await (await client()).games.draw(game.id, action)).game))}
            />
          ) : null}
          <ChessRecord state={s} names={namesOf(t, game, meId)} />
        </>
      ) : s.kind === 'four_up' ? (
        <FourUpBoard game={game} state={s} meId={meId} canMove={canMove} threeD={threeD} onColumn={(column) => void play({ column })} />
      ) : s.kind === 'noughts' ? (
        <NoughtsBoard game={game} state={s} meId={meId} canMove={canMove} threeD={threeD} onCell={(cell) => void play({ cell })} />
      ) : (
        <Ladder game={game} state={s} meId={meId} canMove={canMove} busy={busy} threeD={threeD} onMove={(m) => void play(m)} onProblem={setProblem} />
      )}
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 14, fontWeight: '700' }}>
          {problem}
        </Text>
      ) : null}
      {tally ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{tally}</Text> : null}
      {game.idleEndsAt ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.chat.game.idle', { time: dateTime(game.idleEndsAt) })}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space[2] }}>
        {active && seat >= 0 && !out ? (
          <Button
            label={t(s.kind === 'chess' ? 'm.chat.game.chess.resign' : 'm.chat.game.forfeit')}
            variant="ghost"
            disabled={busy}
            onPress={() =>
              Alert.alert(
                t(s.kind === 'chess' ? 'm.chat.game.chess.resign' : 'm.chat.game.forfeit'),
                t(s.kind === 'chess' ? 'm.chat.game.chess.resignConfirm' : 'm.chat.game.forfeitConfirm'),
                [
                  { text: t('m.chat.cancel'), style: 'cancel' },
                  {
                    text: t(s.kind === 'chess' ? 'm.chat.game.chess.resign' : 'm.chat.game.forfeit'),
                    style: 'destructive',
                    onPress: () => void run(async () => onGame((await (await client()).games.forfeit(game.id)).game)),
                  },
                ],
              )
            }
          />
        ) : null}
        {!active && seat >= 0 ? (
          <Button
            label={t('m.chat.game.rematch')}
            icon="refresh"
            disabled={busy}
            onPress={() => run(async () => onRematch((await (await client()).games.rematch(game.id)).message))}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}

/**
 * Chess draw offers: offer one (once per move of your own), or answer the other player's. People
 * watching see that an offer is waiting. An offer lapses after the offerer's next move.
 */
function DrawOffer({
  state: s,
  seat,
  names,
  busy,
  onAction,
}: {
  state: ChessState;
  seat: number;
  names: string[];
  busy: boolean;
  onAction: (action: DrawAction) => void;
}) {
  const { t } = useT();
  const c = useColors();
  const offer = s.drawOffer;
  if (offer && offer.seat === seat) return <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('m.chat.game.chess.youOffered')}</Text>;
  if (offer)
    return (
      <View style={{ gap: space[2] }}>
        <Text style={[{ color: c.ink, fontSize: 15, fontWeight: '700' }, userText]}>
          {t('m.chat.game.chess.theyOffered', { name: names[offer.seat] ?? '' })}
        </Text>
        {seat >= 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('m.chat.game.chess.accept')} size="sm" disabled={busy} onPress={() => onAction('accept')} />
            <Button label={t('m.chat.game.chess.decline')} size="sm" variant="secondary" disabled={busy} onPress={() => onAction('decline')} />
          </View>
        ) : null}
      </View>
    );
  if (seat < 0 || s.moves < (s.offeredAt[seat] ?? -2) + 2) return null;
  return (
    <Button
      label={t('m.chat.game.chess.offerDraw')}
      size="sm"
      variant="secondary"
      disabled={busy}
      onPress={() => onAction('offer')}
      style={{ alignSelf: 'flex-start' }}
    />
  );
}

/** A version 4 UUID for a move (the API asks for one). Math.random is enough: it only has to differ between one person's moves. */
const newId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

function Ladder({
  game,
  state: s,
  meId,
  canMove,
  busy,
  threeD,
  onMove,
  onProblem,
}: {
  game: ChatGame;
  state: WordLadderState;
  meId?: string;
  canMove: boolean;
  busy: boolean;
  /** Rungs as rows of raised letter tiles. */
  threeD: boolean;
  onMove: (move: GameMove) => void;
  onProblem: (text: string | null) => void;
}) {
  const { t, tp } = useT();
  const c = useColors();
  const [word, setWord] = useState('');
  const current = ladderCurrent(s);
  useEffect(() => setWord(''), [s.rungs.length, s.passes]);
  const submit = () => {
    const why = checkRung(s, word);
    if (why) return onProblem(t(`m.chat.game.err.${why}` as MessageKey));
    onProblem(null);
    onMove({ word });
  };
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space[3], direction: 'ltr' }}>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>
          {t('m.chat.game.ladder.from')} <Text style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>{s.start.toUpperCase()}</Text>
        </Text>
        <Text style={{ color: c.inkMuted }} importantForAccessibility="no" accessibilityElementsHidden>
          →
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>
          {t('m.chat.game.ladder.to')} <Text style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>{s.target.toUpperCase()}</Text>
        </Text>
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{tp('m.chat.game.ladder.best', s.best)}</Text>
      {threeD ? (
        // Stacked rungs of letter tiles; the letter each rung changed stands out. Each rung reads as its word.
        <View accessibilityLabel={t('m.chat.game.ladder.rungs')} style={{ gap: space[2] }}>
          {[{ word: s.start, seat: -1 }, ...s.rungs].map((r, i, all) => (
            <View
              key={i}
              accessible
              accessibilityLabel={r.seat >= 0 ? `${r.word.toUpperCase()}, ${nameOf(t, game.players[r.seat], meId)}` : r.word.toUpperCase()}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
            >
              <View style={{ flexDirection: 'row', gap: 4, direction: 'ltr', ...tilt(20) }}>
                {[...r.word.toUpperCase()].map((ch, k) => {
                  const changed = i > 0 && all[i - 1]!.word[k] !== r.word[k];
                  return (
                    <View
                      key={k}
                      style={{
                        width: 34,
                        height: 34,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 7,
                        borderWidth: 1,
                        borderBottomWidth: 5,
                        borderColor: changed ? c.yapi : c.lineStrong,
                        backgroundColor: changed ? c.yapiSoft : c.surface,
                        ...lifted(3),
                      }}
                    >
                      <Text allowFontScaling={false} style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
                        {ch}
                      </Text>
                    </View>
                  );
                })}
              </View>
              {r.seat >= 0 ? <Text style={[{ color: c.inkMuted, fontSize: 13, flexShrink: 1 }, userText]}>{nameOf(t, game.players[r.seat], meId)}</Text> : null}
            </View>
          ))}
        </View>
      ) : (
        <View accessibilityLabel={t('m.chat.game.ladder.rungs')} style={{ gap: 4 }}>
          <Text style={{ color: c.ink, fontSize: 16, fontWeight: '800', letterSpacing: 1 }}>{s.start.toUpperCase()}</Text>
          {s.rungs.map((r, i) => (
            <Text key={i} style={{ color: c.ink, fontSize: 16 }}>
              <Text style={{ fontWeight: '800', letterSpacing: 1 }}>{r.word.toUpperCase()}</Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}> {nameOf(t, game.players[r.seat], meId)}</Text>
            </Text>
          ))}
        </View>
      )}
      {canMove || busy ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <TextInput
              autoFocus
              accessibilityLabel={t('m.chat.game.ladder.next')}
              accessibilityHint={`${t('m.chat.game.ladder.hint', { word: current.toUpperCase() })} ${t('m.chat.game.ladder.passNote')}`}
              placeholder={t('m.chat.game.ladder.hint', { word: current.toUpperCase() })}
              placeholderTextColor={c.inkMuted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={4}
              value={word}
              onChangeText={(v) => {
                setWord(v);
                onProblem(null);
              }}
              onSubmitEditing={submit}
              returnKeyType="done"
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                color: c.ink,
                paddingHorizontal: space[3],
                fontSize: 16,
              }}
            />
            <Button label={t('m.chat.game.ladder.add')} size="sm" disabled={!word.trim() || busy} onPress={submit} />
          </View>
          <Button
            label={t('m.chat.game.ladder.pass')}
            size="sm"
            variant="ghost"
            disabled={busy}
            onPress={() => onMove({ pass: true })}
            style={{ alignSelf: 'flex-start' }}
          />
        </>
      ) : null}
    </View>
  );
}

// ─── Starting a game ────────────────────────────────────────────────────

export function StartGameSheet({
  open,
  onClose,
  conversation,
  meId,
  onSent,
  onOpenGame,
}: {
  open: boolean;
  onClose: () => void;
  conversation: Conversation | null;
  meId?: string;
  onSent: (m: Message) => void;
  /** Open the board of a game already going here. */
  onOpenGame?: (game: ChatGame) => void;
}) {
  const { t, tp } = useT();
  const c = useColors();
  const [kind, setKind] = useState<GameKind>('four_up');
  const [going, setGoing] = useState<ChatGame[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [color, setColor] = useState<'white' | 'black' | 'random'>('white');
  const [error, setError] = useState<string | null>(null);
  // What to do once this sheet has gone (opening the board): iOS can't show one sheet while another is still closing.
  const after = useRef<(() => void) | null>(null);
  const closeThen = (fn: () => void) => {
    if (Platform.OS === 'ios') after.current = fn;
    onClose();
    if (Platform.OS !== 'ios') fn();
  };
  const cid = conversation?.id;
  useEffect(() => {
    if (!open || !cid) return;
    setChosen([]);
    setError(null);
    void client()
      .then((api) => api.conversations.games(cid))
      .then(
        (r) => {
          const kinds = r.items.map((g) => g.kind);
          setGoing(r.items);
          // Start on a game that can still start here.
          setKind((k) => (gameStartBlock(kinds, k) ? (GAME_KINDS.find((x) => !gameStartBlock(kinds, x)) ?? k) : k));
        },
        () => setGoing([]),
      );
  }, [open, cid]);
  if (!conversation) return null;
  const group = conversation.kind === 'group';
  const others = conversation.members.filter((m) => m.id !== meId);
  const max = GAME_PLAYERS[kind].max - 1;
  const single = max === 1;
  const kinds = going.map((g) => g.kind);
  const full = kinds.length >= GAME_ACTIVE_LIMIT;
  const ready = !gameStartBlock(kinds, kind) && (!group || (chosen.length >= 1 && chosen.length <= max));

  async function submit() {
    if (!ready || !cid) return;
    setError(null);
    try {
      const api = await client();
      const { message } = await api.conversations.startGame(cid, {
        kind,
        playerIds: group ? chosen : [],
        ...(kind === 'chess' ? { color } : {}),
        clientId: newId(),
      });
      closeThen(() => onSent(message));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <BottomSheet
      visible={open}
      onClose={onClose}
      onDismiss={() => {
        const fn = after.current;
        after.current = null;
        fn?.();
      }}
      title={t('m.chat.game.start')}
    >
      {going.length ? (
        // The games going here, each with who plays and whose turn it is, and a way straight to its board.
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {t('m.chat.game.goingHere')}
          </Text>
          <View style={{ gap: space[2] }}>
            {going.map((g) => {
              const names = g.players.map((p) => nameOf(t, p, meId)).join(', ');
              return (
                <View
                  key={g.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[2],
                    padding: space[3],
                    minHeight: 44,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: c.line,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{gameName(t, g.kind)}</Text>
                    <Text style={[{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }, userText]}>{names}</Text>
                    <Text
                      style={{ color: g.turnId === meId ? c.ink : c.inkMuted, fontSize: 13, lineHeight: 18, fontWeight: g.turnId === meId ? '700' : '400' }}
                    >
                      {gameStatus(t, g, meId)}
                    </Text>
                  </View>
                  {onOpenGame ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${t('m.chat.game.open')}: ${gameName(t, g.kind)}, ${names}`}
                      onPress={() => closeThen(() => onOpenGame(g))}
                      style={({ pressed }) => ({
                        minHeight: 44,
                        justifyContent: 'center',
                        paddingHorizontal: space[3],
                        borderRadius: radius.full,
                        borderWidth: 1,
                        borderColor: c.lineStrong,
                        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
                      })}
                    >
                      <Text style={{ color: c.ink, fontSize: 14, fontWeight: '700' }}>{t('m.chat.game.open')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        </>
      ) : null}
      {full ? (
        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('m.chat.game.allFull', { count: GAME_ACTIVE_LIMIT })}</Text>
      ) : (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {going.length ? t('m.chat.game.startNew') : t('m.chat.game.choose')}
          </Text>
          <View accessibilityRole="radiogroup" style={{ gap: space[2] }}>
            {GAME_KINDS.map((k) => {
              const blocked = !!gameStartBlock(kinds, k);
              const here = kinds.filter((x) => x === k).length;
              const on = kind === k;
              const about = blocked
                ? t('m.chat.game.kindFull', { count: GAME_KIND_ACTIVE_LIMIT, game: gameName(t, k) })
                : t(`m.chat.game.about.${k}` as MessageKey);
              const count = here && !blocked ? tp('m.chat.game.nGoing', here) : '';
              return (
                <Pressable
                  key={k}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, disabled: blocked }}
                  accessibilityLabel={[gameName(t, k), about, count].filter(Boolean).join('. ')}
                  disabled={blocked}
                  onPress={() => {
                    setKind(k);
                    setChosen((cur) => (GAME_PLAYERS[k].max === 2 ? cur.slice(0, 1) : cur));
                  }}
                  style={{
                    flexDirection: 'row',
                    gap: space[2],
                    padding: space[3],
                    minHeight: 44,
                    borderRadius: radius.md,
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? c.yapi : c.line,
                    backgroundColor: on ? c.yapiSoft : 'transparent',
                    opacity: blocked ? 0.6 : 1,
                  }}
                >
                  <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? c.yapi : c.inkMuted} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{gameName(t, k)}</Text>
                    <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{about}</Text>
                    {count ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{count}</Text> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
      {kind === 'chess' && !full ? (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {t('m.chat.game.chess.colour')}
          </Text>
          <View accessibilityRole="radiogroup" style={{ gap: 2 }}>
            {(['white', 'black', 'random'] as const).map((k) => {
              const on = color === k;
              const label = t(k === 'white' ? 'm.chat.game.chess.asWhite' : k === 'black' ? 'm.chat.game.chess.asBlack' : 'm.chat.game.chess.asRandom');
              return (
                <Pressable
                  key={k}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={label}
                  onPress={() => setColor(k)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
                >
                  <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
                  {k !== 'random' ? (
                    <Text allowFontScaling={false} style={{ color: c.ink, fontSize: 20 }}>
                      {CHESS_GLYPHS[k === 'white' ? 'w' : 'b'].k}
                    </Text>
                  ) : null}
                  <Text style={{ color: c.ink, fontSize: 15 }}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
      {group && !full ? (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {t('m.chat.game.players')}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{single ? t('m.chat.game.pickOne') : t('m.chat.game.pickUpTo', { count: max })}</Text>
          <View accessibilityRole={single ? 'radiogroup' : undefined} style={{ gap: 2 }}>
            {others.map((p) => {
              const on = chosen.includes(p.id);
              const disabled = !single && !on && chosen.length >= max;
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole={single ? 'radio' : 'checkbox'}
                  accessibilityState={{ checked: on, disabled }}
                  accessibilityLabel={p.displayName}
                  disabled={disabled}
                  onPress={() => setChosen((cur) => (single ? [p.id] : on ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44, opacity: disabled ? 0.5 : 1 }}
                >
                  <Icon
                    name={single ? (on ? 'radio-button-on' : 'radio-button-off') : on ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={on ? c.yapi : c.inkMuted}
                  />
                  <Text style={[{ color: c.ink, fontSize: 15 }, userText]}>{p.displayName}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 14, fontWeight: '700' }}>
          {error}
        </Text>
      ) : null}
      {full ? null : <Button label={t('m.chat.game.startButton')} icon="game-controller-outline" disabled={!ready} onPress={submit} />}
    </BottomSheet>
  );
}
