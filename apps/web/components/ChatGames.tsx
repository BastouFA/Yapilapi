'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { BottomSheet, Button, Icon } from '@yapilapi/design-system';
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
  type ChatGame,
  type ChessState,
  type Conversation,
  type DrawAction,
  type GameKind,
  type GameMove,
  type GameState,
  type Message,
  type MessageKey,
  type PublicUser,
  type WordLadderState,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useGame3D } from '@/lib/game-view';
import { ChessBoard, ChessRecord, MiniChess } from './ChessBoard';

/**
 * Games in a chat (web): the card in the message list, the board in a sheet, and the sheet to start
 * one. Boards are grids you can move around with the arrow keys (Four up: one button per column,
 * "Column 4, 2 free spaces"; Noughts: one per square; Chess: see ChessBoard.tsx). What just happened is read out from a polite
 * live region, so moves from other people are announced without moving focus. Moves are checked
 * here with the same rules the server uses, shown at once, and sent with the board's move number
 * and an id for the move, so a double click plays once.
 */

type T = ReturnType<typeof useSession>['t'];

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

/** What the last move was, for the live region: "Ada played column 4." */
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

/** "Wins here: Ada 3, Sam 2" (nothing until someone has won). */
function tallyText(t: T, game: ChatGame, meId?: string) {
  if (!game.tally.some((x) => x.wins)) return null;
  const parts = game.tally.map(
    (x) =>
      `${nameOf(
        t,
        game.players.find((p) => p.id === x.userId),
        meId,
      )} ${x.wins}`,
  );
  return t('m.chat.game.tally', { tally: parts.join(', ') });
}

/** The game as it will be once the server takes this move: shown straight away, replaced by the server's copy. */
export function afterMove(game: ChatGame, state: GameState): ChatGame {
  const r = state.result;
  const winnerId = r?.type === 'win' ? (game.players[r.winner]?.id ?? null) : null;
  return {
    ...game,
    state,
    moveNumber: game.moveNumber + 1,
    status: !r ? 'active' : r.type === 'win' ? 'won' : r.type === 'draw' ? 'draw' : 'unfinished',
    winnerId,
    turnId: r ? null : (game.players[state.turn]?.id ?? null),
  };
}

// ─── The card in the chat ───────────────────────────────────────────────

export function GameCard({ message, meId, mine, onOpen }: { message: Message; meId?: string; mine: boolean; onOpen: () => void }) {
  const { t } = useSession();
  const game = message.game!;
  const playing = game.players.some((p) => p.id === meId);
  const yourTurn = game.status === 'active' && game.turnId === meId;
  const button = yourTurn ? t('m.chat.game.yourTurn') : playing || game.status !== 'active' ? t('m.chat.game.open') : t('m.chat.game.watch');
  const names = game.players.map((p) => nameOf(t, p, meId)).join(', ');
  return (
    <div className={`chat-game${mine ? ' chat-game--mine' : ''}`}>
      <span className="chat-poll__label">
        <Icon name="game" size={14} /> {t('m.chat.game.label')}
      </span>
      <strong className="chat-game__name">{gameName(t, game.kind)}</strong>
      <div className="chat-game__preview" aria-hidden>
        <MiniBoard game={game} meId={meId} />
      </div>
      <p className="chat-poll__status">{t('m.chat.game.playersList', { names })}</p>
      <p className="chat-game__status">{gameStatus(t, game, meId)}</p>
      {/* A chat can have several games of a kind going: the players tell them apart. */}
      <Button size="sm" variant={yourTurn ? 'primary' : 'secondary'} icon="game" onClick={onOpen} aria-label={`${button}: ${gameName(t, game.kind)}, ${names}`}>
        {button}
      </Button>
    </div>
  );
}

