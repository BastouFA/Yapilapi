'use client';

import { Button, Icon } from '@yapilapi/design-system';
import {
  chessColorSeat,
  chessLastMoveText,
  chessStatusText,
  FOUR_UP_COLUMNS,
  ladderCurrent,
  type ChatGame,
  type GameKind,
  type GameState,
  type Message,
  type MessageKey,
  type PublicUser,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { MiniChess } from './ChessBoard';

/**
 * Games in a chat (web): the card in the message list, and the words for a game's state. The board
 * in a sheet and the sheet to start one are in ChatGameSheets.tsx, which the chat loads when one
 * opens.
 */

type T = ReturnType<typeof useSession>['t'];

export const gameName = (t: T, kind: GameKind) => t(`m.chat.game.kind.${kind}` as MessageKey);

export const nameOf = (t: T, u: PublicUser | undefined, meId?: string) =>
  !u ? t('m.calls.someone') : u.id === meId ? t('m.chat.you') : u.displayName || t('m.calls.someone');

/** The players' names by seat, as you see them ("You" for yourself). */
export const namesOf = (t: T, game: ChatGame, meId?: string) => game.players.map((p) => nameOf(t, p, meId));

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
export function lastMoveText(t: T, game: ChatGame, meId?: string): string {
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
export function tallyText(t: T, game: ChatGame, meId?: string) {
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
      {/* Clicking the picture opens the game too; keyboards and screen readers use the button below. */}
      <div className="chat-game__preview" aria-hidden onClick={onOpen}>
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
