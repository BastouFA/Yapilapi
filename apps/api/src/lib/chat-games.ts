import type { Pool, PoolClient } from 'pg';
import {
  forfeit,
  GAME_IDLE_HOURS,
  timeOut,
  winnerSeat,
  type ChatGame,
  type GameKind,
  type GameState,
  type Message,
  type MessageSystemInfo,
  type PublicUser,
} from '@yapilapi/shared';
import { tx } from '@yapilapi/database';
import { readersOf } from './chat-polls.ts';
import { enqueue } from './jobs.ts';
import type { RealtimeHub } from './realtime.ts';
import { usersByIds } from './users.ts';

type Q = Pool | PoolClient;

/**
 * Games in chats (see migration 0046): what each member sees, the live updates, the line in the
 * chat when a game ends, and ending games nobody touched for a day. The rules themselves are the
 * shared, pure functions in packages/shared/src/games. Used by modules/chat-games.ts and the job worker.
 */
export interface ChatGameDeps {
  db: Pool;
  realtime: RealtimeHub;
}

/** Queued after each move for a day later; ends the game unfinished if nothing moved since. */
export const GAME_IDLE_JOB = 'chat.game.idle';

export interface GameRow {
  id: string;
  message_id: string;
  conversation_id: string;
  kind: GameKind;
  created_by: string;
  players: string[];
  state: GameState;
  move_number: number;
  status: ChatGame['status'];
  winner_id: string | null;
  last_move_at: Date;
  ended_at: Date | null;
  created_at: Date;
  rematch_id: string | null;
}

export const GAME_COLS = `g.id, g.message_id, g.conversation_id, g.kind, g.created_by, g.players, g.state, g.move_number, g.status, g.winner_id,
  g.last_move_at, g.ended_at, g.created_at, (SELECT r.id FROM chat_games r WHERE r.rematch_of = g.id) AS rematch_id`;

/** Games as the apps get them, with their players and the chat's tally of wins at each game. */
export async function presentGames(db: Q, rows: GameRow[]): Promise<ChatGame[]> {
  if (!rows.length) return [];
  const users = await usersByIds(db, [...new Set(rows.flatMap((r) => r.players))]);
  const { rows: wins } = await db.query<{ conversation_id: string; kind: string; winner_id: string; wins: number }>(
    `SELECT conversation_id, kind, winner_id, count(*)::int AS wins FROM chat_games
     WHERE status = 'won' AND winner_id IS NOT NULL AND conversation_id = ANY($1::uuid[])
     GROUP BY conversation_id, kind, winner_id`,
    [[...new Set(rows.map((r) => r.conversation_id))]],
  );
  const tally = new Map(wins.map((w) => [`${w.conversation_id}:${w.kind}:${w.winner_id}`, w.wins]));
  // Someone whose account is gone still holds their seat.
  const gone = (id: string): PublicUser => ({ id, username: '', displayName: '', avatarUrl: null, mode: 'personal' });
  return rows.map((r) => {
    const active = r.status === 'active';
    return {
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      kind: r.kind,
      players: r.players.map((id) => users.get(id) ?? gone(id)),
      state: r.state,
      moveNumber: r.move_number,
      status: r.status,
      winnerId: r.winner_id,
      turnId: active ? (r.players[r.state.turn] ?? null) : null,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      lastMoveAt: r.last_move_at.toISOString(),
      idleEndsAt: active ? new Date(r.last_move_at.getTime() + GAME_IDLE_HOURS * 3_600_000).toISOString() : null,
      endedAt: r.ended_at ? r.ended_at.toISOString() : null,
      rematchId: r.rematch_id,
      tally: r.players.map((id) => ({ userId: id, wins: tally.get(`${r.conversation_id}:${r.kind}:${id}`) ?? 0 })),
    };
  });
}

/** The games on these messages (by message id). Everyone in the chat sees a game the same way. */
export async function gamesFor(db: Q, messageIds: string[]): Promise<Map<string, ChatGame>> {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.query<GameRow>(`SELECT ${GAME_COLS} FROM chat_games g WHERE g.message_id = ANY($1::uuid[])`, [ids]);
  return new Map((await presentGames(db, rows)).map((g) => [g.messageId, g]));
}

