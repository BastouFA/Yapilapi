import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Platform, Pressable, Text, TextInput, View } from 'react-native';
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
  GAME_KINDS,
  GAME_PLAYERS,
  ladderCurrent,
  type ChessState,
  type DrawAction,
  type GameKind,
  type GameMove,
  type GameState,
  type WordLadderState,
} from '../../../packages/shared/src/games/index';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { ChatGame, Conversation, Message, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { ChessBoard, ChessRecord, MiniChess } from './chess-board';
import { useT } from './i18n';
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

export function GameCard({ message, meId, tint, onOpen }: { message: Message; meId?: string; tint: string; onOpen: () => void }) {
  const { t } = useT();
  const c = useColors();
  const game = message.game!;
  const playing = game.players.some((p) => p.id === meId);
  const yourTurn = game.status === 'active' && game.turnId === meId;
  const label = yourTurn ? t('m.chat.game.yourTurn') : playing || game.status !== 'active' ? t('m.chat.game.open') : t('m.chat.game.watch');
  return (
    <View style={{ gap: space[2], minWidth: 220 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="game-controller-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>{t('m.chat.game.label')}</Text>
      </View>
      <Text accessibilityRole="header" style={{ color: tint, fontSize: 16, fontWeight: '700' }}>
        {gameName(t, game.kind)}
      </Text>
      {/* The board picture sits on its own panel, so it reads the same in anyone's bubble colour. */}
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{ alignSelf: 'flex-start', padding: space[2], borderRadius: radius.md, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}
      >
        <MiniBoard game={game} meId={meId} />
      </View>
      <Text style={[{ color: tint, fontSize: 12, opacity: 0.85 }, userText]}>
        {t('m.chat.game.playersList', { names: game.players.map((p) => nameOf(t, p, meId)).join(', ') })}
      </Text>
      <Text style={{ color: tint, fontSize: 14, fontWeight: '700' }}>{gameStatus(t, game, meId)}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${gameName(t, game.kind)}`}
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
                {v !== null ? <Text style={{ color: v === 0 ? c.yapi : c.ink, fontWeight: '800', fontSize: 16 }}>{v === 0 ? 'X' : 'O'}</Text> : null}
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
          <View
            key={p.id}
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
      {s.kind === 'chess' ? (
        <>
          <ChessBoard state={s} moveNumber={game.moveNumber} seat={seat} canMove={canMove} onMove={(m) => void play(m)} />
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
        <View
          accessibilityLabel={t('m.chat.game.board', { game: gameName(t, 'four_up') })}
          style={{ alignSelf: 'center', flexDirection: 'row', gap: 2, padding: 4, borderRadius: radius.md, backgroundColor: c.surfaceSunken, direction: 'ltr' }}
        >
          {Array.from({ length: FOUR_UP_COLUMNS }, (_, col) => {
            const free = fourUpFree(s.cells, col);
            const discs = fourUpColumn(s.cells, col);
            const line = s.result?.type === 'win' ? (s.result.line ?? []) : [];
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
                onPress={() => !disabled && void play({ column: col })}
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
                  return <Disc key={r} seat={s.cells[i] ?? null} size={34} mark={line.includes(i) ? 'line' : s.last === i ? 'last' : undefined} />;
                })}
              </Pressable>
            );
          })}
        </View>
      ) : s.kind === 'noughts' ? (
        <View accessibilityLabel={t('m.chat.game.board', { game: gameName(t, 'noughts') })} style={{ alignSelf: 'center', gap: 4, direction: 'ltr' }}>
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
                    onPress={() => !disabled && void play({ cell: i })}
                    style={{
                      width: 76,
                      height: 76,
                      borderRadius: radius.md,
                      borderWidth: inLine ? 3 : 1,
                      borderColor: inLine ? c.ink : c.lineStrong,
                      backgroundColor: inLine ? c.yapiSoft : c.surface,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {v !== null ? <Text style={{ color: v === 0 ? c.yapi : c.ink, fontSize: 40, fontWeight: '800' }}>{v === 0 ? 'X' : 'O'}</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ) : (
        <Ladder game={game} state={s} meId={meId} canMove={canMove} busy={busy} onMove={(m) => void play(m)} onProblem={setProblem} />
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
  onMove,
  onProblem,
}: {
  game: ChatGame;
  state: WordLadderState;
  meId?: string;
  canMove: boolean;
  busy: boolean;
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
      <View accessibilityLabel={t('m.chat.game.ladder.rungs')} style={{ gap: 4 }}>
        <Text style={{ color: c.ink, fontSize: 16, fontWeight: '800', letterSpacing: 1 }}>{s.start.toUpperCase()}</Text>
        {s.rungs.map((r, i) => (
          <Text key={i} style={{ color: c.ink, fontSize: 16 }}>
            <Text style={{ fontWeight: '800', letterSpacing: 1 }}>{r.word.toUpperCase()}</Text>
            <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}> {nameOf(t, game.players[r.seat], meId)}</Text>
          </Text>
        ))}
      </View>
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
}: {
  open: boolean;
  onClose: () => void;
  conversation: Conversation | null;
  meId?: string;
  onSent: (m: Message) => void;
}) {
  const { t } = useT();
  const c = useColors();
  const [kind, setKind] = useState<GameKind>('four_up');
  const [going, setGoing] = useState<GameKind[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [color, setColor] = useState<'white' | 'black' | 'random'>('white');
  const [error, setError] = useState<string | null>(null);
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
          setGoing(kinds);
          setKind((k) => (kinds.includes(k) ? (GAME_KINDS.find((x) => !kinds.includes(x)) ?? k) : k));
        },
        () => setGoing([]),
      );
  }, [open, cid]);
  if (!conversation) return null;
  const group = conversation.kind === 'group';
  const others = conversation.members.filter((m) => m.id !== meId);
  const max = GAME_PLAYERS[kind].max - 1;
  const single = max === 1;
  const ready = !going.includes(kind) && (!group || (chosen.length >= 1 && chosen.length <= max));

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
      onSent(message);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <BottomSheet visible={open} onClose={onClose} title={t('m.chat.game.start')}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
        {t('m.chat.game.choose')}
      </Text>
      <View accessibilityRole="radiogroup" style={{ gap: space[2] }}>
        {GAME_KINDS.map((k) => {
          const busyHere = going.includes(k);
          const on = kind === k;
          return (
            <Pressable
              key={k}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: busyHere }}
              accessibilityLabel={`${gameName(t, k)}. ${busyHere ? t('m.chat.game.going', { game: gameName(t, k) }) : t(`m.chat.game.about.${k}` as MessageKey)}`}
              disabled={busyHere}
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
                opacity: busyHere ? 0.6 : 1,
              }}
            >
              <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? c.yapi : c.inkMuted} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{gameName(t, k)}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
                  {busyHere ? t('m.chat.game.going', { game: gameName(t, k) }) : t(`m.chat.game.about.${k}` as MessageKey)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {kind === 'chess' ? (
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
      {group ? (
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
      <Button label={t('m.chat.game.startButton')} icon="game-controller-outline" disabled={!ready} onPress={submit} />
    </BottomSheet>
  );
}