/** A small picture of the board for the card (the text next to it says what's going on). */
function MiniBoard({ game, meId }: { game: ChatGame; meId?: string }) {
  const s = game.state;
  if (s.kind === 'chess') return <MiniChess state={s} seat={game.players.findIndex((p) => p.id === meId)} />;
  if (s.kind === 'word_ladder')
    return (
      <span className="chat-game__ladder-mini" dir="ltr">
        {s.start.toUpperCase()} → {ladderCurrent(s) !== s.start ? `${ladderCurrent(s).toUpperCase()} → ` : ''}
        {s.target.toUpperCase()}
      </span>
    );
  const cols = s.kind === 'four_up' ? FOUR_UP_COLUMNS : 3;
  const line = s.result?.type === 'win' ? (s.result.line ?? []) : [];
  return (
    <span className={`chat-game__mini chat-game__mini--${s.kind}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }} dir="ltr">
      {s.cells.map((c, i) => (
        <span
          key={i}
          className={`game-piece game-piece--${s.kind} ${c === null ? 'game-piece--empty' : `game-piece--p${c}`}${line.includes(i) ? ' game-piece--line' : ''}`}
        >
          {s.kind === 'noughts' && c !== null ? (c === 0 ? 'X' : 'O') : null}
        </span>
      ))}
    </span>
  );
}

// ─── The board ──────────────────────────────────────────────────────────

/**
 * The board in a sheet: status, the grid, and forfeit or rematch. `game` is kept current by the
 * chat page from live updates; `onGame` takes a newer copy (your own moves, at once).
 */
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
  const { t, locale, toast } = useSession();
  const [threeD, setThreeD] = useGame3D();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const statusId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => setProblem(null), [game?.id, game?.moveNumber]);
  // Forfeit and Rematch go away once used (the game ends, or the new one starts here): when the
  // button that had focus is gone, focus goes to the line saying what happened.
  useEffect(() => {
    const el = statusRef.current;
    if (!el) return;
    const f = document.activeElement;
    if (!f || f === document.body || !el.closest('[role="dialog"]')?.contains(f)) el.focus({ preventScroll: true });
  }, [game?.id, game?.status]);
  if (!game) return null;
  const seat = game.players.findIndex((p) => p.id === meId);
  const out = seat >= 0 && game.state.out.includes(seat);
  const active = game.status === 'active';
  const canMove = active && seat >= 0 && !out && game.turnId === meId && !busy;

  /** Play a move: shown at once, sent with the board's move number; a retry after a dropped connection reuses its id. */
  async function play(move: GameMove) {
    if (!game || !canMove) return;
    const local = applyMove(game.state, seat, move);
    if (!local.ok) {
      // Word ladder says what's wrong with the word; board moves that can't be played are disabled already.
      if (LADDER_ERRORS.includes(local.error)) setProblem(t(`m.chat.game.err.${local.error}` as MessageKey));
      return;
    }
    const before = game;
    const clientMoveId = crypto.randomUUID();
    setBusy(true);
    setProblem(null);
    onGame(afterMove(game, local.state));
    const send = () => api.games.move(before.id, before.moveNumber, move, clientMoveId);
    try {
      const r = await send().catch((e) => (e instanceof ApiError && e.status === 0 ? send() : Promise.reject(e)));
      onGame(r.game);
    } catch (e) {
      onGame(before);
      if (e instanceof ApiError && e.code === 'game_moved_on') {
        toast(t('m.chat.game.moved'));
        const fresh = await api.games.get(before.id).catch(() => null);
        if (fresh) onGame(fresh.game);
      } else toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const s = game.state;
  const tally = tallyText(t, game, meId);
  const last = lastMoveText(t, game, meId);
  const idle = game.idleEndsAt
    ? t('m.chat.game.idle', {
        time: new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(game.idleEndsAt)),
      })
    : null;

  return (
    <BottomSheet open onClose={onClose} title={gameName(t, game.kind)}>
      <div className="stack chat-game-sheet" style={{ gap: 12 }}>
        <ul className="chat-game__players">
          {game.players.map((p, i) => (
            <li key={p.id} className={game.turnId === p.id ? 'chat-game__player--turn' : undefined}>
              {s.kind === 'chess' ? (
                <span className={`chess-piece chess-piece--${chessSeatColor(s, i)} chess-legend`} aria-hidden>
                  {CHESS_GLYPHS[chessSeatColor(s, i)].k}
                </span>
              ) : s.kind !== 'word_ladder' ? (
                <span className={`game-piece game-piece--${s.kind} game-piece--p${i} game-piece--legend`} aria-hidden>
                  {s.kind === 'noughts' ? (i === 0 ? 'X' : 'O') : null}
                </span>
              ) : null}
              <bdi>{s.out.includes(i) ? t('m.chat.game.out', { name: nameOf(t, p, meId) }) : nameOf(t, p, meId)}</bdi>
              {s.kind === 'noughts' ? <span className="yp-visually-hidden"> ({i === 0 ? 'X' : 'O'})</span> : null}
              {s.kind === 'chess' ? <span className="chat-poll__status">{chessSideLabel(t, chessSeatColor(s, i))}</span> : null}
            </li>
          ))}
        </ul>
        {/* Read out when anyone moves or the game ends. */}
        <p className="chat-game__live" id={statusId} role="status" ref={statusRef} tabIndex={-1}>
          {last ? `${last} ` : ''}
          <strong>{s.kind === 'chess' ? chessStatusText(t, s, namesOf(t, game, meId), seat, !!last) : gameStatus(t, game, meId)}</strong>
        </p>
        <div className="row game-view__bar">
          <Button size="sm" variant="secondary" icon="game" aria-pressed={threeD} onClick={() => setThreeD(!threeD)}>
            {t('m.chat.game.view3d')}
          </Button>
        </div>
        {s.kind === 'chess' ? (
          <>
            <div className={`game-view${threeD ? ' game-view--3d' : ''}`}>
              <ChessBoard state={s} moveNumber={game.moveNumber} seat={seat} canMove={canMove} describedBy={statusId} onMove={(m) => void play(m)} />
            </div>
            {active ? (
              <DrawOffer
                state={s}
                seat={out ? -1 : seat}
                names={namesOf(t, game, meId)}
                busy={busy}
                onAction={(action) => void run(async () => onGame((await api.games.draw(game.id, action)).game))}
              />
            ) : null}
            <ChessRecord state={s} names={namesOf(t, game, meId)} />
          </>
        ) : s.kind === 'four_up' ? (
          <div className={`game-view${threeD ? ' game-view--3d' : ''}`}>
            <FourUpBoard game={game} meId={meId} canMove={canMove} describedBy={statusId} onColumn={(column) => void play({ column })} />
          </div>
        ) : s.kind === 'noughts' ? (
          <div className={`game-view${threeD ? ' game-view--3d' : ''}`}>
            <NoughtsBoard game={game} meId={meId} canMove={canMove} describedBy={statusId} onCell={(cell) => void play({ cell })} />
          </div>
        ) : (
          <LadderBoard game={game} state={s} meId={meId} canMove={canMove} busy={busy} problem={problem} threeD={threeD} onMove={(m) => void play(m)} />
        )}
        {problem && s.kind !== 'word_ladder' ? (
          <p className="yp-field__error" role="alert">
            {problem}
          </p>
        ) : null}
        {tally ? <p className="chat-poll__status">{tally}</p> : null}
        {idle ? <p className="chat-poll__status">{idle}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {active && seat >= 0 && !out ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm(t(s.kind === 'chess' ? 'm.chat.game.chess.resignConfirm' : 'm.chat.game.forfeitConfirm')))
                  void run(async () => onGame((await api.games.forfeit(game.id)).game));
              }}
            >
              {t(s.kind === 'chess' ? 'm.chat.game.chess.resign' : 'm.chat.game.forfeit')}
            </Button>
          ) : null}
          {!active && seat >= 0 ? (
            <Button icon="repost" loading={busy} onClick={() => void run(async () => onRematch((await api.games.rematch(game.id)).message))}>
              {t('m.chat.game.rematch')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('m.common.close')}
          </Button>
        </div>
      </div>
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
  const { t } = useSession();
  const offer = s.drawOffer;
  if (offer && offer.seat === seat) return <p className="chat-poll__status">{t('m.chat.game.chess.youOffered')}</p>;
  if (offer)
    return (
      <div className="row chess-draw" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <p className="chess-draw__text">
          <bdi>{t('m.chat.game.chess.theyOffered', { name: names[offer.seat] ?? '' })}</bdi>
        </p>
        {seat >= 0 ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => onAction('accept')}>
              {t('m.chat.game.chess.accept')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('decline')}>
              {t('m.chat.game.chess.decline')}
            </Button>
          </>
        ) : null}
      </div>
    );
  if (seat < 0 || s.moves < (s.offeredAt[seat] ?? -2) + 2) return null;
  return (
    <div className="row" style={{ justifyContent: 'flex-start' }}>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('offer')}>
        {t('m.chat.game.chess.offerDraw')}
      </Button>
    </div>
  );
}

/** Arrow keys (and Home/End) move between buttons in a grid; `cols` per row. */
function useGridKeys(count: number, cols: number) {
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    let next = i;
    if (e.key in moves) next = i + moves[e.key]!;
    else if (e.key === 'Home') next = i - (i % cols);
    else if (e.key === 'End') next = i - (i % cols) + cols - 1;
    else return;
    e.preventDefault();
    if (next < 0 || next >= count || (Math.abs(moves[e.key] ?? 0) === 1 && Math.floor(next / cols) !== Math.floor(i / cols))) return;
    setFocus(next);
    refs.current[next]?.focus();
  };
  return { focus, setFocus, refs, onKeyDown };
}

function FourUpBoard({
  game,
  meId,
  canMove,
  describedBy,
  onColumn,
}: {
  game: ChatGame;
  meId?: string;
  canMove: boolean;
  describedBy: string;
  onColumn: (column: number) => void;
}) {
  const { t, tp } = useSession();
  const s = game.state as Extract<ChatGame['state'], { kind: 'four_up' }>;
  const grid = useGridKeys(FOUR_UP_COLUMNS, FOUR_UP_COLUMNS);
  const line = s.result?.type === 'win' ? (s.result.line ?? []) : [];
  const who = (seat: number) => nameOf(t, game.players[seat], meId);
  return (
    // Columns stay numbered 1 to 7 from the left in every language.
    <div
      role="grid"
      aria-label={t('m.chat.game.board', { game: gameName(t, 'four_up') })}
      aria-describedby={describedBy}
      className="game-board game-board--four_up"
      dir="ltr"
    >
      <div role="row" className="game-board__row">
        {Array.from({ length: FOUR_UP_COLUMNS }, (_, c) => {
          const free = fourUpFree(s.cells, c);
          const discs = fourUpColumn(s.cells, c);
          const label = [
            t('m.chat.game.column', { n: c + 1 }),
            free ? tp('m.chat.game.free', free) : t('m.chat.game.full'),
            discs.length ? t('m.chat.game.fromBottom', { discs: discs.map(who).join(', ') }) : '',
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <div role="gridcell" key={c} className="game-board__cell">
              <button
                ref={(el) => void (grid.refs.current[c] = el)}
                type="button"
                className="game-column"
                tabIndex={grid.focus === c ? 0 : -1}
                aria-label={label}
                aria-disabled={!canMove || !free}
                onFocus={() => grid.setFocus(c)}
                onKeyDown={(e) => grid.onKeyDown(e, c)}
                onClick={() => canMove && free && onColumn(c)}
              >
                {Array.from({ length: FOUR_UP_ROWS }, (_, r) => {
                  const i = r * FOUR_UP_COLUMNS + c;
                  const v = s.cells[i];
                  return (
                    <span
                      key={r}
                      className={`game-piece game-piece--four_up ${v === null || v === undefined ? 'game-piece--empty' : `game-piece--p${v}`}${line.includes(i) ? ' game-piece--line' : ''}${s.last === i ? ' game-piece--last' : ''}`}
                      // How far the last disc fell, for the drop in the 3D view.
                      style={s.last === i ? ({ '--drop': r + 1 } as CSSProperties) : undefined}
                    />
                  );
                })}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NoughtsBoard({
  game,
  meId,
  canMove,
  describedBy,
  onCell,
}: {
  game: ChatGame;
  meId?: string;
  canMove: boolean;
  describedBy: string;
  onCell: (cell: number) => void;
}) {
  const { t } = useSession();
  const s = game.state as Extract<ChatGame['state'], { kind: 'noughts' }>;
  const grid = useGridKeys(9, 3);
  const line = s.result?.type === 'win' ? (s.result.line ?? []) : [];
  return (
    <div
      role="grid"
      aria-label={t('m.chat.game.board', { game: gameName(t, 'noughts') })}
      aria-describedby={describedBy}
      className="game-board game-board--noughts"
      dir="ltr"
    >
      {[0, 1, 2].map((r) => (
        <div role="row" key={r} className="game-board__row">
          {[0, 1, 2].map((c) => {
            const i = r * 3 + c;
            const v = s.cells[i];
            const state = v === null || v === undefined ? t('m.chat.game.empty') : `${v === 0 ? 'X' : 'O'}, ${nameOf(t, game.players[v], meId)}`;
            return (
              <div role="gridcell" key={c} className="game-board__cell">
                <button
                  ref={(el) => void (grid.refs.current[i] = el)}
                  type="button"
                  className={`game-square${line.includes(i) ? ' game-square--line' : ''}`}
                  tabIndex={grid.focus === i ? 0 : -1}
                  aria-label={`${t('m.chat.game.square', { row: r + 1, col: c + 1 })}, ${state}`}
                  aria-disabled={!canMove || v !== null}
                  onFocus={() => grid.setFocus(i)}
                  onKeyDown={(e) => grid.onKeyDown(e, i)}
                  onClick={() => canMove && v === null && onCell(i)}
                >
                  {v === null || v === undefined ? null : (
                    <span className={`game-mark game-mark--p${v}${s.last === i ? ' game-mark--last' : ''}`} aria-hidden>
                      {v === 0 ? 'X' : 'O'}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function LadderBoard({
  game,
  state: s,
  meId,
  canMove,
  busy,
  problem,
  threeD,
  onMove,
}: {
  game: ChatGame;
  state: WordLadderState;
  meId?: string;
  canMove: boolean;
  busy: boolean;
  problem: string | null;
  /** Rungs as stacked letter tiles. */
  threeD: boolean;
  onMove: (move: GameMove) => void;
}) {
  const { t, tp } = useSession();
  const [word, setWord] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const current = ladderCurrent(s);
  useEffect(() => {
    setWord('');
    setError(null);
  }, [s.rungs.length, s.passes]);
  const shown = error ?? problem;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="chat-game__ends" dir="ltr">
        <span>
          <span className="chat-poll__status">{t('m.chat.game.ladder.from')}</span> <strong>{s.start.toUpperCase()}</strong>
        </span>
        <span aria-hidden>→</span>
        <span>
          <span className="chat-poll__status">{t('m.chat.game.ladder.to')}</span> <strong>{s.target.toUpperCase()}</strong>
        </span>
      </div>
      <p className="chat-poll__status">{tp('m.chat.game.ladder.best', s.best)}</p>
      {threeD ? (
        // The ladder as stacked rungs of letter tiles, the newest nearest; the letter each rung changed stands out.
        <div className="game-view game-view--3d">
          <ol className="ladder-3d" aria-label={t('m.chat.game.ladder.rungs')}>
            {[{ word: s.start, seat: -1 }, ...s.rungs].map((r, i, all) => (
              <li key={i} className={`ladder-3d__rung${i === all.length - 1 && i > 0 ? ' ladder-3d__rung--last' : ''}`}>
                <span className="yp-visually-hidden">{r.word.toUpperCase()}</span>
                <span className="ladder-3d__tiles" dir="ltr" aria-hidden>
                  {[...r.word.toUpperCase()].map((ch, k) => (
                    <span key={k} className={`ladder-3d__tile${i > 0 && all[i - 1]!.word[k] !== r.word[k] ? ' ladder-3d__tile--changed' : ''}`}>
                      {ch}
                    </span>
                  ))}
                </span>
                {r.seat >= 0 ? <bdi className="ladder-3d__who">{nameOf(t, game.players[r.seat], meId)}</bdi> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <ol className="chat-game__rungs" aria-label={t('m.chat.game.ladder.rungs')}>
          <li dir="ltr">
            <strong>{s.start.toUpperCase()}</strong>
          </li>
          {s.rungs.map((r, i) => (
            <li key={i}>
              <strong dir="ltr">{r.word.toUpperCase()}</strong> <bdi className="muted">{nameOf(t, game.players[r.seat], meId)}</bdi>
            </li>
          ))}
        </ol>
      )}
      {canMove || busy ? (
        <form
          className="chat-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const why = checkRung(s, word);
            if (why) return setError(t(`m.chat.game.err.${why}` as MessageKey));
            setError(null);
            onMove({ word });
          }}
        >
          <label htmlFor={inputId} className="yp-visually-hidden">
            {t('m.chat.game.ladder.next')}
          </label>
          <input
            id={inputId}
            className="chat-inline-form__input"
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={4}
            placeholder={t('m.chat.game.ladder.hint', { word: current.toUpperCase() })}
            aria-invalid={!!shown}
            aria-describedby={shown ? `${inputId}-error` : `${inputId}-hint`}
            value={word}
            onChange={(e) => {
              setWord(e.currentTarget.value);
              setError(null);
            }}
          />
          <Button size="sm" type="submit" disabled={!word.trim() || busy}>
            {t('m.chat.game.ladder.add')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMove({ pass: true })}>
            {t('m.chat.game.ladder.pass')}
          </Button>
        </form>
      ) : null}
      {shown ? (
        <p className="yp-field__error" role="alert" id={`${inputId}-error`}>
          {shown}
        </p>
      ) : canMove ? (
        <p className="chat-poll__status" id={`${inputId}-hint`}>
          {t('m.chat.game.ladder.hint', { word: current.toUpperCase() })} {t('m.chat.game.ladder.passNote')}
        </p>
      ) : null}
    </div>
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
  const { t, tp, toast } = useSession();
  const [kind, setKind] = useState<GameKind>('four_up');
  const [going, setGoing] = useState<ChatGame[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [color, setColor] = useState<'white' | 'black' | 'random'>('white');
  const [busy, setBusy] = useState(false);
  const cid = conversation?.id;
  useEffect(() => {
    if (!open || !cid) return;
    setChosen([]);
    api.conversations.games(cid).then(
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
    setBusy(true);
    try {
      const { message } = await api.conversations.startGame(cid, {
        kind,
        playerIds: group ? chosen : [],
        ...(kind === 'chess' ? { color } : {}),
        clientId: crypto.randomUUID(),
      });
      onSent(message);
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.chat.game.start')}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {going.length ? (
          // The games going here, each with who plays and whose turn it is, and a way straight to its board.
          <section className="stack" style={{ gap: 8 }} aria-labelledby="game-going-title">
            <h3 id="game-going-title" className="yp-field__label" style={{ margin: 0 }}>
              {t('m.chat.game.goingHere')}
            </h3>
            <ul className="chat-game-going">
              {going.map((g) => {
                const names = g.players.map((p) => nameOf(t, p, meId)).join(', ');
                return (
                  <li key={g.id} className="chat-game-option chat-game-option--going">
                    <span className="stack" style={{ gap: 2, flex: 1, minInlineSize: 0 }}>
                      <strong>{gameName(t, g.kind)}</strong>
                      <span className="chat-poll__status">
                        <bdi>{names}</bdi>
                      </span>
                      <span className={`chat-poll__status${g.turnId === meId ? ' chat-game-going__turn' : ''}`}>{gameStatus(t, g, meId)}</span>
                    </span>
                    {onOpenGame ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="game"
                        aria-label={`${t('m.chat.game.open')}: ${gameName(t, g.kind)}, ${names}`}
                        onClick={() => {
                          onClose();
                          onOpenGame(g);
                        }}
                      >
                        {t('m.chat.game.open')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {full ? (
          <p className="chat-poll__status" role="note" style={{ margin: 0 }}>
            {t('m.chat.game.allFull', { count: GAME_ACTIVE_LIMIT })}
          </p>
        ) : (
          <fieldset className="chat-radio">
            <legend className="yp-field__label">{going.length ? t('m.chat.game.startNew') : t('m.chat.game.choose')}</legend>
            <div className="stack" style={{ gap: 8 }}>
              {GAME_KINDS.map((k) => {
                const here = kinds.filter((x) => x === k).length;
                const blocked = !!gameStartBlock(kinds, k);
                return (
                  <label key={k} className={`chat-game-option${kind === k ? ' chat-game-option--on' : ''}`}>
                    <input
                      type="radio"
                      name="game-kind"
                      value={k}
                      checked={kind === k}
                      disabled={blocked}
                      onChange={() => {
                        setKind(k);
                        setChosen((cur) => (GAME_PLAYERS[k].max === 2 ? cur.slice(0, 1) : cur));
                      }}
                    />
                    <span className="stack" style={{ gap: 2 }}>
                      <strong>{gameName(t, k)}</strong>
                      <span className="chat-poll__status">
                        {blocked
                          ? t('m.chat.game.kindFull', { count: GAME_KIND_ACTIVE_LIMIT, game: gameName(t, k) })
                          : t(`m.chat.game.about.${k}` as MessageKey)}
                      </span>
                      {here && !blocked ? <span className="chat-poll__status">{tp('m.chat.game.nGoing', here)}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {kind === 'chess' && !full ? (
          <fieldset className="chat-radio">
            <legend className="yp-field__label">{t('m.chat.game.chess.colour')}</legend>
            <div className="stack" style={{ gap: 4 }}>
              {(['white', 'black', 'random'] as const).map((c) => (
                <label key={c} className="chat-game-person">
                  <input type="radio" name="game-colour" value={c} checked={color === c} onChange={() => setColor(c)} />
                  <span>
                    {c === 'random' ? null : (
                      <span className={`chess-piece chess-piece--${c === 'white' ? 'w' : 'b'} chess-legend`} aria-hidden>
                        {CHESS_GLYPHS[c === 'white' ? 'w' : 'b'].k}
                      </span>
                    )}{' '}
                    {t(c === 'white' ? 'm.chat.game.chess.asWhite' : c === 'black' ? 'm.chat.game.chess.asBlack' : 'm.chat.game.chess.asRandom')}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {group && !full ? (
          <fieldset className="chat-radio">
            <legend className="yp-field__label">{t('m.chat.game.players')}</legend>
            <p className="chat-poll__status" style={{ marginBlock: '0 6px' }}>
              {single ? t('m.chat.game.pickOne') : t('m.chat.game.pickUpTo', { count: max })}
            </p>
            <div className="stack" style={{ gap: 4 }}>
              {others.map((p) => {
                const on = chosen.includes(p.id);
                return (
                  <label key={p.id} className="chat-game-person">
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name="game-players"
                      checked={on}
                      disabled={!single && !on && chosen.length >= max}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setChosen((cur) => (single ? [p.id] : checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)));
                      }}
                    />
                    <bdi>{p.displayName}</bdi>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            {full ? t('m.common.close') : t('m.chat.cancel')}
          </Button>
          {full ? null : (
            <Button type="submit" icon="game" loading={busy} disabled={!ready}>
              {t('m.chat.game.startButton')}
            </Button>
          )}
        </div>
      </form>
    </BottomSheet>
  );
}