export async function gameById(db: Q, id: string): Promise<ChatGame | null> {
  const { rows } = await db.query<GameRow>(`SELECT ${GAME_COLS} FROM chat_games g WHERE g.id = $1`, [id]);
  return (await presentGames(db, rows))[0] ?? null;
}

/** Queue the check that ends a game after a day without a move (it does nothing if someone moved). */
export async function scheduleIdleEnd(c: Q, gameId: string, moveNumber: number): Promise<void> {
  // A few seconds late, so the game is surely a day old by the database's clock when it runs.
  await enqueue(c, GAME_IDLE_JOB, { gameId, moveNumber }, GAME_IDLE_HOURS * 3600 + 5);
}

/**
 * The line in the chat when a game ends: "Ada won Four up", "Noughts ended in a draw", "Chess ended in a
 * draw by stalemate" (a chess draw carries its reason). Its sender
 * is the winner, or (draw, unfinished) whoever moved last. It follows the chat's disappearing setting
 * like any new message. Returns the line's id, or null when the game is still going.
 */
export async function insertEndLine(
  c: PoolClient,
  game: Pick<GameRow, 'id' | 'conversation_id' | 'kind' | 'players' | 'created_by'>,
  state: GameState,
  lastMover: string | null,
): Promise<string | null> {
  const result = state.result;
  if (!result) return null;
  const winner = result.type === 'win' ? game.players[result.winner] : undefined;
  const sender = winner ?? lastMover ?? game.created_by;
  const meta: MessageSystemInfo =
    result.type === 'win'
      ? { type: 'game', gameId: game.id, kind: game.kind, outcome: 'won', by: result.by }
      : result.type === 'draw'
        ? { type: 'game', gameId: game.id, kind: game.kind, outcome: 'draw', ...(result.reason ? { reason: result.reason } : {}) }
        : { type: 'game', gameId: game.id, kind: game.kind, outcome: 'unfinished' };
  const seconds: number | null =
    (await c.query(`SELECT disappearing_seconds FROM conversations WHERE id = $1`, [game.conversation_id])).rows[0]?.disappearing_seconds ?? null;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, sender_id, body, kind, meta, expires_at)
     VALUES ($1,$2,'','system',$3, now() + make_interval(secs => $4::int)) RETURNING id`,
    [game.conversation_id, sender, meta, seconds],
  );
  const id = rows[0]!.id;
  if (seconds) await enqueue(c, 'messages.expire', { messageId: id }, seconds + 1);
  await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [game.conversation_id]);
  return id;
}

/** Send a game-end line to everyone in the chat who sees its sender. */
export async function publishLine(deps: ChatGameDeps, lineId: string): Promise<void> {
  const r = (
    await deps.db.query(`SELECT id, conversation_id, sender_id, meta, created_at, expires_at FROM messages WHERE id = $1 AND deleted_at IS NULL`, [lineId])
  ).rows[0];
  if (!r) return;
  const sender = (await usersByIds(deps.db, [r.sender_id])).get(r.sender_id);
  if (!sender) return;
  const message: Message = {
    id: r.id,
    conversationId: r.conversation_id,
    sender,
    body: '',
    replyToId: null,
    attachments: [],
    createdAt: r.created_at.toISOString(),
    kind: 'system',
    system: r.meta,
    ...(r.expires_at ? { expiresAt: r.expires_at.toISOString() } : {}),
  };
  await deps.realtime.publish(await readersOf(deps.db, r.conversation_id, r.sender_id), { type: 'message.created', data: message });
}

/**
 * `game.updated` to everyone in the chat who sees the game's card (members who haven't blocked
 * the person who started it). Nothing is pushed to phones: games are quiet.
 */
export async function publishGame(deps: ChatGameDeps, gameId: string): Promise<ChatGame | null> {
  const game = await gameById(deps.db, gameId);
  if (!game) return null;
  const live = await deps.db.query(`SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [
    game.messageId,
  ]);
  if (!live.rowCount) return game;
  await deps.realtime.publish(await readersOf(deps.db, game.conversationId, game.createdBy), {
    type: 'game.updated',
    data: { id: game.messageId, conversationId: game.conversationId, game },
  });
  return game;
}

/**
 * End a game nobody moved in for a day: it's marked unfinished, a line says so, and everyone's
 * board updates. Does nothing if a move came since (`moveNumber` changed) or the game ended.
 */
export async function endIdleGame(deps: ChatGameDeps, gameId: string, moveNumber: number): Promise<boolean> {
  const line = await tx(deps.db, async (c) => {
    const g = (
      await c.query<GameRow>(
        `SELECT ${GAME_COLS} FROM chat_games g
         WHERE g.id = $1 AND g.status = 'active' AND g.move_number = $2 AND g.last_move_at <= now() - make_interval(hours => $3)
         FOR UPDATE`,
        [gameId, moveNumber, GAME_IDLE_HOURS],
      )
    ).rows[0];
    if (!g) return undefined;
    const state = timeOut(g.state);
    await c.query(`UPDATE chat_games SET state = $2, status = 'unfinished', ended_at = now() WHERE id = $1`, [g.id, state]);
    const last = (await c.query<{ player_id: string | null }>(`SELECT player_id FROM chat_game_moves WHERE game_id = $1 ORDER BY number DESC LIMIT 1`, [g.id]))
      .rows[0]?.player_id;
    return insertEndLine(c, g, state, last ?? null);
  });
  if (line === undefined) return false;
  await publishGame(deps, gameId);
  if (line) await publishLine(deps, line);
  return true;
}

/** Save a new state after a move (or a forfeit), and the line in the chat if it ended the game. */
export async function saveGameMove(c: PoolClient, g: GameRow, userId: string, state: GameState, move: object, clientMoveId: string | null) {
  const number = g.move_number + 1;
  await c.query(`INSERT INTO chat_game_moves (game_id, number, player_id, move, client_move_id) VALUES ($1,$2,$3,$4,$5)`, [
    g.id,
    number,
    userId,
    move,
    clientMoveId,
  ]);
  const seat = winnerSeat(state);
  const status = !state.result ? 'active' : state.result.type === 'win' ? 'won' : state.result.type === 'draw' ? 'draw' : 'unfinished';
  await c.query(
    `UPDATE chat_games SET state = $2, move_number = $3, status = $4, winner_id = $5, last_move_at = now(), ended_at = CASE WHEN $4 = 'active' THEN NULL ELSE now() END
     WHERE id = $1`,
    [g.id, state, number, status, seat === null ? null : g.players[seat]],
  );
  if (status === 'active') await scheduleIdleEnd(c, g.id, number);
  return insertEndLine(c, g, state, userId);
}

/**
 * Someone left the chat (or was removed): they forfeit the games they're playing in it, as if they
 * had pressed Forfeit, so nobody waits a day on a player who has gone.
 */
export async function forfeitGamesOnLeave(deps: ChatGameDeps, conversationId: string, userId: string): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM chat_games WHERE conversation_id = $1 AND status = 'active' AND $2::uuid = ANY(players)`,
    [conversationId, userId],
  );
  for (const { id } of rows) {
    const line = await tx(deps.db, async (c) => {
      const g = (await c.query<GameRow>(`SELECT ${GAME_COLS} FROM chat_games g WHERE g.id = $1 AND g.status = 'active' FOR UPDATE`, [id])).rows[0];
      const seat = g ? g.players.indexOf(userId) : -1;
      if (!g || seat < 0) return undefined;
      const r = forfeit(g.state, seat);
      if (!r.ok) return undefined;
      return saveGameMove(c, g, userId, r.state, { forfeit: true }, null);
    });
    if (line === undefined) continue;
    await publishGame(deps, id);
    if (line) await publishLine(deps, line);
  }
}

export function chatGameJobHandlers(deps: ChatGameDeps) {
  return {
    [GAME_IDLE_JOB]: async (payload: { gameId: string; moveNumber: number }) => {
      await endIdleGame(deps, payload.gameId, payload.moveNumber);
    },
  };
}
